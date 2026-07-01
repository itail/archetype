import type { ParsedAction } from '../types.js'
import type { EntityRegistry } from './entity-registry.js'

// ─── Action Name Parsing ────────────────────────────────────────────────────

/**
 * Parse a camelCase action name into verb + entityName.
 *
 * 'createThread'  → { verb: 'create', entityName: 'thread' }
 * 'updateFf'      → { verb: 'update', entityName: 'ff' }
 * 'saveMemory'    → { verb: 'save', entityName: 'memory' }
 * 'deleteExecNote' → { verb: 'delete', entityName: 'execNote' }
 * 'random'        → null
 */
export function parseActionName(name: string): { verb: string; entityName: string } | null {
  const m = name.match(/^(create|update|delete|save)([A-Z]\w*)$/)
  if (!m) return null
  return { verb: m[1], entityName: m[2].charAt(0).toLowerCase() + m[2].slice(1) }
}

// ─── Action Label ───────────────────────────────────────────────────────────

const VERB_LABELS: Record<string, string> = {
  create: 'Add',
  save: 'Add',
  update: 'Update',
  delete: 'Delete',
}

/**
 * Human-readable label for an action, using entity metadata from the registry.
 *
 * 'createThread' + registry → "Add Thread"
 * 'deleteFf'    + registry → "Delete Forcing Function"
 *
 * Falls back to capitalize(entityName) if the entity isn't in the registry.
 */
export function actionLabel(actionName: string, registry: EntityRegistry): string {
  const parsed = parseActionName(actionName)
  if (!parsed) return actionName

  const verbLabel = VERB_LABELS[parsed.verb] ?? capitalize(parsed.verb)
  const entity = registry.getEntityForAction(actionName)
  const entityLabel = entity?.label ?? capitalize(parsed.entityName)

  return `${verbLabel} ${entityLabel}`
}

// ─── Display Title ──────────────────────────────────────────────────────────

/**
 * Extract a display title from an action's params using the entity's displayField.
 *
 * For create actions: uses displayField to find the title in params.
 * For update actions: summarizes as "field: value" (or full updates object).
 * For delete actions: uses reason if present, falls back to id.
 *
 * Returns empty string if nothing meaningful can be extracted.
 */
export function getActionDisplayTitle(
  action: ParsedAction,
  registry: EntityRegistry,
  maxLength = 60,
): string {
  const parsed = parseActionName(action.name)
  if (!parsed) return ''

  const entity = registry.getEntityForAction(action.name)
  const p = action.params

  if (parsed.verb === 'create' || parsed.verb === 'save') {
    // Try displayField first
    if (entity?.displayField && p[entity.displayField] != null) {
      return truncate(String(p[entity.displayField]), maxLength)
    }
    // Fallback: try common field names
    for (const field of ['title', 'text', 'what', 'content', 'name']) {
      if (p[field] != null) return truncate(String(p[field]), maxLength)
    }
    return ''
  }

  if (parsed.verb === 'update') {
    // {id, field, value} shape (legacy pattern)
    if (p.field != null && p.value != null) {
      return truncate(`${p.field}: ${String(p.value)}`, maxLength)
    }
    // {id, updates: {...}} shape (archetype pattern)
    if (p.updates != null && typeof p.updates === 'object') {
      const updates = p.updates as Record<string, unknown>
      const keys = Object.keys(updates)
      if (keys.length === 1) {
        return truncate(`${keys[0]}: ${String(updates[keys[0]])}`, maxLength)
      }
      if (keys.length > 1) {
        return truncate(`${keys.join(', ')}`, maxLength)
      }
    }
    return ''
  }

  if (parsed.verb === 'delete') {
    if (p.reason != null) return truncate(String(p.reason), maxLength)
    return ''
  }

  return ''
}

// ─── Entity Check ───────────────────────────────────────────────────────────

/**
 * Check if an action targets a specific entity.
 *
 * isEntityAction('createThread', 'thread') → true
 * isEntityAction('updateFf', 'thread')     → false
 */
export function isEntityAction(actionName: string, entityName: string): boolean {
  const parsed = parseActionName(actionName)
  if (!parsed) return false
  return parsed.entityName === entityName
}

// ─── Internals ──────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** The operations an entity actually supports (operations > createOnly > all). */
export function allowedOperations(config: { createOnly?: boolean; operations?: ReadonlyArray<'create' | 'update' | 'delete'> }): ReadonlyArray<'create' | 'update' | 'delete'> {
  if (config.operations && config.operations.length > 0) return config.operations
  if (config.createOnly) return ['create']
  return ['create', 'update', 'delete']
}
