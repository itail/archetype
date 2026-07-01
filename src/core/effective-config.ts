import type { PersonaConfig, EntityConfig } from '../types.js'
import { buildMemoryEntityConfig, buildCraftMemoryEntityConfig } from './memory-actions.js'

/**
 * Resolve the effective actions for a persona.
 * Memory actions are no longer merged here — they flow through the entity CRUD system.
 */
export function resolveActions(config: PersonaConfig): Record<string, import('../types.js').ActionDefinition> | undefined {
  const actions = config.actions ? { ...config.actions } : {}
  return Object.keys(actions).length > 0 ? actions : undefined
}

/**
 * Resolve the effective entities for a persona, including internal memory entities
 * when memory.enabled or craftMemory.enabled are set.
 */
export function resolveEntities(config: PersonaConfig): Record<string, EntityConfig> | undefined {
  const entities = { ...(config.entities ?? {}) }
  if (config.memory?.enabled) {
    entities.memory = buildMemoryEntityConfig(config.memory.categories)
  }
  if (config.craftMemory?.enabled) {
    entities.craftMemory = buildCraftMemoryEntityConfig(config.craftMemory.categories)
  }
  return Object.keys(entities).length > 0 ? entities : undefined
}

export function resolveEffectiveConfig(config: PersonaConfig): PersonaConfig {
  const actions = resolveActions(config)
  const entities = resolveEntities(config)
  return {
    ...config,
    ...(actions !== config.actions ? { actions } : {}),
    ...(entities !== config.entities ? { entities } : {}),
  }
}
