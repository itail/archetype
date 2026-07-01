import type { ParsedAction, ActionDefinition, ApprovalConfig } from '../types.js'
import { buildAnnotations } from '../core/actions.js'
import { buildAssistantContinuityMessage } from './continuity.js'

export interface SideEffectHandlerResult {
  success: boolean
  /** Did the handler actually mutate state? Defaults to `success` when omitted. */
  changed?: boolean
  error?: string
}

export interface SideEffectHandler {
  (params: Record<string, unknown>): Promise<SideEffectHandlerResult>
}

export interface SideEffectResult {
  action: ParsedAction
  status: 'executed' | 'proposed' | 'failed' | 'no_op'
  success: boolean
  /** Whether the handler actually mutated state (only set when status is 'executed' or 'no_op'). */
  changed?: boolean
  error?: string
  annotation?: string
}

/** A proposed action that passed validation but wasn't executed (propose mode). */
export interface ProposedAction {
  action: ParsedAction
  validatedParams: Record<string, unknown>
  annotation: string
}

export interface ExecuteSideEffectsOptions {
  /** Approval configuration. Defaults to yolo (execute immediately). */
  approval?: ApprovalConfig
}

/**
 * Execute side effects for parsed actions.
 * Validates action names, calls handlers, builds annotations.
 *
 * In 'yolo' mode (default): validates + executes immediately.
 * In 'propose' mode: validates + returns proposals without executing.
 *
 * ActionConfidence interacts with mode:
 * - 'low' always auto-executes (even in propose mode)
 * - 'medium' follows the mode setting
 * - 'high' always proposes (even in yolo mode)
 */
export async function executeSideEffects(
  actions: ParsedAction[],
  handlers: Record<string, SideEffectHandler>,
  actionDefs: Record<string, ActionDefinition>,
  options?: ExecuteSideEffectsOptions,
): Promise<SideEffectResult[]> {
  const mode = options?.approval?.mode ?? 'yolo'
  const results: SideEffectResult[] = []
  const proposed: ProposedAction[] = []

  for (const action of actions) {
    // Validate action exists
    if (!(action.name in actionDefs)) {
      results.push({
        action,
        status: 'failed',
        success: false,
        error: `Unknown action: ${action.name}`,
      })
      continue
    }

    // Validate handler exists
    const handler = handlers[action.name]
    if (!handler) {
      results.push({
        action,
        status: 'failed',
        success: false,
        error: `No handler registered for action: ${action.name}`,
      })
      continue
    }

    // Validate params against Zod schema
    const schema = actionDefs[action.name].schema
    const parseResult = schema.safeParse(action.params)
    if (!parseResult.success) {
      results.push({
        action,
        status: 'failed',
        success: false,
        error: `Invalid params for ${action.name}: ${parseResult.error.message}`,
      })
      continue
    }

    // Determine whether to execute or propose
    const shouldExecute = shouldAutoExecute(action.confidence, mode)

    if (shouldExecute) {
      // Execute handler immediately
      try {
        const result = await handler(parseResult.data)
        const changed = result.changed ?? result.success
        const annotations = buildAnnotations([{ name: action.name, params: action.params }])

        if (result.success && !changed) {
          results.push({
            action,
            status: 'no_op',
            success: true,
            changed: false,
            error: result.error,
            annotation: annotations[0],
          })
        } else {
          results.push({
            action,
            status: result.success ? 'executed' : 'failed',
            success: result.success,
            changed,
            error: result.error,
            annotation: annotations[0],
          })
        }
      } catch (err) {
        results.push({
          action,
          status: 'failed',
          success: false,
          changed: false,
          error: `Handler error for ${action.name}: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    } else {
      // Propose without executing
      const annotations = buildAnnotations([{ name: action.name, params: action.params }])
      proposed.push({
        action,
        validatedParams: parseResult.data as Record<string, unknown>,
        annotation: annotations[0],
      })
      results.push({
        action,
        status: 'proposed',
        success: true, // validation passed, just not executed yet
        annotation: annotations[0],
      })
    }
  }

  // Attach proposed actions to the result for the app to render
  if (proposed.length > 0) {
    ;(results as SideEffectResultWithProposals).__proposed = proposed
  }

  return results
}

/** Extended result type when propose mode generates proposals. */
export interface SideEffectResultWithProposals extends Array<SideEffectResult> {
  __proposed?: ProposedAction[]
}

/**
 * Extract proposed actions from a side-effects result.
 */
export function getProposedActions(results: SideEffectResult[]): ProposedAction[] {
  return (results as SideEffectResultWithProposals).__proposed ?? []
}

/**
 * Return annotations for actions that actually executed successfully.
 * Proposed or failed actions are intentionally excluded from stored history.
 */
export function getExecutedAnnotations(results: SideEffectResult[]): string[] {
  return results
    .filter(result => result.status === 'executed' && result.success && result.annotation)
    .map(result => result.annotation as string)
}

/**
 * Build the assistant message that should be stored in history.
 * Uses the shared continuity builder so future turns see factual outcomes,
 * while raw action annotations remain debug/display-only and are stripped
 * before the model sees history.
 */
export function buildAssistantHistoryMessage(
  message: string,
  results: SideEffectResult[],
): string {
  const annotations = getExecutedAnnotations(results)
  return buildAssistantContinuityMessage({
    message,
    actionAnnotations: annotations,
    actionOutcomes: results.map(result => ({
      action: result.action,
      status: result.status,
      success: result.success,
      error: result.error,
      annotation: result.annotation,
    })),
  })
}

/**
 * Execute previously proposed actions after user confirmation.
 * Takes the ProposedAction[] from `getProposedActions()` and runs the handlers.
 */
export async function confirmActions(
  proposed: ProposedAction[],
  handlers: Record<string, SideEffectHandler>,
): Promise<SideEffectResult[]> {
  const results: SideEffectResult[] = []

  for (const { action, validatedParams } of proposed) {
    const handler = handlers[action.name]
    if (!handler) {
      results.push({
        action,
        status: 'failed',
        success: false,
        error: `No handler registered for action: ${action.name}`,
      })
      continue
    }

    try {
      const result = await handler(validatedParams)
      const changed = result.changed ?? result.success
      const annotations = buildAnnotations([{ name: action.name, params: action.params }])

      if (result.success && !changed) {
        results.push({
          action,
          status: 'no_op',
          success: true,
          changed: false,
          error: result.error,
          annotation: annotations[0],
        })
      } else {
        results.push({
          action,
          status: result.success ? 'executed' : 'failed',
          success: result.success,
          changed,
          error: result.error,
          annotation: annotations[0],
        })
      }
    } catch (err) {
      results.push({
        action,
        status: 'failed',
        success: false,
        changed: false,
        error: `Handler error for ${action.name}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return results
}

/**
 * Determine if an action should auto-execute based on confidence + approval mode.
 *
 * - 'low' always executes (memory saves, logging)
 * - 'medium' follows mode ('yolo' = execute, 'propose' = propose)
 * - 'high' always proposes (destructive operations)
 */
function shouldAutoExecute(confidence: ParsedAction['confidence'], mode: 'propose' | 'yolo'): boolean {
  if (confidence === 'low') return true
  if (confidence === 'high') return false
  // medium: follows mode
  return mode === 'yolo'
}

// ─── Side-effect outcome summary ────────────────────────────────────────────

export type SideEffectOutcomeStatus = 'none' | 'succeeded' | 'partial' | 'failed' | 'no_op'

export interface SideEffectOutcome {
  /** Aggregate status across all executed actions */
  status: SideEffectOutcomeStatus
  /** Human-readable summary of what happened */
  summary: string
  /** Action names that were attempted */
  attemptedActions: string[]
  /** Action names that actually mutated state */
  appliedActions: string[]
  /** Error messages from failed or partial actions */
  errors: string[]
}

/**
 * Summarize side-effect execution results into an aggregate outcome.
 * Useful for communicating "what actually happened" to the user.
 *
 * Status logic:
 * - 'none': no actions attempted (empty input or all proposed)
 * - 'succeeded': all executed actions changed state
 * - 'partial': some changed, some failed or didn't change
 * - 'failed': nothing changed and there were errors
 * - 'no_op': handlers ran successfully but nothing changed
 */
export function summarizeSideEffects(results: SideEffectResult[]): SideEffectOutcome {
  const executed = results.filter(r => r.status !== 'proposed')
  if (executed.length === 0) {
    return {
      status: 'none',
      summary: 'No actions executed.',
      attemptedActions: [],
      appliedActions: [],
      errors: [],
    }
  }

  const attemptedActions = executed.map(r => r.action.name)
  const appliedActions = executed.filter(r => r.changed === true).map(r => r.action.name)
  const errors = executed.filter(r => r.error).map(r => r.error!)
  const anyChanged = appliedActions.length > 0
  const anyFailed = executed.some(r => r.status === 'failed')
  const anyNoOp = executed.some(r => r.status === 'no_op')

  let status: SideEffectOutcomeStatus
  if (anyChanged && (anyFailed || anyNoOp)) {
    status = 'partial'
  } else if (anyChanged) {
    status = 'succeeded'
  } else if (anyFailed) {
    status = 'failed'
  } else {
    status = 'no_op'
  }

  const summary = status === 'succeeded'
    ? `${appliedActions.length} action${appliedActions.length === 1 ? '' : 's'} applied.`
    : status === 'partial'
      ? `${appliedActions.length} of ${attemptedActions.length} actions applied.${errors.length > 0 ? ` Errors: ${errors.join('; ')}` : ''}`
      : status === 'failed'
        ? `No actions applied.${errors.length > 0 ? ` ${errors.join('; ')}` : ''}`
        : status === 'no_op'
          ? 'Actions ran but nothing changed.'
          : 'No actions executed.'

  return { status, summary, attemptedActions, appliedActions, errors }
}
