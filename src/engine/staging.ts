import type {
  ParsedAction,
  ActionDefinition,
  StagedAction,
  StagedBatch,
  StagedActionStatus,
  BatchSummary,
} from '../types.js'
import type { SideEffectHandler, SideEffectResult } from './side-effects.js'
import { buildAnnotations } from '../core/actions.js'

export interface BatchCommitResult {
  results: SideEffectResult[]
  summary: BatchSummary
}

/**
 * Create a staged batch from parsed actions.
 * Validates each action against its definition — invalid/unknown actions are auto-rejected.
 */
export function createBatch(
  actions: ParsedAction[],
  actionDefs: Record<string, ActionDefinition>,
): StagedBatch {
  const stagedActions: StagedAction[] = actions.map((action, index) => {
    // Unknown action name → rejected
    const def = actionDefs[action.name]
    if (!def) {
      return {
        index,
        action,
        validatedParams: action.params,
        annotation: `Unknown action: ${action.name}`,
        status: 'rejected' as const,
      }
    }

    // Validate params
    const parseResult = def.schema.safeParse(action.params)
    if (!parseResult.success) {
      return {
        index,
        action,
        validatedParams: action.params,
        annotation: `Invalid params: ${parseResult.error.message}`,
        status: 'rejected' as const,
      }
    }

    // Valid → pending
    const annotations = buildAnnotations([{ name: action.name, params: action.params }])
    return {
      index,
      action,
      validatedParams: parseResult.data as Record<string, unknown>,
      annotation: annotations[0],
      status: 'pending' as const,
    }
  })

  return {
    id: crypto.randomUUID(),
    actions: stagedActions,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Update the status of a single action in the batch. Returns a new batch (immutable).
 */
export function updateActionStatus(
  batch: StagedBatch,
  index: number,
  status: StagedActionStatus,
): StagedBatch {
  if (index < 0 || index >= batch.actions.length) {
    throw new RangeError(`Index ${index} out of bounds (batch has ${batch.actions.length} actions)`)
  }

  const newActions = batch.actions.map((a, i) =>
    i === index ? { ...a, status } : a,
  )
  return { ...batch, actions: newActions }
}

/**
 * Edit an action's params, re-validating against the schema. Returns a new batch.
 * Throws if validation fails (caller surfaces as toast).
 */
export function editActionParams(
  batch: StagedBatch,
  index: number,
  newParams: Record<string, unknown>,
  actionDefs: Record<string, ActionDefinition>,
): StagedBatch {
  if (index < 0 || index >= batch.actions.length) {
    throw new RangeError(`Index ${index} out of bounds (batch has ${batch.actions.length} actions)`)
  }

  const action = batch.actions[index]
  const def = actionDefs[action.action.name]
  if (!def) {
    throw new Error(`Unknown action: ${action.action.name}`)
  }

  const parseResult = def.schema.safeParse(newParams)
  if (!parseResult.success) {
    throw new Error(`Invalid params for ${action.action.name}: ${parseResult.error.message}`)
  }

  const annotations = buildAnnotations([{ name: action.action.name, params: newParams }])
  const newActions = batch.actions.map((a, i) =>
    i === index
      ? {
          ...a,
          validatedParams: parseResult.data as Record<string, unknown>,
          annotation: annotations[0],
        }
      : a,
  )
  return { ...batch, actions: newActions }
}

/**
 * Commit all accepted actions in a batch by running their handlers sequentially.
 */
export async function commitBatch(
  batch: StagedBatch,
  handlers: Record<string, SideEffectHandler>,
): Promise<BatchCommitResult> {
  const results: SideEffectResult[] = []

  const accepted = batch.actions.filter(a => a.status === 'accepted')

  for (const staged of accepted) {
    const handler = handlers[staged.action.name]
    if (!handler) {
      results.push({
        action: staged.action,
        status: 'failed',
        success: false,
        error: `No handler registered for action: ${staged.action.name}`,
        annotation: staged.annotation,
      })
      continue
    }

    try {
      const result = await handler(staged.validatedParams)
      results.push({
        action: staged.action,
        status: result.success ? 'executed' : 'failed',
        success: result.success,
        error: result.error,
        annotation: staged.annotation,
      })
    } catch (err) {
      results.push({
        action: staged.action,
        status: 'failed',
        success: false,
        error: `Handler error for ${staged.action.name}: ${err instanceof Error ? err.message : String(err)}`,
        annotation: staged.annotation,
      })
    }
  }

  return {
    results,
    summary: summarizeBatch(batch),
  }
}

/**
 * Summarize a batch by status counts and labels.
 */
export function summarizeBatch(batch: StagedBatch): BatchSummary {
  let accepted = 0
  let rejected = 0
  let pending = 0
  const acceptedLabels: string[] = []
  const rejectedLabels: string[] = []

  for (const action of batch.actions) {
    switch (action.status) {
      case 'accepted':
        accepted++
        acceptedLabels.push(action.annotation)
        break
      case 'rejected':
        rejected++
        rejectedLabels.push(action.annotation)
        break
      case 'pending':
        pending++
        break
    }
  }

  return {
    total: batch.actions.length,
    accepted,
    rejected,
    pending,
    acceptedLabels,
    rejectedLabels,
  }
}
