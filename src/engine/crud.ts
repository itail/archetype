import { allowedOperations } from '../core/entity-helpers.js'
import type { CrudAction, EntityConfig, ParsedAction, TurnTrace, TracedCrudAction } from '../types.js'

/**
 * Validate raw CRUD actions against registered entity schemas.
 * Returns valid + invalid lists.
 */
export function validateCrudActions(
  raw: CrudAction[],
  entities: Record<string, EntityConfig>,
): { valid: CrudAction[]; invalid: Array<{ action: CrudAction; error: string }> } {
  const valid: CrudAction[] = []
  const invalid: Array<{ action: CrudAction; error: string }> = []

  for (const rawAction of raw) {
    // Parse stringified params (Gemini returns JSON string since the schema uses STRING type)
    let action = rawAction
    if (typeof rawAction.params === 'string') {
      try {
        action = { ...rawAction, params: JSON.parse(rawAction.params) }
      } catch {
        invalid.push({ action: rawAction, error: `Invalid JSON in params: ${String(rawAction.params).slice(0, 100)}` })
        continue
      }
    }

    // Check entity exists
    const entityConfig = entities[action.entity]
    if (!entityConfig) {
      invalid.push({ action, error: `Unknown entity "${action.entity}"` })
      continue
    }

    // Check the host app implements this operation for this entity
    const allowed = allowedOperations(entityConfig)
    if (!allowed.includes(action.operation)) {
      invalid.push({ action, error: `Entity "${action.entity}" does not support ${action.operation} — supported: ${allowed.join(', ')}` })
      continue
    }

    // Check id for update/delete
    if ((action.operation === 'update' || action.operation === 'delete') && !action.id) {
      invalid.push({ action, error: `${action.operation} requires an id` })
      continue
    }

    // Validate params for create (full schema) and update (partial)
    if (action.operation === 'create') {
      const result = entityConfig.schema.safeParse(action.params ?? {})
      if (!result.success) {
        invalid.push({ action, error: result.error.message })
        continue
      }
      // Ensure every create has an ID (AI-generated temp or SDK fallback)
      const id = action.id || crypto.randomUUID()
      valid.push({ ...action, id, params: result.data as Record<string, unknown> })
    } else if (action.operation === 'update') {
      // Partial validation — use .partial() if available
      const schema = entityConfig.schema
      const partial = 'partial' in schema && typeof schema.partial === 'function'
        ? (schema as { partial: () => typeof schema }).partial()
        : schema
      const result = partial.safeParse(action.params ?? {})
      if (!result.success) {
        invalid.push({ action, error: result.error.message })
        continue
      }
      valid.push({ ...action, params: result.data as Record<string, unknown> })
    } else if (action.operation === 'delete') {
      // delete — no params needed
      valid.push(action)
    } else {
      // Unknown operation — don't silently treat as delete.
      invalid.push({
        action,
        error: `Unknown CRUD operation "${String(action.operation)}" — expected "create", "update", or "delete"`,
      })
    }
  }

  return { valid, invalid }
}

/**
 * Generate an action annotation string for a CRUD action.
 * Uses the entity's displayField to create human-readable annotations like:
 *   created thread: "Roadmap prioritization"
 */
export function crudActionToAnnotation(
  action: CrudAction,
  entities: Record<string, EntityConfig>,
): string {
  const config = entities[action.entity]
  const label = config?.label ?? capitalize(action.entity)

  const displayField = config?.displayField
  const displayValue = displayField && action.params?.[displayField]
    ? String(action.params[displayField])
    : null

  const title = displayValue ? `: "${displayValue}"` : ''

  switch (action.operation) {
    case 'create': return `created ${label.toLowerCase()}${title}`
    case 'update': return `updated ${label.toLowerCase()} ${action.id ?? ''}${title}`.trim()
    case 'delete': return `deleted ${label.toLowerCase()} ${action.id ?? ''}`.trim()
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Separate CRUD actions from regular actions in a validated action list.
 * Handles stringified params (Gemini quirk) and legacy top-level crudActions.
 */
export function separateCrudActions(
  actions: ParsedAction[],
  legacyCrud?: CrudAction[],
): { crudActions: CrudAction[]; nonCrudActions: ParsedAction[] } {
  const crudActions: CrudAction[] = []
  const nonCrudActions: ParsedAction[] = []

  for (const action of actions) {
    if (action.name === 'crud') {
      const p = action.params as Record<string, unknown>
      const innerParams = typeof p.params === 'string' ? p.params : (p.params ? JSON.stringify(p.params) : undefined)
      crudActions.push({
        operation: p.operation as CrudAction['operation'],
        entity: p.entity as string,
        id: p.id as string | undefined,
        params: innerParams as unknown as Record<string, unknown> | undefined,
      })
    } else {
      nonCrudActions.push(action)
    }
  }

  if (legacyCrud?.length) {
    crudActions.push(...legacyCrud)
  }

  return { crudActions, nonCrudActions }
}

/**
 * Validate CRUD actions against entity schemas and populate the trace.
 * Returns the valid subset; invalid actions are logged to trace.errors.
 */
export function validateAndTraceCrud(
  crudActions: CrudAction[],
  entities: Record<string, EntityConfig>,
  trace: TurnTrace,
): CrudAction[] | undefined {
  if (crudActions.length === 0) return undefined

  // If crud actions were emitted but no entities are declared, that's a
  // config bug the AI can't recover from. Surface loudly — don't silently
  // drop the actions (previous behavior was returning undefined, which
  // hid the whole set from the trace).
  if (!entities || Object.keys(entities).length === 0) {
    for (const action of crudActions) {
      const error = `No entities declared in persona config — cannot route ${action.operation} ${action.entity}`
      trace.crudActions.push({
        operation: action.operation,
        entity: action.entity,
        id: action.id,
        params: (action.params ?? {}) as Record<string, unknown>,
        status: 'invalid',
        error,
      })
      trace.errors.push(`CRUD validation failed: ${error}`)
    }
    console.warn(`[archetype] ${crudActions.length} CRUD action(s) rejected — no entities declared in persona config`)
    return undefined
  }

  const validation = validateCrudActions(crudActions, entities)
  for (const valid of validation.valid) {
    trace.crudActions.push({ operation: valid.operation, entity: valid.entity, id: valid.id, params: valid.params ?? {}, status: 'valid' })
  }
  for (const inv of validation.invalid) {
    trace.crudActions.push({ operation: inv.action.operation, entity: inv.action.entity, id: inv.action.id, params: inv.action.params ?? {}, status: 'invalid', error: inv.error })
    trace.errors.push(`CRUD validation failed: ${inv.action.operation} ${inv.action.entity} — ${inv.error}`)
  }
  if (validation.invalid.length > 0) {
    console.warn(
      `[archetype] ${validation.invalid.length} CRUD action(s) failed validation:`,
      validation.invalid.map(i => `${i.action.operation} ${i.action.entity}: ${i.error}`).join(' | '),
    )
  }
  return validation.valid.length > 0 ? validation.valid : undefined
}

/**
 * Resolve temp IDs (prefixed with `_`) to real UUIDs.
 * The AI generates `_w1`, `_ex1` etc. as cross-reference handles within a single response.
 * This replaces them with permanent UUIDs before handlers see them.
 *
 * Resolves both `action.id` on creates and any string param values that match a temp ID.
 */
export function resolveTempIds(actions: CrudAction[]): CrudAction[] {
  const map = new Map<string, string>()

  // First pass: generate real IDs for all creates with _ prefix
  for (const action of actions) {
    if (action.operation === 'create' && action.id?.startsWith('_')) {
      map.set(action.id, crypto.randomUUID())
    }
  }

  if (map.size === 0) return actions

  // Second pass: resolve all references (action.id + param values)
  return actions.map(action => {
    const id = action.id && map.has(action.id) ? map.get(action.id)! : action.id
    const params = action.params ? resolveParamRefs(action.params, map) : action.params
    return { ...action, id, params }
  })
}

function resolveParamRefs(params: Record<string, unknown>, map: Map<string, string>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && map.has(value)) {
      resolved[key] = map.get(value)!
    } else {
      resolved[key] = value
    }
  }
  return resolved
}

// ─── commitCrud: the firewall commit gate ──────────────────────────────────

export interface CrudEntityHandler {
  create?: (id: string, params: Record<string, unknown>) => Promise<CrudCommitResult>
  update?: (id: string, params: Record<string, unknown>) => Promise<CrudCommitResult>
  delete?: (id: string) => Promise<CrudCommitResult>
}

export interface CrudCommitResult {
  success: boolean
  error?: string
  data?: unknown
}

/**
 * Execute validated CRUD actions through entity-keyed handlers.
 * This is the commit gate — the app calls this when ready to persist.
 *
 * Actions should be pre-validated (validateCrudActions) and temp-ID-resolved
 * (resolveTempIds) before calling commitCrud.
 *
 * If a trace is provided, populates trace.domainActions with timing and status.
 */
export async function commitCrud(
  actions: CrudAction[],
  handlers: Record<string, CrudEntityHandler>,
  options?: { trace?: TurnTrace },
): Promise<CrudCommitResult[]> {
  const results: CrudCommitResult[] = []

  for (const action of actions) {
    const start = Date.now()
    const label = `${action.operation}_${action.entity}`
    const entityHandler = handlers[action.entity]

    if (!entityHandler) {
      const result = { success: false, error: `No handler for entity: ${action.entity}` }
      results.push(result)
      if (options?.trace) {
        options.trace.domainActions.push({ name: label, params: action.params ?? {}, status: 'failed', error: result.error, durationMs: Date.now() - start })
      }
      continue
    }

    const opHandler = entityHandler[action.operation]
    if (!opHandler) {
      const result = { success: false, error: `No ${action.operation} handler for entity: ${action.entity}` }
      results.push(result)
      if (options?.trace) {
        options.trace.domainActions.push({ name: label, params: action.params ?? {}, status: 'failed', error: result.error, durationMs: Date.now() - start })
      }
      continue
    }

    try {
      let result: CrudCommitResult
      if (action.operation === 'delete') {
        result = await (opHandler as (id: string) => Promise<CrudCommitResult>)(action.id!)
      } else {
        result = await (opHandler as (id: string, params: Record<string, unknown>) => Promise<CrudCommitResult>)(action.id!, action.params ?? {})
      }
      results.push(result)
      if (options?.trace) {
        options.trace.domainActions.push({
          name: label, params: action.params ?? {},
          status: result.success ? 'executed' : 'failed',
          error: result.error, durationMs: Date.now() - start,
        })
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      results.push({ success: false, error })
      if (options?.trace) {
        options.trace.domainActions.push({ name: label, params: action.params ?? {}, status: 'failed', error, durationMs: Date.now() - start })
      }
    }
  }

  return results
}
