/**
 * Autonomous loop — Layer 2 primitive for multi-turn, tool-using flows.
 *
 * Parallel to `withStorage()` (Layer 2 for conversation-oriented personas),
 * `runAutonomousLoop()` is the Layer 2 wrapper for personas that drive a
 * workflow across many turns by emitting typed actions and consuming tool
 * results.
 *
 * What this primitive owns — consumers do NOT re-implement these:
 *   - Turn-by-turn history (literal transcript by default; no rebuilt briefs)
 *   - History storage policy (assistant entries store compact outcome-aware
 *     continuity, never the raw JSON response — raw JSON blows up context by
 *     turn ~4 when an action carries a large file body)
 *   - Completion detection (explicit completion actions only; "empty actions"
 *     is treated as a stall, not a success)
 *   - Max-turn budget + per-turn timeout + model retry
 *   - ChatInput assembly (`message`, `history`, pass-through persona options)
 *
 * What consumers own — the hooks:
 *   - `initialMessage`   → the first turn's user prompt
 *   - `formatToolResult` → how the prior turn's tool result becomes the next
 *                          turn's user prompt. THIS IS THE DIFFERENTIATOR
 *                          between autonomous-loop integrations. It's where
 *                          you decide how much workspace context the model
 *                          sees, and in what shape.
 *   - `executeAction`    → run the action, produce a structured result
 *   - `completionActionNames` → which action names (e.g. `returnToSession`)
 *                          should terminate the loop; defaults to empty, and
 *                          consumers can also return an explicit `finish`
 *                          from `executeAction`.
 *   - `onBeforeChat`     → observer hook invoked with the assembled chat
 *                          request before calling the provider. Use for
 *                          prompt tracing.
 *   - `onTurn`           → observer hook invoked after each turn's result is
 *                          recorded. Use for logging/evidence gathering.
 *
 * Design note: the primitive deliberately does NOT expose a knob for
 * "synthetic history" or "rebuilt task-frame every turn." Those anti-patterns
 * are the problem this primitive solves — they force the model to re-enter a
 * reconstructed situation on every turn instead of extending its own trace,
 * and the race post-mortem (`foundry/docs/PI_VS_FOUNDRY_WHAT_ARE_WE_MISSING.md`)
 * showed that's a material loss of momentum. If the hypothesis changes,
 * change this primitive; don't patch around it at the consumer layer.
 */

import type { PersonaEngine } from '../persona.js'
import type { ChatAttachment, ChatInput, ChatResult, ParsedAction, TurnTrace } from '../types.js'
import { buildChatLLMRequest } from '../core/request-builder.js'
import { buildAssistantContinuityMessage } from '../engine/continuity.js'

export interface LoopFinish {
  outcome: 'success' | 'blocked' | 'failed'
  summary: string
}

export interface LoopToolResult {
  /** Display-ready text that becomes the next turn's user message. */
  text: string
  /**
   * False when the action was not actually run (for example because a prior
   * same-turn action failed). Completion-action-name matching ignores
   * unexecuted results.
   */
  executed?: boolean
  /**
   * Durable outcome note stored in assistant history for future turns.
   * Keep this concise and factual: what changed, what was learned, or what
   * future-you should assume is now true. Unlike `text`, this should not
   * replay large bodies.
   */
  outcomeNote?: string
  /** Optional structured observation for logs/persistence. Not seen by the model. */
  observation?: Record<string, unknown>
  /** Set to terminate the loop after this turn with a given outcome. */
  finish?: LoopFinish
  /**
   * Optional multimodal attachments delivered alongside the NEXT turn's
   * user message (e.g. a PNG screenshot from a browser tool). Attachments
   * live on the turn they arrived and are NOT persisted into history —
   * future turns see only the text outcome note, not the bytes. Pass the
   * image as a ChatAttachment `{type:'image', mimeType, data}`.
   */
  attachments?: ChatAttachment[]
}

export interface LoopTurnContext<TRun> {
  turn: number
  maxTurns: number
  run: TRun
}

export interface LoopTurnRecord {
  turn: number
  /** The user message that was sent for this turn. */
  message: string
  /** The model's narrative (ChatResult.message). */
  assistantMessage: string
  /** The single action the model emitted, or null if the turn had none. */
  action: ParsedAction | null
  /** The tool execution result, or null if no action was emitted. */
  toolResult: LoopToolResult | null
  /** Raw provider text for trace/debug. NEVER used as history content. */
  rawAssistantResponse: string | null
  /** Full Archetype parse/validation trace for this model turn. */
  trace?: TurnTrace
  /** Actions the model emitted but the contract rejected (unknown_action /
   *  invalid). Populated from ChatResult.trace.actions. Surfaced to the model
   *  in the next turn's user message so it can self-correct rather than
   *  receiving silence. */
  validationErrors?: Array<{ name: string; status: string; error?: string }>
  /** Provider-level failure (MALFORMED_FUNCTION_CALL, timeout, empty
   *  response). The turn produced no usable output. Surfaced to the next
   *  turn's user message so the model knows WHY nothing happened. */
  providerError?: string
  /** When the model emits multiple actions per turn (Gemini's native
   *  function-calling API supports this), the first goes in `action` /
   *  `toolResult` above and the rest are stored here in emission order.
   *  `formatToolResult` is called per action; results are joined for the
   *  next-turn message. */
  extraActionResults?: Array<{ action: ParsedAction; result: LoopToolResult }>
}

export interface LoopState {
  /** The literal running transcript — user and assistant turns, in order. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Full record of every turn executed. */
  records: LoopTurnRecord[]
  /** Set when the loop terminates via a completion signal. */
  finish: LoopFinish | null
  turnsUsed: number
  /** Count of consecutive empty-action turns — the primitive terminates at 3. */
  consecutiveStalls: number
}

export interface BuiltChatRequest {
  systemPrompt: string
  message: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  attachments?: ChatAttachment[]
  responseSchema?: Record<string, unknown>
  promptMode?: ChatInput['promptMode']
}

export interface AutonomousLoopHooks<TRun> {
  initialMessage(ctx: LoopTurnContext<TRun>): string
  formatToolResult(
    action: ParsedAction,
    result: LoopToolResult,
    ctx: LoopTurnContext<TRun>,
  ): string
  executeAction(
    action: ParsedAction,
    ctx: LoopTurnContext<TRun>,
  ): Promise<LoopToolResult>
  /**
   * Optional batch executor for hosts whose action surface has same-turn
   * semantics (for example coder tools that stop after a failed outcome).
   * Generic autonomous-loop does not inspect the policy; it only preserves
   * the ordered results the host returns.
   */
  executeActions?(
    actions: readonly ParsedAction[],
    ctx: LoopTurnContext<TRun>,
  ): Promise<Array<{ action: ParsedAction; result: LoopToolResult }>>
  /** Action names that signal return/completion. E.g. ['returnToSession']. */
  completionActionNames?: readonly string[]
  /** ChatInput options applied every turn (promptMode, contractStyle, context, etc).
   *  `message` and `history` are primitive-owned and rejected here.
   *  Pass a function when context must be rebuilt from the latest run state
   *  (for example WORK HISTORY and FILES in focus mode). */
  chatOptions?:
    | Omit<ChatInput, 'message' | 'history'>
    | ((ctx: LoopTurnContext<TRun>, state: LoopState) =>
        Omit<ChatInput, 'message' | 'history'> | Promise<Omit<ChatInput, 'message' | 'history'>>)
  onBeforeChat?(info: { request: BuiltChatRequest; turn: number; attempt: number }): void | Promise<void>
  onTurn?(record: LoopTurnRecord, state: LoopState): void | Promise<void>
}

/**
 * Persona source: either a fixed engine, or a per-turn factory. The factory
 * form exists because some autonomous flows (e.g. tool menus that narrow or
 * expand based on workspace state) legitimately need a different persona
 * config per turn. For the common fixed-persona case, pass it directly.
 */
export type PersonaSource<TRun> =
  | PersonaEngine
  | ((ctx: LoopTurnContext<TRun>) => PersonaEngine | Promise<PersonaEngine>)

export interface RunAutonomousLoopInput<TRun> {
  persona: PersonaSource<TRun>
  maxTurns: number
  run: TRun
  hooks: AutonomousLoopHooks<TRun>
  /** Per-turn provider timeout. Defaults to 90s. */
  turnTimeoutMs?: number
  /** Model retries on provider errors. Defaults to 2. */
  modelRetries?: number
  /** Delay between retries, in ms. Defaults to 2000. */
  modelRetryDelayMs?: number
}

export interface AutonomousLoopResult {
  state: LoopState
  finish: LoopFinish
}

const DEFAULT_TURN_TIMEOUT_MS = 90_000
const DEFAULT_MODEL_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 2_000
const MAX_CONSECUTIVE_STALLS = 3

export async function runAutonomousLoop<TRun>(
  input: RunAutonomousLoopInput<TRun>,
): Promise<AutonomousLoopResult> {
  validateHooks(input.hooks)

  const state: LoopState = {
    history: [],
    records: [],
    finish: null,
    turnsUsed: 0,
    consecutiveStalls: 0,
  }

  const turnTimeoutMs = input.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const modelRetries = input.modelRetries ?? DEFAULT_MODEL_RETRIES
  const retryDelayMs = input.modelRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const completionNames = new Set(input.hooks.completionActionNames ?? [])

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
    const ctx: LoopTurnContext<TRun> = {
      turn,
      maxTurns: input.maxTurns,
      run: input.run,
    }

    const message = buildTurnMessage(state, input.hooks, ctx)

    // Collect any multimodal attachments the previous turn's tool result
    // set. Attachments are delivered once (this turn) and intentionally not
    // persisted in history — future turns see only the text outcome, not
    // the bytes. A browserScreenshot returning a PNG is the canonical case.
    const priorAttachments = collectPriorToolAttachments(state)

    const chatOptions = await resolveLoopChatOptions(input.hooks.chatOptions, ctx, state)
    const chatInput: ChatInput = {
      ...chatOptions,
      message,
      history: [...state.history],
      ...(priorAttachments.length > 0 ? { attachments: priorAttachments } : {}),
    }

    const turnPersona = typeof input.persona === 'function'
      ? await input.persona(ctx)
      : input.persona

    let result: ChatResult
    try {
      result = await callPersonaWithRetry({
        persona: turnPersona,
        chatInput,
        turn,
        turnTimeoutMs,
        modelRetries,
        retryDelayMs,
        onBeforeChat: input.hooks.onBeforeChat,
      })
    } catch (error) {
      // Provider-level error (MALFORMED_FUNCTION_CALL, empty response, timeout,
      // etc.). Surface only factual continuity to the next turn. Do not turn
      // infrastructure load/timeouts into strategy advice for the agent.
      const summary = error instanceof Error ? error.message : String(error)
      const infrastructureLoad = isInfrastructureLoadError(summary)
      if (infrastructureLoad) {
        console.error(
          `\x1b[33m[archetype PROVIDER LOAD]\x1b[0m Turn ${turn}: ${summary}. `
          + `No actions ran. The next turn will retry the same active work after recording the timeout.`,
        )
      } else {
        console.error(
          `\x1b[31m[archetype PROVIDER ERROR]\x1b[0m Turn ${turn}: ${summary}. `
          + `No actions ran. If this repeats, inspect the prompt dump and provider payload.`,
        )
      }
      state.records.push({
        turn,
        message,
        assistantMessage: '',
        action: null,
        toolResult: null,
        rawAssistantResponse: null,
        providerError: summary,
      })
      state.turnsUsed = turn
      state.consecutiveStalls += 1
      if (state.consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
        state.finish = {
          outcome: 'blocked',
          summary: `Autonomous loop: ${MAX_CONSECUTIVE_STALLS} consecutive provider failures. Last: ${summary}`,
        }
        break
      }
      continue
    }

    const actions = Array.isArray(result.actions) ? result.actions : []

    // Execute all emitted actions sequentially. Gemini's native function-
    // calling API natively returns multiple `functionCall` parts per turn,
    // and pi's coding agent supports this; rejecting multi-action turns was a
    // holdover from the focus-mode assumption of one-action-per-turn. Each
    // action executes in emission order, its tool result feeds into the
    // aggregate. Early-exit if any action's result sets `finish`.
    const actionResults: Array<{ action: ParsedAction; result: LoopToolResult }> = input.hooks.executeActions
      ? await input.hooks.executeActions(actions, ctx)
      : []
    if (!input.hooks.executeActions) {
      for (const a of actions) {
        const r = await input.hooks.executeAction(a, ctx)
        actionResults.push({ action: a, result: r })
        if (r.finish) break
      }
    }
    const action = actions[0] ?? null
    const toolResult = actionResults[0]?.result ?? null

    // Validation errors: the model emitted actions the contract rejected
    // (unknown_action, invalid). Archetype's chat.ts puts these on
    // ChatResult.trace.actions but by default they disappear into the void —
    // the model sees no tool result and no explanation. Log strongly AND
    // attach to the record so the next turn can surface the error to the
    // model.
    const validationErrors = (result.trace?.actions ?? [])
      .filter(a => a.status === 'invalid' || a.status === 'unknown_action')
      .map(a => ({ name: a.name, status: a.status as string, error: a.error }))
    if (validationErrors.length > 0) {
      console.error(
        `\x1b[31m[archetype CONFUSED PROMPT]\x1b[0m Turn ${turn}: model emitted ${validationErrors.length} action(s) the contract rejected. `
        + `This means the prompt / tool schema we gave the model was ambiguous or misleading — the model made a reasonable try and we said no. `
        + `Surfacing to the model as feedback.\n`
        + validationErrors.map(e => `  - ${e.status} "${e.name}": ${e.error ?? '(no detail)'}`).join('\n'),
      )
    }

    // Update history: user message, then a compact assistant-history entry.
    // Future turns should see outcome continuity, not raw assistant JSON.
    // Providers that reconstruct native function-call history opt into a
    // compact JSON transport that preserves action references while dropping
    // large payload bodies.
    state.history.push({ role: 'user', content: message })
    state.history.push({
      role: 'assistant',
      content: buildAssistantContinuityMessage({
        message: result.message,
        modelOutcomeNotes: result.outcomeNotes,
        actionOutcomes: actionResults.map(({ action, result: toolResult }) => ({
          action,
          outcomeNote: toolResult.outcomeNote,
          text: toolResult.text,
          status: toolResult.finish ? `finish:${toolResult.finish.outcome}` : undefined,
          success: toolResult.finish ? toolResult.finish.outcome === 'success' : undefined,
        })),
        actionsForHistory: actionResults.map(({ action }) => action),
        historyTransport: turnPersona.config.provider.historyTransport,
      }),
    })

    const record: LoopTurnRecord = {
      turn,
      message,
      assistantMessage: result.message,
      action,
      toolResult,
      rawAssistantResponse: result.raw ?? null,
      trace: result.trace,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      extraActionResults: actionResults.length > 1
        ? actionResults.slice(1)
        : undefined,
    }
    state.records.push(record)
    state.turnsUsed = turn
    // Don't count validation-rejected as a stall: the model DID emit an
    // action, we just rejected it. Reset the stall counter so the model has
    // full budget to adapt.
    state.consecutiveStalls = (action || validationErrors.length > 0) ? 0 : state.consecutiveStalls + 1

    if (input.hooks.onTurn) {
      await input.hooks.onTurn(record, state)
    }

    // Completion checks, in priority order. Scan ALL action results for a
    // finish signal or a completion-action-name match — any of the multi-
    // action emissions can signal done.
    const finishFromResults = actionResults.find(r => r.result.finish)?.result.finish
    if (finishFromResults) {
      state.finish = finishFromResults
      break
    }
    const completionAction = actionResults.find(r => r.result.executed !== false && completionNames.has(r.action.name))
    if (completionAction) {
      state.finish = finishFromCompletionAction(completionAction.action)
      break
    }
    if (state.consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
      state.finish = {
        outcome: 'blocked',
        summary: `Autonomous loop: model stalled (returned no action for ${MAX_CONSECUTIVE_STALLS} consecutive turns).`,
      }
      break
    }
  }

  const finish: LoopFinish = state.finish ?? {
    outcome: 'blocked',
    summary: `Reached max turns (${input.maxTurns}) without completion.`,
  }
  return { state, finish }
}

/**
 * Translate a validation rejection into plain English. Zod's raw JSON
 * (`[{code:"too_small",minimum:1,path:["edits",0,"oldText"],message:"String
 * must contain at least 1 character(s)"}]`) is technically correct but
 * reads like stack trace — the model repeated the same empty-oldText
 * mistake four turns in a row on 2026-04-21 despite seeing that JSON each
 * turn. Format each error to say what the field represents and why the
 * value was invalid, without prescribing the next move.
 */
function formatValidationError(
  e: { name: string; status: string; error?: string },
): string {
  if (e.status === 'unknown_action') {
    return (
      `  - Unknown action "${e.name}": not in the AVAILABLE ACTIONS list. `
      + `The valid set is fixed by the contract above — no other names exist.`
    )
  }
  // Try to parse the raw Zod error array. If it's not JSON, fall back to
  // passing the string through.
  type ZodIssue = { code?: string; path?: Array<string | number>; minimum?: number; maximum?: number; expected?: string; received?: string; message?: string }
  let parsed: ZodIssue[] = []
  if (e.error) {
    try {
      const maybe = JSON.parse(e.error) as unknown
      if (Array.isArray(maybe)) parsed = maybe as ZodIssue[]
    } catch {
      // raw string — keep as-is
    }
  }
  if (parsed.length === 0) {
    return `  - Invalid action "${e.name}": ${e.error ?? '(no detail)'}`
  }
  const details = parsed.map((issue) => {
    const fieldPath = (issue.path ?? []).map(String).join('.')
    const fieldRef = fieldPath || '(root)'
    switch (issue.code) {
      case 'too_small':
        if (issue.expected === 'array') {
          return `${fieldRef} was empty — the schema requires at least ${issue.minimum ?? 1} entr${(issue.minimum ?? 1) === 1 ? 'y' : 'ies'}.`
        }
        return `${fieldRef} was empty or too short — the schema requires at least ${issue.minimum ?? 1} character${(issue.minimum ?? 1) === 1 ? '' : 's'}.`
      case 'invalid_type':
        return `${fieldRef} had the wrong type — expected ${issue.expected ?? '?'}, got ${issue.received ?? '?'}.`
      case 'unrecognized_keys':
        return `${fieldRef} contained unrecognized keys — only the declared param names are accepted.`
      case 'invalid_enum_value':
        return `${fieldRef} was not one of the allowed values — see the action's schema above.`
      default:
        return `${fieldRef}: ${issue.message ?? issue.code ?? 'invalid'}.`
    }
  }).join(' ')
  return `  - "${e.name}" was rejected: ${details}`
}

/**
 * Gather attachments from the most recent turn's tool results. Only the
 * "prior turn" contributes. We deliver only the latest attachment once,
 * on the turn after it was produced; screenshot-heavy tool batches should
 * carry the final visual state without bloating the next model request.
 */
function collectPriorToolAttachments(state: LoopState): ChatAttachment[] {
  if (state.records.length === 0) return []
  const prior = state.records[state.records.length - 1]
  const attachments: ChatAttachment[] = []
  if (prior.toolResult?.attachments && prior.toolResult.attachments.length > 0) {
    attachments.push(...prior.toolResult.attachments)
  }
  if (prior.extraActionResults) {
    for (const extra of prior.extraActionResults) {
      if (extra.result.attachments && extra.result.attachments.length > 0) {
        attachments.push(...extra.result.attachments)
      }
    }
  }
  const latest = attachments.at(-1)
  return latest ? [latest] : []
}

function validateHooks<TRun>(hooks: AutonomousLoopHooks<TRun>): void {
  if (typeof hooks.initialMessage !== 'function') {
    throw new Error('runAutonomousLoop: hooks.initialMessage must be a function')
  }
  if (typeof hooks.formatToolResult !== 'function') {
    throw new Error('runAutonomousLoop: hooks.formatToolResult must be a function')
  }
  if (typeof hooks.executeAction !== 'function') {
    throw new Error('runAutonomousLoop: hooks.executeAction must be a function')
  }
  if (hooks.chatOptions) {
    if (typeof hooks.chatOptions === 'function') return
    const options = hooks.chatOptions as Record<string, unknown>
    if ('message' in options || 'history' in options) {
      throw new Error(
        'runAutonomousLoop: hooks.chatOptions may not include `message` or `history` — those are primitive-owned.',
      )
    }
  }
}

async function resolveLoopChatOptions<TRun>(
  chatOptions: AutonomousLoopHooks<TRun>['chatOptions'],
  ctx: LoopTurnContext<TRun>,
  state: LoopState,
): Promise<Omit<ChatInput, 'message' | 'history'>> {
  const resolved = typeof chatOptions === 'function'
    ? await chatOptions(ctx, state)
    : (chatOptions ?? {})
  if ('message' in resolved || 'history' in resolved) {
    throw new Error(
      'runAutonomousLoop: hooks.chatOptions may not include `message` or `history` — those are primitive-owned.',
    )
  }
  return resolved
}

function buildTurnMessage<TRun>(
  state: LoopState,
  hooks: AutonomousLoopHooks<TRun>,
  ctx: LoopTurnContext<TRun>,
): string {
  // Turn 1 — initial message.
  if (state.records.length === 0) {
    return hooks.initialMessage(ctx)
  }
  const prior = state.records[state.records.length - 1]
  // Provider error: preserve the active work and add neutral continuity.
  // Timeouts/load are infrastructure facts, not evidence that the agent chose
  // a bad strategy or needs to make the artifact smaller.
  if (prior.providerError) {
    return (
      `${prior.message}\n\n`
      + `The LLM request timed out or the provider was under heavy load. No actions ran.\n`
      + `${prior.providerError}\n\n`
      + `Please try again from the same active work.`
    )
  }
  // Validation errors: the model emitted actions that the contract rejected.
  // Translate each rejection into plain language so the model can see WHY
  // the call was invalid and what the field is. Echoing the raw Zod JSON
  // is not enough — we saw the same model emit the same empty-oldText
  // editFile four turns in a row, because the tail "pick closest available
  // shape" read as guess-advice, not as "your oldText field was empty."
  if (prior.validationErrors && prior.validationErrors.length > 0 && !prior.action) {
    const lines = prior.validationErrors.map((e) => formatValidationError(e)).join('\n')
    return `Previous action(s) rejected by the tool contract:\n${lines}`
  }
  // Normal tool result — single or multi-action. For multi-action turns,
  // format each result and join; the model then sees all its tool calls'
  // outputs in emission order.
  if (prior.action && prior.toolResult) {
    const head = hooks.formatToolResult(prior.action, prior.toolResult, ctx)
    if (!prior.extraActionResults || prior.extraActionResults.length === 0) {
      return head
    }
    const tail = prior.extraActionResults
      .map(({ action, result }) => hooks.formatToolResult(action, result, ctx))
      .join('\n\n')
    return `${head}\n\n${tail}`
  }
  // Fallback — no action, no error, no tool result (shouldn't happen but keep
  // a factual nudge).
  return '(your previous turn produced no action — continue with a concrete next step or call the completion action if you are done)'
}

async function callPersonaWithRetry(args: {
  persona: PersonaEngine
  chatInput: ChatInput
  turn: number
  turnTimeoutMs: number
  modelRetries: number
  retryDelayMs: number
  onBeforeChat?: AutonomousLoopHooks<unknown>['onBeforeChat']
}): Promise<ChatResult> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= args.modelRetries + 1; attempt += 1) {
    try {
      if (args.onBeforeChat) {
        const { request } = buildChatLLMRequest(args.persona.config, args.chatInput)
        await args.onBeforeChat({
          request: {
            systemPrompt: request.systemPrompt,
            message: request.message,
            history: request.history,
            attachments: request.attachments,
            responseSchema: request.responseSchema,
            promptMode: request.promptMode,
          },
          turn: args.turn,
          attempt,
        })
      }
      return await withTimeout(
        args.persona.chat(args.chatInput),
        args.turnTimeoutMs,
        `Autonomous loop turn ${args.turn} timed out after ${args.turnTimeoutMs}ms`,
      )
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (attempt > args.modelRetries || !shouldRetry(message)) {
        throw error
      }
      await sleep(args.retryDelayMs * attempt)
    }
  }
  throw lastError ?? new Error(`Autonomous loop turn ${args.turn} failed`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function shouldRetry(message: string): boolean {
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|503|504|429/i.test(message)
}

function isInfrastructureLoadError(message: string): boolean {
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|503|504|429|overloaded|unavailable|resource exhausted/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeOutcome(value: unknown): LoopFinish['outcome'] {
  if (value === 'success' || value === 'blocked' || value === 'failed') return value
  return 'blocked'
}

function finishFromCompletionAction(action: ParsedAction): LoopFinish {
  const params = action.params as {
    outcome?: string
    state?: string
    summary?: string
    message?: string
  }
  return {
    outcome: normalizeCompletionState(params.outcome ?? params.state),
    summary: params.summary ?? params.message ?? `Completion action ${action.name} called.`,
  }
}

function normalizeCompletionState(value: unknown): LoopFinish['outcome'] {
  if (value === 'ready') return 'success'
  return normalizeOutcome(value)
}
