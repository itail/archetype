import type { ActionDefinition, ContextInputDefinition } from '../types.js'
import type { EntityDefinitionResult } from './entities.js'

// ─── Entity Registry ────────────────────────────────────────────────────────

export interface EntityRegistryEntry {
  name: string
  label: string
  displayField?: string
  actions: Record<string, ActionDefinition>
  contextInput: ContextInputDefinition
}

export interface EntityRegistry {
  /** All actions from all entities, merged */
  actions: Record<string, ActionDefinition>
  /** All context inputs from all entities, keyed by entity name */
  contextInputs: Record<string, ContextInputDefinition>
  /** Lookup: action name → entity metadata */
  getEntityForAction(actionName: string): { name: string; label: string; displayField?: string } | null
  /** All registered entity names */
  entityNames: string[]
  /** All registered entities (full metadata) */
  entities: EntityRegistryEntry[]
}

/**
 * Combine multiple defineEntity() results into a single registry.
 *
 * Provides the connective tissue between defineEntity() outputs and
 * action helpers — merged actions, context inputs, and action→entity lookup.
 *
 * Example:
 * ```typescript
 * const registry = buildEntityRegistry(
 *   { name: 'thread', ...threadEntity },
 *   { name: 'ff', ...ffEntity },
 *   { name: 'cue', ...cueEntity },
 * )
 *
 * registry.getEntityForAction('updateThread')
 * // → { name: 'thread', label: 'Thread', displayField: 'title' }
 * ```
 */
export function buildEntityRegistry(
  ...entries: Array<{ name: string } & EntityDefinitionResult>
): EntityRegistry {
  const allActions: Record<string, ActionDefinition> = {}
  const allContextInputs: Record<string, ContextInputDefinition> = {}
  const actionToEntity = new Map<string, EntityRegistryEntry>()
  const registryEntries: EntityRegistryEntry[] = []

  for (const entry of entries) {
    const registryEntry: EntityRegistryEntry = {
      name: entry.name,
      label: entry.label,
      displayField: entry.displayField,
      actions: entry.actions,
      contextInput: entry.contextInput,
    }
    registryEntries.push(registryEntry)

    // Merge actions
    for (const [actionName, actionDef] of Object.entries(entry.actions)) {
      allActions[actionName] = actionDef
      actionToEntity.set(actionName, registryEntry)
    }

    // Merge context inputs
    allContextInputs[entry.name] = entry.contextInput
  }

  return {
    actions: allActions,
    contextInputs: allContextInputs,
    entityNames: registryEntries.map(e => e.name),
    entities: registryEntries,
    getEntityForAction(actionName: string) {
      const entry = actionToEntity.get(actionName)
      if (!entry) return null
      return { name: entry.name, label: entry.label, displayField: entry.displayField }
    },
  }
}
