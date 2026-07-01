/**
 * Config versioning — deterministic hash of the persona config fields
 * that affect the assembled prompt.
 *
 * Used by the audit system to tag results. When the config changes,
 * the version changes, and previous audit results are stale.
 */

import { createHash } from 'node:crypto'
import type { PersonaConfig } from '../types.js'
import { resolvePersonaConfigBrain } from '../brain.js'

/**
 * Derive a version hash from the prompt-affecting parts of a PersonaConfig.
 * Returns a truncated hex string (first 12 chars of SHA-256).
 */
export function configVersion(config: PersonaConfig): string {
  const resolvedConfig = resolvePersonaConfigBrain(config)
  const relevant = {
    identity: resolvedConfig.identity,
    voice: resolvedConfig.voice,
    brain: resolvedConfig.brain ? serializeBrain(resolvedConfig.brain) : undefined,
    methodology: resolvedConfig.methodology,
    directives: resolvedConfig.directives,
    actions: resolvedConfig.actions ? serializeActions(resolvedConfig.actions) : undefined,
    contextInputs: resolvedConfig.contextInputs,
    eq: resolvedConfig.eq,
    memory: resolvedConfig.memory ? { ...resolvedConfig.memory } : undefined,
    craftMemory: resolvedConfig.craftMemory ? { ...resolvedConfig.craftMemory } : undefined,
  }

  const json = JSON.stringify(sortValue(relevant))
  return createHash('sha256').update(json).digest('hex').slice(0, 12)
}

function serializeBrain(brain: NonNullable<PersonaConfig['brain']>): { metadata?: Record<string, string>; sections?: Record<string, string>; markdown?: string } {
  if (brain.source !== 'loaded') {
    return { markdown: JSON.stringify(brain) }
  }
  return {
    metadata: brain.metadata,
    sections: brain.sections,
  }
}

/**
 * Serialize action definitions to a stable representation.
 * Zod schemas aren't JSON-serializable, so we extract the description + confidence.
 */
function serializeActions(actions: Record<string, any>): Record<string, { description: string; confidence: string }> {
  const result: Record<string, { description: string; confidence: string }> = {}
  for (const [name, def] of Object.entries(actions)) {
    result[name] = {
      description: def.description ?? '',
      confidence: def.confidence ?? 'medium',
    }
  }
  return result
}

function sortValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => sortValue(item)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, sortValue((value as Record<string, unknown>)[key])]),
    ) as T
  }
  return value
}
