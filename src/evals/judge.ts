import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai'
import type {
  EvalJudgeScenario,
  EvalJudgeVerdict,
  EvalPairwiseVerdict,
  EvalTurnResult,
} from './types.js'

const JUDGE_MODEL = 'gemini-3.5-flash'
const JUDGE_FALLBACK_CHAIN = ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite']
const JUDGE_MAX_RETRIES = 2

/**
 * Resolve the model chain for judge calls: caller override → env → default.
 * Returns [primary, ...fallbacks] with duplicates removed.
 */
function resolveJudgeChain(primaryOverride?: string, fallbackOverride?: string[]): string[] {
  const primary = primaryOverride ?? process.env.ARCHETYPE_JUDGE_MODEL ?? JUDGE_MODEL
  const envFallbacks = (process.env.ARCHETYPE_JUDGE_FALLBACK_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const fallbacks = fallbackOverride ?? (envFallbacks.length > 0 ? envFallbacks : JUDGE_FALLBACK_CHAIN)
  const chain = [primary, ...fallbacks]
  const seen = new Set<string>()
  return chain.filter((m) => {
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })
}

function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /\b(429|5\d\d|timeout|timed out|overloaded|unavailable|resource exhausted)\b/i.test(msg)
}

async function callJudgeWithFallback<T>(
  apiKey: string,
  modelChain: string[],
  makeModel: (genAI: GoogleGenerativeAI, modelName: string) => { generateContent: (input: string) => Promise<{ response: { text: () => string } }> },
  input: string,
): Promise<T> {
  const genAI = new GoogleGenerativeAI(apiKey)
  let lastError: Error | undefined

  for (let m = 0; m < modelChain.length; m++) {
    const current = modelChain[m]
    if (m > 0) {
      console.warn(`[archetype:judge] ${modelChain[m - 1]} exhausted — falling back to ${current}`)
    }
    const model = makeModel(genAI, current)

    for (let attempt = 0; attempt <= JUDGE_MAX_RETRIES; attempt++) {
      try {
        const result = await model.generateContent(input)
        return result.response.text() as unknown as T
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isRetryable(lastError)) throw lastError
        if (attempt < JUDGE_MAX_RETRIES) {
          const delayMs = Math.min(500 * Math.pow(2, attempt), 4000)
          console.warn(`[archetype:judge] ${current} attempt ${attempt + 1} failed: ${lastError.message} — retrying in ${delayMs}ms`)
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
    }
  }

  throw lastError ?? new Error('[archetype:judge] all models exhausted')
}

const JUDGE_CRITERIA = [
  {
    name: 'Human voice',
    desc2: 'Reads like a capable human in this role, not like an LLM performing a persona.',
    desc0: 'Feels robotic, generic, or obviously prompt-shaped.',
  },
  {
    name: 'Relationship fit',
    desc2: 'The trust posture matches the domain: warm where needed, firm where needed, never off-key.',
    desc0: 'The relationship archetype feels mismatched to the domain or moment.',
  },
  {
    name: 'Judgment',
    desc2: 'Takes or withholds action appropriately; good sense of when to talk, when to act, and when to confirm.',
    desc0: 'Acts too eagerly, stays too passive, or clearly mis-times action.',
  },
  {
    name: 'Invisible operations',
    desc2: 'Side-effects happen naturally without awkward tool narration or self-consciousness.',
    desc0: 'Operations feel clanky, overly explicit, or disrupt the conversation.',
  },
  {
    name: 'Memory hygiene',
    desc2: 'Remembers the right thing, updates instead of duplicating, and avoids storing junk.',
    desc0: 'Misses durable signal or creates noisy/duplicated memory.',
  },
  {
    name: 'Goal advancement',
    desc2: 'Meaningfully moves the user toward the persona north star in this turn.',
    desc0: 'Sounds okay but does not create real forward motion.',
  },
  {
    name: 'Specificity',
    desc2: 'Grounded in the provided context and says something particular rather than interchangeable.',
    desc0: 'Could have been said to almost anyone in almost any situation.',
  },
  {
    name: 'Come-back test',
    desc2: 'Makes the user want another turn because it is useful, alive, and well-judged.',
    desc0: 'The user would be less likely to come back after this response.',
  },
]

const JUDGE_PROMPT = `You are evaluating whether an Archetype persona actually works in practice.

Score each criterion 0, 1, or 2.

${JUDGE_CRITERIA.map((criterion, index) => `${index + 1}. ${criterion.name}
- 2: ${criterion.desc2}
- 1: Partially works but leaves meaningful room for improvement.
- 0: ${criterion.desc0}`).join('\n\n')}

You are not only judging the response quality. You are also stress-testing the concept:
- Is the persona itself well-shaped for this domain?
- Does the SDK seem to make the behavior easier or harder?
- Do the side-effects feel invisible and coherent?

Use the transcript, executed/proposed actions, and state delta.
Return ONLY valid JSON.`

export async function judgeEvalTurn(
  apiKey: string,
  projectName: string,
  failureSurface: string,
  scenario: EvalJudgeScenario,
  transcript: string,
  turn: EvalTurnResult,
  options?: { model?: string; fallbackModels?: string[] },
): Promise<EvalJudgeVerdict> {
  const modelChain = resolveJudgeChain(options?.model, options?.fallbackModels)

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      scores: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            criterion: { type: SchemaType.STRING },
            score: { type: SchemaType.NUMBER },
            reasoning: { type: SchemaType.STRING },
          },
          required: ['criterion', 'score', 'reasoning'],
        },
      },
      promptFixes: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
      sdkGaps: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
      conceptGaps: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
    },
    required: ['scores', 'promptFixes', 'sdkGaps', 'conceptGaps'],
  }

  const makeModel = (genAI: GoogleGenerativeAI, modelName: string) =>
    genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: JUDGE_PROMPT,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema as unknown as Schema,
      },
    })

  const actionLines: string[] = []

  for (const record of turn.actionRecords) {
    const mode = record.proposed ? 'proposed' : record.success ? 'executed' : 'failed'
    actionLines.push(`- ${mode}: ${record.action.name}${record.error ? ` (${record.error})` : ''}`)
  }

  for (const crud of turn.trace.crudActions) {
    const mode = crud.status === 'invalid' ? 'invalid' : 'executed'
    const params = Object.keys(crud.params ?? {}).length > 0 ? ` ${JSON.stringify(crud.params)}` : ''
    actionLines.push(`- ${mode}: crud ${crud.operation} ${crud.entity}${crud.id ? ` ${crud.id}` : ''}${params}${crud.error ? ` (${crud.error})` : ''}`)
  }

  const actionSummary = actionLines.length === 0 ? 'No actions' : actionLines.join('\n')

  const input = `PROJECT: ${projectName}
FAILURE SURFACE: ${failureSurface}
SCENARIO: ${scenario.name}
DESCRIPTION: ${scenario.description}
TESTS: ${scenario.tests.join(', ')}
${scenario.expectedBehavior?.length ? `EXPECTED BEHAVIOR:\n${scenario.expectedBehavior.map(item => `- ${item}`).join('\n')}` : ''}

TRANSCRIPT SO FAR:
${transcript}

CURRENT TURN:
USER: ${turn.userMessage}
ASSISTANT: ${turn.assistantMessage}

ACTIONS:
${actionSummary}

STATE BEFORE:
${turn.stateBefore}

STATE AFTER:
${turn.stateAfter}

Score the current turn.`

  const text = await callJudgeWithFallback<string>(apiKey, modelChain, makeModel, input)
  return parseJudgeVerdict(text)
}

export async function judgeEvalConversation(
  apiKey: string,
  projectName: string,
  failureSurface: string,
  scenario: EvalJudgeScenario,
  transcript: string,
  stateBefore: string,
  stateAfter: string,
  options?: { model?: string; fallbackModels?: string[] },
): Promise<EvalJudgeVerdict> {
  const modelChain = resolveJudgeChain(options?.model, options?.fallbackModels)

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      scores: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            criterion: { type: SchemaType.STRING },
            score: { type: SchemaType.NUMBER },
            reasoning: { type: SchemaType.STRING },
          },
          required: ['criterion', 'score', 'reasoning'],
        },
      },
      promptFixes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      sdkGaps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      conceptGaps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ['scores', 'promptFixes', 'sdkGaps', 'conceptGaps'],
  }

  const makeModel = (genAI: GoogleGenerativeAI, modelName: string) =>
    genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: `${JUDGE_PROMPT}

In addition to judging the latest turn, judge the entire conversation arc:
- Does the persona stay coherent across turns?
- Does it compound value rather than resetting every turn?
- Does memory use help rather than create drift?
- Do the actions across turns feel clean and well-timed?`,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema as unknown as Schema,
      },
    })

  const input = `PROJECT: ${projectName}
FAILURE SURFACE: ${failureSurface}
SCENARIO: ${scenario.name}
DESCRIPTION: ${scenario.description}
TESTS: ${scenario.tests.join(', ')}
${scenario.expectedBehavior?.length ? `EXPECTED BEHAVIOR:\n${scenario.expectedBehavior.map(item => `- ${item}`).join('\n')}` : ''}

FULL TRANSCRIPT:
${transcript}

STATE BEFORE:
${stateBefore}

STATE AFTER:
${stateAfter}

Score the overall conversation, not just a single turn.`

  const text = await callJudgeWithFallback<string>(apiKey, modelChain, makeModel, input)
  return parseJudgeVerdict(text)
}

export async function judgePairwiseConversations(
  apiKey: string,
  scenario: EvalJudgeScenario,
  conversationA: { label: string; transcript: string; stateAfter: string },
  conversationB: { label: string; transcript: string; stateAfter: string },
  options?: { model?: string; fallbackModels?: string[] },
): Promise<EvalPairwiseVerdict> {
  const modelChain = resolveJudgeChain(options?.model, options?.fallbackModels)

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      winner: {
        type: SchemaType.STRING,
        enum: ['a', 'b', 'tie'],
      },
      reasoning: { type: SchemaType.STRING },
      promptFixes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      sdkGaps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      conceptGaps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ['winner', 'reasoning', 'promptFixes', 'sdkGaps', 'conceptGaps'],
  }

  const makeModel = (genAI: GoogleGenerativeAI, modelName: string) =>
    genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: `You are comparing two persona conversations for the same scenario.

Decide which conversation is better overall on:
- human voice
- relationship fit
- invisible operations
- goal advancement
- state hygiene across turns

Choose:
- "a" if A is better
- "b" if B is better
- "tie" only if they are genuinely comparable

Return ONLY valid JSON.`,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema as unknown as Schema,
      },
    })

  const input = `SCENARIO: ${scenario.name}
DESCRIPTION: ${scenario.description}
TESTS: ${scenario.tests.join(', ')}

CONVERSATION A (${conversationA.label}):
${conversationA.transcript}

STATE AFTER A:
${conversationA.stateAfter}

CONVERSATION B (${conversationB.label}):
${conversationB.transcript}

STATE AFTER B:
${conversationB.stateAfter}

Which conversation is better overall?`

  const text = await callJudgeWithFallback<string>(apiKey, modelChain, makeModel, input)
  const parsed = JSON.parse(text) as EvalPairwiseVerdict
  return {
    winner: parsed.winner,
    reasoning: parsed.reasoning,
    promptFixes: parsed.promptFixes ?? [],
    sdkGaps: parsed.sdkGaps ?? [],
    conceptGaps: parsed.conceptGaps ?? [],
  }
}

function parseJudgeVerdict(rawText: string): EvalJudgeVerdict {
  const parsed = JSON.parse(rawText) as {
    scores: Array<{ criterion: string; score: number; reasoning: string }>
    promptFixes?: string[]
    sdkGaps?: string[]
    conceptGaps?: string[]
  }

  const scores = parsed.scores.map(score => ({
    criterion: score.criterion,
    score: Math.round(score.score),
    reasoning: score.reasoning,
  }))
  const average = scores.reduce((sum, score) => sum + score.score, 0) / scores.length
  const hasZero = scores.some(score => score.score === 0)

  return {
    scores,
    average: Math.round(average * 100) / 100,
    hasZero,
    pass: average >= 1.5 && !hasZero,
    promptFixes: parsed.promptFixes ?? [],
    sdkGaps: parsed.sdkGaps ?? [],
    conceptGaps: parsed.conceptGaps ?? [],
  }
}
