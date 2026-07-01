/**
 * Prompt Audit — Archetype's meta judge for keystone principle violations.
 *
 * The persona is the domain expert. Archetype is the prompt-engineering expert.
 * This judge reviews the assembled prompt for anti-patterns that constrain
 * the AI's expert judgment instead of empowering it.
 */

import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai'
import { buildSystemPrompt } from '../core/prompt-builder.js'
import { resolveActions } from '../core/effective-config.js'
import { configVersion } from './version.js'
import type { PromptAuditInput, PromptAuditResult, PromptAuditFailure } from './types.js'

/**
 * The keystone audit criteria — derived from PLAYBOOK_ESSENTIALS.md and the
 * design principles in eq.ts, identity.ts, and defaults.ts.
 *
 * These judge the SHAPE of the prompt, not the domain content.
 */
const PROMPT_AUDIT_SYSTEM = `You are the Archetype meta judge — an expert reviewer of AI persona configs written by other engineers (often with AI coding agents).

The most common failure you catch is the reviewer's instinct to assume the AI is "stupid" and box it with rules, instead of realizing the AI is as capable as the engineer and failed because the context, scenario, or contract was unclear. When you see a rule that looks like it's correcting a mediocre employee, the real fix is almost always in the adjacent layer (entity description, schema field, context label, EQ config) — not more brain prose.

THE KEYSTONE PRINCIPLE:
The AI persona is a domain expert. The prompt's job is to paint the scenario — context, memories, history, timing, constraints — and explain the intent. Describe the standard. Then trust the expert. Hard rules are ONLY for mechanical correctness (JSON format, unit conversion, schema compliance, dedup logic). Everything else must be a thinking nudge.

THE SMELL TEST:
If a line reads like correcting a mediocre employee instead of briefing a strong collaborator, it's a violation.

WHAT GREAT LOOKS LIKE:
A well-shaped methodology describes the world the expert operates in and what a great practitioner notices. It reads like a briefing, not a rulebook.

FAILURE MODES TO WATCH FOR (use judgment; these are lenses, not a checklist):

- prescriptive — rules that tell the AI what to do in specific situations instead of describing a standard.
- trigger-response-mapping — any "when X → do Y" pattern, at any level of abstraction. Even abstracted coaching wisdom like "respond to frustration by validating" is boxing.
- doing-experts-thinking — enumerating what to check, attend to, or reason about, instead of trusting the expert to know what matters.
- negative-identity — "you are NOT a calorie tracker" etc. Defines the persona by what it isn't.
- throttling — "limit yourself to 2 suggestions", "don't always ask a question" — arbitrary caps on the expert's judgment.
- announce-actions — instructions to narrate what the AI is doing or about to do.
- rule-density — so many rules stacked that the expert has no room to reason.
- duplicate-across-layers — prose in the brain that restates content already carried by entity descriptions, entity field describe() annotations, EQ flags, context labels, or memory config. The brain shouldn't carry what adjacent layers already say — duplicates compete for attention and crowd out taste.
- signal-dilution — the same semantic signal stated three or more times in different wordings across the assembled prompt (across SDK defaults, brain sections, EQ nudges, memory block intros, etc.). Different from duplicate-across-layers: that's brain restating adjacent-layer content; this is the SAME idea phrased multiple ways inside the same prompt. The AI sees a cloud of soft reminders instead of one canonical rule, and the cloud dilutes rather than reinforces. Name the concept being repeated, quote two or three of the offending phrasings, and suggest consolidating to the single strongest statement.
- self-documenting-overdocumented — an action or entity name that's already self-explanatory (like sendEmail, logMeal, createTask) paired with multi-line prose that restates what the name already says. Tell: deleting the description loses nothing a reader couldn't infer.
- ambiguous-action-contract — action or entity contracts where the name/schema/description fight each other, use generic words (data, handle, process), have vague types (any, stringified objects), or lack the semantic clues the AI needs to emit correct calls. When you see "AI emits malformed actions", the problem is usually here — not AI capability.
- not-visible-in-context — the ENTITIES block advertises update and delete for an entity, but the assembled prompt contains no surface that carries a record with an id for it (no CURRENT/OPEN/… block listing rows with ids under the entity name or its {name}Record(s) variants). The AI is asked to target records it can't see — it falls back to creating duplicates or writing memories instead. Fix by declaring a contextInput that surfaces records with ids, or by scoping the entity to createOnly.
- conflicting-instructions — two parts of the config contradict each other (e.g., identity says "respect informed choices", action protocol says "always push toward healthier").
- underspecified — instructions vague to the point of forcing guessing (e.g., "handle correction turns appropriately" — what's "appropriately"?). Different from terseness: good terse prose is unambiguous; underspecified prose leaves the AI to invent the meaning.

For each violation, quote the exact text, name the principle, explain concretely why it's a problem, and suggest a scenario-first rewrite OR point to the adjacent layer where the content should live (e.g., "move to profile entity description", "already carried by EQ qualitativeFirst flag").

Return valid JSON.`

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    failures: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          principle: { type: SchemaType.STRING, description: 'Which keystone principle is violated (e.g., "prescriptive", "behavioral-rule", "doing-experts-thinking", "negative-identity", "throttling", "rule-density")' },
          text: { type: SchemaType.STRING, description: 'The exact problematic text from the prompt' },
          issue: { type: SchemaType.STRING, description: 'Why this is a problem, concretely' },
          suggestion: { type: SchemaType.STRING, description: 'A scenario-first rewrite that preserves the intent' },
        },
        required: ['principle', 'text', 'issue', 'suggestion'],
      },
    },
    summary: { type: SchemaType.STRING, description: 'One-paragraph summary of the prompt health and key issues' },
  },
  required: ['failures', 'summary'],
}

const DEFAULT_AUDIT_FALLBACKS = ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite']
const AUDIT_MAX_RETRIES = 2

function isRetryableAuditError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /\b(429|5\d\d|timeout|timed out|overloaded|unavailable|resource exhausted)\b/i.test(msg)
}

export async function auditPrompt(input: PromptAuditInput): Promise<PromptAuditResult> {
  const { apiKey, config, context, memories } = input
  const primary = input.model ?? 'gemini-3.5-flash'
  const fallbacks = input.fallbackModels ?? DEFAULT_AUDIT_FALLBACKS
  const seen = new Set<string>()
  const modelChain = [primary, ...fallbacks].filter((m) => {
    if (seen.has(m)) return false
    seen.add(m)
    return true
  })

  // Resolve effective actions (merges memory/craft actions) to get the full prompt
  const effectiveActions = resolveActions(config)
  const effectiveConfig = effectiveActions !== config.actions
    ? { ...config, actions: effectiveActions }
    : config

  // Assemble the full prompt that the AI would actually see. When the
  // consumer passes `promptMode`, honor it — otherwise the audit reports
  // findings against a prompt variant the runtime never sends (chat-mode
  // default), missing latent contradictions in focus / operational modes.
  const fullPrompt = buildSystemPrompt({
    config: effectiveConfig,
    input: {
      message: '(audit)',
      context: context ?? {},
      memories: memories ?? [],
      timezone: 'UTC',
      ...(input.promptMode ? { promptMode: input.promptMode } : {}),
    },
  })

  const genAI = new GoogleGenerativeAI(apiKey)
  const makeModel = (modelName: string) => genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: PROMPT_AUDIT_SYSTEM,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA as unknown as Schema,
    },
  })

  const auditInput = `Review this assembled system prompt for keystone principle violations:\n\n---\n${fullPrompt}\n---`

  // Try each model in chain with retries
  let lastError: Error | undefined
  let result: { response: { text: () => string } } | undefined
  outer: for (let m = 0; m < modelChain.length; m++) {
    const current = modelChain[m]
    if (m > 0) {
      console.warn(`[archetype:audit] ${modelChain[m - 1]} exhausted — falling back to ${current}`)
    }
    const model = makeModel(current)
    for (let attempt = 0; attempt <= AUDIT_MAX_RETRIES; attempt++) {
      try {
        result = await model.generateContent(auditInput)
        break outer
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isRetryableAuditError(lastError)) throw lastError
        if (attempt < AUDIT_MAX_RETRIES) {
          const delayMs = Math.min(500 * Math.pow(2, attempt), 4000)
          console.warn(`[archetype:audit] ${current} attempt ${attempt + 1} failed: ${lastError.message} — retrying in ${delayMs}ms`)
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
    }
  }
  if (!result) throw lastError ?? new Error('[archetype:audit] all models exhausted')

  const parsed = JSON.parse(result.response.text()) as {
    failures: PromptAuditFailure[]
    summary: string
  }

  return {
    configVersion: configVersion(config),
    failures: parsed.failures ?? [],
    summary: parsed.summary ?? '',
  }
}
