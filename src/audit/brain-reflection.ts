/**
 * Brain self-reflection audit — the most scenario-first audit mode.
 *
 * The other audits analyze the prompt from the outside:
 *  - Structural audits pattern-match against known shapes.
 *  - LLM reviewer is an external expert reading the prompt.
 *
 * This audit analyzes the prompt from the INSIDE. It runs the actual
 * persona — same model, same system instruction it would operate under —
 * and asks it to self-reflect on its own operating instructions. The
 * persona is the domain expert; scenario-first says we should trust it.
 * So we ask it directly where the prompt constrains its judgment.
 *
 * Why this can catch what external audits miss:
 *  - Domain-aware: the persona knows what's natural in its domain, so it
 *    can spot prescriptions an external reviewer would call "reasonable."
 *  - Model-specific: the same model that will ship in production does the
 *    reflection, so it surfaces the actual confusions that model has,
 *    not hypothetical ones.
 *  - Experiential: "I would have figured that out" is a more reliable
 *    signal of doing-experts-thinking than pattern matching on verbs.
 */
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai'
import { buildSystemPrompt } from '../core/prompt-builder.js'
import { resolveActions } from '../core/effective-config.js'
import { configVersion } from './version.js'
import type { PersonaConfig, Memory } from '../types.js'

export interface BrainReflectionInput {
  apiKey: string
  config: PersonaConfig
  context?: Record<string, unknown>
  memories?: Memory[]
  /** Primary model. Default: gemini-3.5-flash (stable). */
  model?: string
  /** Optional fallback model chain. */
  fallbackModels?: string[]
  /** Temperature for reflection. Default: 0.3 — we want a careful read, not creativity. */
  temperature?: number
}

export interface BrainReflectionFinding {
  /** Which failure mode the persona flagged. */
  category: 'boxed' | 'underspecified' | 'contradicted' | 'misses-point' | 'redundant'
  /** The specific line/phrase from the prompt the persona is reacting to. */
  quotedText: string
  /** In the persona's own voice: what it felt reading this. */
  howItFeels: string
  /** Concrete suggestion from the persona's point of view. */
  whatIdWantInstead: string
}

export interface BrainReflectionResult {
  configVersion: string
  findings: BrainReflectionFinding[]
  /** Persona's one-paragraph self-assessment of the overall prompt. */
  selfAssessment: string
  /** The actual model that responded (after fallbacks). */
  modelUsed: string
}

const REFLECTION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    findings: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          category: {
            type: SchemaType.STRING,
            enum: ['boxed', 'underspecified', 'contradicted', 'misses-point', 'redundant'],
          },
          quotedText: { type: SchemaType.STRING },
          howItFeels: { type: SchemaType.STRING },
          whatIdWantInstead: { type: SchemaType.STRING },
        },
        required: ['category', 'quotedText', 'howItFeels', 'whatIdWantInstead'],
      },
    },
    selfAssessment: { type: SchemaType.STRING },
  },
  required: ['findings', 'selfAssessment'],
}

const REFLECTION_QUESTION = `Before we start operating together, I want you to do a careful read of the system instructions above — not as a user question, but as a self-check on what you've been told.

I'm asking because I want to help you do your job well. If the instructions constrain your judgment when you'd rather use it, or leave you guessing, or fight themselves, that's something I need to know and fix.

Walk through the prompt honestly and tell me:

- **boxed** — places where the instructions tell you what to do or say in a specific situation, when you would have reached the right move on your own from your expertise and the scenario in front of you. Prescriptions where standards would suffice.

- **underspecified** — places that are vague enough that two capable practitioners could reasonably read them differently. Instructions where you'd have to guess at the intent.

- **contradicted** — two parts of the prompt that pull you in different directions. Where you'd find yourself balancing one rule against another instead of responding to the situation.

- **misses-point** — instructions that correct mistakes you wouldn't make, or prescribe behavior you'd naturally produce without being told. Coaching for a mediocre employee when you're a capable practitioner.

- **redundant** — information that appears multiple times across the prompt, or information already carried by the schema/context/memory config such that restating it in prose adds noise.

For each, quote the specific text, say how it feels from inside the role, and suggest what you'd want instead — a more standards-shaped version, a reframed field description, or outright deletion.

Also give me a short self-assessment of the overall prompt health.

Be honest. This isn't a test — you can't fail by pointing things out. The only failure mode is politeness that hides real constraints. Return valid JSON only.`

function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /\b(429|5\d\d|timeout|timed out|overloaded|unavailable|resource exhausted)\b/i.test(msg)
}

export async function auditByBrainReflection(input: BrainReflectionInput): Promise<BrainReflectionResult> {
  const { apiKey, config, context, memories } = input
  const primary = input.model ?? 'gemini-3.5-flash'
  const fallbacks = input.fallbackModels ?? ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite']
  const temperature = input.temperature ?? 0.3
  const seen = new Set<string>()
  const modelChain = [primary, ...fallbacks].filter((m) => {
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })
  const maxRetries = 2

  // Build the ACTUAL prompt the persona would operate under. The reflection
  // is its reading of this prompt, from its own role.
  const effectiveActions = resolveActions(config)
  const effectiveConfig = effectiveActions !== config.actions
    ? { ...config, actions: effectiveActions }
    : config
  const assembledPrompt = buildSystemPrompt({
    config: effectiveConfig,
    input: {
      message: '(self-reflection)',
      context: context ?? {},
      memories: memories ?? [],
      timezone: 'UTC',
    },
  })

  const genAI = new GoogleGenerativeAI(apiKey)

  let lastError: Error | undefined
  for (let m = 0; m < modelChain.length; m++) {
    const current = modelChain[m]
    if (m > 0) {
      console.warn(`[archetype:reflect] ${modelChain[m - 1]} exhausted — falling back to ${current}`)
    }

    // Put the assembled prompt in systemInstruction so the model enters the
    // persona exactly as it would in production, then ask the reflection
    // question as a user message.
    const model = genAI.getGenerativeModel({
      model: current,
      systemInstruction: assembledPrompt,
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: REFLECTION_SCHEMA as unknown as Schema,
      },
    })

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(REFLECTION_QUESTION)
        const text = result.response.text()
        const parsed = JSON.parse(text) as {
          findings: BrainReflectionFinding[]
          selfAssessment: string
        }
        return {
          configVersion: configVersion(config),
          findings: parsed.findings ?? [],
          selfAssessment: parsed.selfAssessment ?? '',
          modelUsed: current,
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isRetryable(lastError)) throw lastError
        if (attempt < maxRetries) {
          const delayMs = Math.min(500 * Math.pow(2, attempt), 4000)
          console.warn(`[archetype:reflect] ${current} attempt ${attempt + 1} failed: ${lastError.message} — retrying in ${delayMs}ms`)
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
    }
  }

  throw lastError ?? new Error('[archetype:reflect] all models exhausted')
}
