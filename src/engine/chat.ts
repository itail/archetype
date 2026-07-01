import type { PersonaConfig, ChatInput, ChatResult, ParsedAction, CrudAction, EntityConfig, TurnTrace, TracedAction, TracedCrudAction } from '../types.js'
import { applyActionsToWorkingSet, summarizeWorkingSet, usesWorkingSet } from './working-set.js'
import { separateCrudActions, validateAndTraceCrud } from './crud.js'
import { buildChatLLMRequest } from '../core/request-builder.js'

export function createTrace(options?: { personaId?: string; correlationId?: string }): TurnTrace {
  return {
    traceId: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    personaId: options?.personaId,
    correlationId: options?.correlationId,
    startedAt: Date.now(),
    parseOk: false,
    repairAttempted: false,
    actions: [],
    crudActions: [],
    executionResults: [],
    domainActions: [],
    outcomeNotes: [],
    errors: [],
  }
}

export interface RawLLMResponse {
  message: string
  actions?: Array<{ name: string; params: Record<string, unknown> }>
  crudActions?: CrudAction[]
  attachmentNotes?: string[]
  followUps?: string[]
  diagnostics?: string[]
  outcomeNotes?: string[]
  // Legacy compat: "changes" array (mapped to actions)
  changes?: Array<{ action: string; [key: string]: unknown }>
}

export interface ParsedResponsePayload {
  parsed: RawLLMResponse
  text: string
}

export interface InvalidActionIssue {
  name: string
  error: string
}

const MAX_ACTION_REPAIR_ATTEMPTS = 1

function collectRawContractDrift(parsed: RawLLMResponse): string[] {
  const issues: string[] = []
  if (parsed.crudActions?.length) {
    issues.push('Raw response used legacy top-level "crudActions" key; use actions[{ "name": "crud", ... }] instead.')
  }
  return issues
}

/**
 * Stateless chat — build prompt, call LLM, parse response.
 * This is the Layer 1 core: no persistence, no side effects.
 */
export async function chat(
  config: PersonaConfig,
  input: ChatInput,
): Promise<ChatResult> {
  const { effectiveConfig, request } = buildChatLLMRequest(config, input)
  const trace = createTrace({ personaId: input.personaId, correlationId: input.correlationId })

  const response = await effectiveConfig.provider.chat(request)
  trace.provider = {
    name: effectiveConfig.provider.name,
    ...(response.requestedModel ? { requestedModel: response.requestedModel } : {}),
    ...(response.model ? { model: response.model } : {}),
  }

  // 4. Parse response
  const initial = parseRawResponse(response.text)
  if (!initial) {
    trace.parseOk = false
    trace.errors.push('Failed to parse LLM response as JSON')
    console.warn('[archetype] Failed to parse LLM response as JSON, using as plain message')
    return {
      message: normalizePlainTextResponse(response.text),
      actions: [],
      raw: response.text,
      trace,
    }
  }

  trace.parseOk = true
  let finalPayload = initial
  let validation = validateActions(initial.parsed, effectiveConfig)
  trace.actions = validation.traced

  if (validation.invalid.length > 0 && MAX_ACTION_REPAIR_ATTEMPTS > 0) {
    trace.repairAttempted = true
      const repaired = await retryInvalidActions({
        config: effectiveConfig,
        input,
        history: request.history,
        systemPrompt: request.systemPrompt,
        responseSchema: request.responseSchema ?? {},
        initialText: response.text,
        invalid: validation.invalid,
      })

    if (repaired) {
      finalPayload = repaired
      validation = validateActions(repaired.parsed, effectiveConfig)
      trace.actions = validation.traced.map(a =>
        a.status === 'valid' && validation.invalid.every(inv => inv.name !== a.name) ? a
        : a.status === 'valid' ? { ...a, status: 'repaired' as const } : a,
      )
      trace.repairSucceeded = validation.invalid.length === 0
      // If repair still produced invalid actions, surface them on trace.errors
      // so auditTraceIntegrity can see the failure — not just console.warn.
      if (!trace.repairSucceeded) {
        for (const inv of validation.invalid) {
          trace.errors.push(`Repair attempt did not fix action "${inv.name}": ${inv.error}`)
        }
      }
    } else {
      trace.repairSucceeded = false
      trace.errors.push('Repair attempt failed to produce a parsable response')
    }
  }

  trace.errors.push(...collectRawContractDrift(finalPayload.parsed))

  // Normalize message — LLM occasionally returns an array instead of a string
  const rawMsg = finalPayload.parsed.message
  const message = Array.isArray(rawMsg) ? rawMsg.join('\n') : (rawMsg ?? '')

  // Extract diagnostics (only when enabled)
  const diagnostics = config.diagnostics?.enabled
    ? normalizeStringArray(finalPayload.parsed.diagnostics)
    : undefined

  const outcomeNotes = normalizeStringArray(finalPayload.parsed.outcomeNotes)

  const { crudActions: rawCrud, nonCrudActions } = separateCrudActions(validation.actions, finalPayload.parsed.crudActions)
  const crudActions = effectiveConfig.entities ? validateAndTraceCrud(rawCrud, effectiveConfig.entities, trace) : undefined

  // Only include outcome notes on the public ChatResult when at least one
  // action or CRUD passed validation — callers filtering on "executed
  // actions happened" shouldn't see phantom outcomes.
  // BUT: the raw AI-written outcome notes still go on the trace so
  // debugging and auditTraceIntegrity can see what the model claimed.
  const hasValidActions = nonCrudActions.length > 0 || (crudActions && crudActions.length > 0)
  const effectiveOutcomeNotes = hasValidActions ? outcomeNotes : undefined
  if (outcomeNotes) trace.outcomeNotes = outcomeNotes

  // CRUD validation gate: if provided, validate proposals and retry on failure
  if (input.crudValidation && crudActions && crudActions.length > 0) {
    const validationErrors = input.crudValidation(crudActions)
    if (validationErrors && validationErrors.length > 0) {
      trace.errors.push(...validationErrors.map(e => `CRUD validation rejected: ${e}`))
      const maxRetries = input.crudValidationRetries ?? 1
      if (maxRetries > 0) {
        const retryMessage = `Your response had CRUD validation errors:\n${validationErrors.map(e => `- ${e}`).join('\n')}\n\nPlease correct and resubmit.`
        const retryResult = await chat(config, {
          ...input,
          message: retryMessage,
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.message },
            { role: 'assistant', content: message },
          ],
          crudValidationRetries: maxRetries - 1,
        })
        return retryResult
      }
    }
  }

  return {
    message,
    actions: nonCrudActions,
    crudActions,
    attachmentNotes: normalizeStringArray(finalPayload.parsed.attachmentNotes),
    followUps: finalPayload.parsed.followUps,
    ...(usesWorkingSet(effectiveConfig)
      ? (() => {
          const workingSet = applyActionsToWorkingSet(input.workingSet, validation.actions, effectiveConfig.actions)
          return {
            workingSet,
            workingSetSummary: summarizeWorkingSet(workingSet),
          }
        })()
      : {}),
    diagnostics,
    outcomeNotes: effectiveOutcomeNotes,
    raw: finalPayload.text,
    trace,
  }
}

function normalizeStringArray(values?: string[]): string[] | undefined {
  if (!values) return undefined
  const normalized = [...new Set(values.map(value => value.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
}

export function normalizePlainTextResponse(text: string): string {
  const trimmed = text.trim()

  try {
    const parsed = JSON.parse(trimmed) as unknown

    if (typeof parsed === 'string') return parsed
    if (Array.isArray(parsed)) return parsed.map(item => String(item)).join('\n')
    if (parsed && typeof parsed === 'object') {
      if ('greeting' in parsed) return normalizePlainTextResponse(String((parsed as { greeting: unknown }).greeting ?? ''))
      if ('message' in parsed) return normalizePlainTextResponse(String((parsed as { message: unknown }).message ?? ''))
      if ('text' in parsed) return normalizePlainTextResponse(String((parsed as { text: unknown }).text ?? ''))
    }
  } catch {
    // Plain text is the happy path.
  }

  return trimmed
}

/**
 * Parse LLM response text into a ChatResult.
 */
export function parseRawResponse(text: string): ParsedResponsePayload | null {
  try {
    return {
      parsed: JSON.parse(text) as RawLLMResponse,
      text,
    }
  } catch {
    return null
  }
}

export function validateActions(
  parsed: RawLLMResponse,
  config: PersonaConfig,
): { actions: ParsedAction[]; invalid: InvalidActionIssue[]; traced: TracedAction[] } {
  const definedActions = config.actions ?? {}
  const rawActions = parsed.actions ?? []

  const actions: ParsedAction[] = []
  const invalid: InvalidActionIssue[] = []
  const traced: TracedAction[] = []

  for (const action of rawActions) {
    // Pass through crud actions — they're extracted and validated separately
    if (action.name === 'crud') {
      let params = action.params ?? {}
      if (typeof params === 'string') {
        try { params = JSON.parse(params) } catch { /* leave as-is */ }
      }
      actions.push({
        name: 'crud',
        params: params as Record<string, unknown>,
        confidence: 'low',
      })
      continue
    }

    if (!(action.name in definedActions)) {
      traced.push({ name: action.name, params: action.params, status: 'unknown_action' })
      continue
    }

    // Gemini sometimes returns params as a JSON string instead of an object
    let params = action.params ?? {}
    if (typeof params === 'string') {
      try { params = JSON.parse(params) } catch { /* leave as-is — Zod will reject */ }
    }

    const parseResult = definedActions[action.name].schema.safeParse(params)
    if (!parseResult.success) {
      invalid.push({
        name: action.name,
        error: parseResult.error.message,
      })
      traced.push({ name: action.name, params: action.params, status: 'invalid', error: parseResult.error.message })
      continue
    }

    actions.push({
      name: action.name,
      params: parseResult.data as Record<string, unknown>,
      confidence: definedActions[action.name].confidence,
    })
    traced.push({ name: action.name, params: parseResult.data as Record<string, unknown>, status: 'valid' })
  }

  return { actions, invalid, traced }
}

async function retryInvalidActions(args: {
  config: PersonaConfig
  input: ChatInput
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  systemPrompt: string
  responseSchema: Record<string, unknown>
  initialText: string
  invalid: InvalidActionIssue[]
}): Promise<ParsedResponsePayload | null> {
  const { config, input, history, systemPrompt, responseSchema, initialText, invalid } = args

  console.warn(
    `[archetype] Retrying response because ${invalid.length} action(s) had invalid params: ${invalid.map(item => item.name).join(', ')}`
  )

  const repairMessage = [
    'Your previous response included invalid action params.',
    'Return the FULL response again as valid JSON.',
    'Keep the same user intent and overall meaning.',
    'If an action is not actually warranted, remove it instead of guessing missing fields.',
    '',
    `Original user message: ${input.message}`,
    '',
    'Previous response JSON:',
    initialText,
    '',
    'Invalid actions:',
    ...invalid.map(item => `- ${item.name}: ${item.error}`),
  ].join('\n')

  const retry = await config.provider.chat({
    systemPrompt,
    history,
    message: repairMessage,
    responseSchema,
    attachments: input.attachments,
  })

  const repaired = parseRawResponse(retry.text)
  if (!repaired) {
    console.warn('[archetype] Failed to parse repair response as JSON; keeping original valid subset')
    return null
  }

  const repairedValidation = validateActions(repaired.parsed, config)
  if (repairedValidation.invalid.length > 0) {
    console.warn(
      `[archetype] Repair response still had invalid action params: ${repairedValidation.invalid.map(item => item.name).join(', ')}`
    )
  }

  return repaired
}
