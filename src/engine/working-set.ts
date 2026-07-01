import { buildAnnotations } from '../core/actions.js'
import { MEMORY_ACTION_NAMES } from '../core/memory-actions.js'
import type {
  ActionDefinition,
  ParsedAction,
  PersonaConfig,
  WorkingDelta,
  WorkingDeltaCommitState,
  WorkingSetReviewDecision,
  WorkingSet,
  WorkingSetSummary,
} from '../types.js'
import type { SideEffectHandler, SideEffectResult } from './side-effects.js'

const REVIEWABLE_STATES = new Set(['accepted', 'pending'] as const)

export interface WorkingSetCommitResult {
  workingSet: WorkingSet
  results: SideEffectResult[]
  summary: WorkingSetSummary
}

export interface ReviewWorkingSetDeltaInput {
  deltaId: string
  decision: WorkingSetReviewDecision
}

export function usesWorkingSet(config: PersonaConfig): boolean {
  return config.staging?.model === 'working-set'
}

export function buildWorkingSetSection(workingSet?: WorkingSet | null): string | null {
  if (!workingSet) return null

  const visible = workingSet.deltas.filter(
    delta => delta.reviewState === 'accepted' && delta.commitState !== 'committed'
  )
  if (visible.length === 0) return null

  const lines = visible.map(delta => {
    const commitLabel = delta.layer === 'transport'
      ? delta.commitState === 'committed'
        ? 'committed'
        : 'accepted but not executed'
      : 'current draft'
    return `- ${delta.annotation} [${delta.layer}; ${commitLabel}]`
  })

  return [
    'CURRENT WORKING SET:',
    'Accepted meaning-layer items are the current working truth of this conversation.',
    'Accepted transport-layer items are approved within the conversation, but not executed externally unless explicitly committed.',
    ...lines,
    'Do not re-propose accepted items unless the user challenges them. Never claim a transport action already happened unless it is committed.',
  ].join('\n')
}

export function summarizeWorkingSet(workingSet?: WorkingSet | null): WorkingSetSummary | undefined {
  if (!workingSet) return undefined

  const summary: WorkingSetSummary = {
    total: workingSet.deltas.length,
    accepted: 0,
    pending: 0,
    rejected: 0,
    superseded: 0,
    ready: 0,
    committed: 0,
    failed: 0,
  }

  for (const delta of workingSet.deltas) {
    summary[delta.reviewState]++
    if (delta.commitState === 'ready') summary.ready++
    if (delta.commitState === 'committed') summary.committed++
    if (delta.commitState === 'failed') summary.failed++
  }

  return summary
}

function deriveReviewCommitState(
  delta: WorkingDelta,
  decision: WorkingSetReviewDecision,
): WorkingDeltaCommitState {
  if (delta.layer === 'transport') {
    return decision === 'accept' ? 'ready' : 'not_required'
  }
  return 'not_required'
}

export function reviewWorkingSetDelta(
  workingSet: WorkingSet,
  input: ReviewWorkingSetDeltaInput,
): WorkingSet {
  const index = workingSet.deltas.findIndex(delta => delta.id === input.deltaId)
  if (index === -1) {
    throw new Error(`Working-set delta not found: ${input.deltaId}`)
  }

  const current = workingSet.deltas[index]
  if (current.reviewState === 'superseded') {
    throw new Error(`Cannot review superseded delta: ${input.deltaId}`)
  }
  if (current.commitState === 'committed') {
    throw new Error(`Cannot review committed delta: ${input.deltaId}`)
  }

  const nextReviewState = input.decision === 'accept' ? 'accepted' : 'rejected'
  const nextCommitState = deriveReviewCommitState(current, input.decision)

  if (
    current.reviewState === nextReviewState &&
    current.commitState === nextCommitState &&
    !current.error
  ) {
    return workingSet
  }

  const now = new Date().toISOString()
  const deltas = [...workingSet.deltas]
  deltas[index] = {
    ...current,
    reviewState: nextReviewState,
    commitState: nextCommitState,
    updatedAt: now,
    error: undefined,
  }

  return {
    ...workingSet,
    deltas,
    updatedAt: now,
  }
}

export function applyActionsToWorkingSet(
  existing: WorkingSet | null | undefined,
  actions: ParsedAction[],
  actionDefs: Record<string, ActionDefinition> | undefined,
): WorkingSet | undefined {
  if (!actionDefs || actions.length === 0) {
    return existing ?? undefined
  }

  const now = new Date().toISOString()
  const base: WorkingSet = existing ?? {
    id: crypto.randomUUID(),
    deltas: [],
    createdAt: now,
    updatedAt: now,
  }

  let deltas = [...base.deltas]
  let changed = false

  for (const action of actions) {
    const def = actionDefs[action.name]
    if (!def) continue
    if (MEMORY_ACTION_NAMES.has(action.name)) continue

    const validated = def.schema.safeParse(action.params)
    if (!validated.success) continue

    const layer = def.layer ?? 'meaning'
    const reviewState = def.defaultReviewState ?? 'accepted'
    const commitMode = def.commitMode ?? (layer === 'transport' ? 'explicit' : 'not_required')

    if (commitMode === 'immediate') continue

    const targetKey = def.targetKey?.(validated.data as Record<string, unknown>) ?? null
    let supersededId: string | undefined

    if (targetKey) {
      deltas = deltas.map(delta => {
        if (
          delta.targetKey === targetKey &&
          REVIEWABLE_STATES.has(delta.reviewState as 'accepted' | 'pending') &&
          delta.commitState !== 'committed'
        ) {
          supersededId = delta.id
          changed = true
          return {
            ...delta,
            reviewState: 'superseded' as const,
            updatedAt: now,
          }
        }
        return delta
      })
    }

    const annotation = buildAnnotations([{ name: action.name, params: validated.data as Record<string, unknown> }])[0]
    const commitState: WorkingDeltaCommitState =
      commitMode === 'explicit'
        ? (reviewState === 'accepted' ? 'ready' : 'not_required')
        : commitMode === 'committed'
          ? 'committed'
          : commitMode === 'failed'
            ? 'failed'
            : 'not_required'

    const delta: WorkingDelta = {
      id: crypto.randomUUID(),
      action,
      validatedParams: validated.data as Record<string, unknown>,
      annotation,
      layer,
      reviewState,
      commitState,
      targetKey,
      supersedes: supersededId,
      createdAt: now,
      updatedAt: now,
    }

    deltas.push(delta)
    changed = true
  }

  if (!changed) return existing ?? undefined

  return {
    ...base,
    deltas,
    updatedAt: now,
  }
}

export async function commitWorkingSet(
  workingSet: WorkingSet,
  handlers: Record<string, SideEffectHandler>,
  deltaIds?: string[],
): Promise<WorkingSetCommitResult> {
  const allowed = deltaIds ? new Set(deltaIds) : null
  const results: SideEffectResult[] = []
  const now = new Date().toISOString()

  const deltas = [...workingSet.deltas]

  for (let i = 0; i < deltas.length; i++) {
    const delta = deltas[i]
    if (delta.layer !== 'transport') continue
    if (delta.reviewState !== 'accepted') continue
    if (delta.commitState !== 'ready') continue
    if (allowed && !allowed.has(delta.id)) continue

    const handler = handlers[delta.action.name]
    if (!handler) {
      deltas[i] = {
        ...delta,
        commitState: 'failed',
        updatedAt: now,
        error: `No handler registered for action: ${delta.action.name}`,
      }
      results.push({
        action: delta.action,
        status: 'failed',
        success: false,
        error: `No handler registered for action: ${delta.action.name}`,
        annotation: delta.annotation,
      })
      continue
    }

    try {
      const outcome = await handler(delta.validatedParams)
      deltas[i] = {
        ...delta,
        commitState: outcome.success ? 'committed' : 'failed',
        updatedAt: now,
        error: outcome.error,
      }
      results.push({
        action: delta.action,
        status: outcome.success ? 'executed' : 'failed',
        success: outcome.success,
        error: outcome.error,
        annotation: delta.annotation,
      })
    } catch (err) {
      const message = `Handler error for ${delta.action.name}: ${err instanceof Error ? err.message : String(err)}`
      deltas[i] = {
        ...delta,
        commitState: 'failed',
        updatedAt: now,
        error: message,
      }
      results.push({
        action: delta.action,
        status: 'failed',
        success: false,
        error: message,
        annotation: delta.annotation,
      })
    }
  }

  const nextWorkingSet: WorkingSet = {
    ...workingSet,
    deltas,
    updatedAt: now,
  }

  return {
    workingSet: nextWorkingSet,
    results,
    summary: summarizeWorkingSet(nextWorkingSet)!,
  }
}
