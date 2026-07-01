/**
 * Entity visibility auditor — single job: verify the AI will actually be shown
 * a record with an id it can target for update/delete on every entity that
 * declares CRUD beyond create.
 *
 * The bug class: a persona declares an entity with full CRUD (create / update /
 * delete), but no record carrying an id reaches the prompt. At chat time the
 * AI has nothing to target — so when the user says "switch to maintenance and
 * set 2300 calories," the AI can't address profile or dailyTargets and
 * quietly falls back to saving a memory instead. Guardrails score the failure,
 * the judge never sees the cause, and the fix — populating a record with an
 * id at the right surface — is invisible at code review.
 *
 * Two surfaces carry records to the AI, and this audit checks both:
 *
 *   1. DOMAIN ENTITIES → via contextInputs. Only keys declared in
 *      `config.contextInputs` get serialized (src/core/context.ts); undeclared
 *      keys are silently dropped. Required predicate:
 *        declared contextInput at K
 *          ∧ runtime context[K] has a record with a non-empty `id` string
 *          ∧ K is an idiomatic name for this entity
 *
 *   2. MEMORY / CRAFT MEMORY → via their dedicated prompt blocks
 *      (src/core/memory.ts, src/core/prompt-builder.ts). `memory` defaults
 *      to includeIds=false, so the AI sees content without ids unless the
 *      persona explicitly opts in. `craftMemory` hardcodes includeIds=true,
 *      so the only concern is whether the block renders at all (requires
 *      craftMemory.enabled AND craftMemories provided).
 *
 * Anything else is a latent bug. The audit answers one question per entity
 * and fails loudly. It does NOT audit entity quality, description prose, or
 * field schemas — those belong to auditActionContracts.
 *
 * Not a runtime check — it runs against a representative context the app
 * would pass to chat() (a fixture, a live callsite shape, or an integration
 * harness's sample payload).
 */
import { allowedOperations } from '../core/entity-helpers.js'
import type { PersonaConfig, Memory } from '../types.js'

export interface EntityVisibilityAuditInput {
  config: PersonaConfig
  /** A representative context the app passes to chat() — typically the fixture or live callsite shape */
  context: Record<string, unknown>
  /** Memories the caller would pass to chat() — needed to verify memory visibility */
  memories?: Memory[]
  /** Craft memories the caller would pass to chat() — needed to verify craftMemory visibility */
  craftMemories?: Memory[]
}

export interface EntityVisibilityIssue {
  severity: 'error'
  entity: string
  principle: 'not-visible-in-context'
  message: string
  suggestion: string
}

export interface EntityVisibilityResult {
  pass: boolean
  issues: EntityVisibilityIssue[]
  /** Per-entity verdict so callers can see which passed, which didn't, and how. */
  perEntity: Record<string, { visible: boolean; how: string | null }>
}

export function auditEntityVisibility(
  input: EntityVisibilityAuditInput,
): EntityVisibilityResult {
  const issues: EntityVisibilityIssue[] = []
  const perEntity: Record<string, { visible: boolean; how: string | null }> = {}

  const entities = input.config.entities ?? {}
  const contextInputs = input.config.contextInputs ?? {}

  for (const [name, entity] of Object.entries(entities)) {
    const ops = allowedOperations(entity)
    if (!ops.includes('update') && !ops.includes('delete')) {
      perEntity[name] = { visible: true, how: 'create-only operations (update/delete not expected)' }
      continue
    }

    const visibility = name === 'memory'
      ? checkMemoryVisibility(input.config, input.memories ?? [])
      : name === 'craftMemory'
      ? checkCraftMemoryVisibility(input.config, input.craftMemories ?? [])
      : findVisibility(name, input.context, contextInputs)

    perEntity[name] = visibility

    if (!visibility.visible) {
      issues.push({
        severity: 'error',
        entity: name,
        principle: 'not-visible-in-context',
        message: visibilityFailureMessage(name, input.config, input.memories, input.craftMemories),
        suggestion: visibilityFailureSuggestion(name),
      })
    }
  }

  return {
    pass: issues.length === 0,
    issues,
    perEntity,
  }
}

// ─── Memory / craftMemory visibility ────────────────────────────────────────
// Memory records reach the prompt via a dedicated block, not contextInputs.
// See src/core/memory.ts (selectMemoriesForPrompt) and src/core/prompt-builder.ts.
//
// memory:      includeIds is caller-chosen, defaults FALSE. If memory is
//              declared as an updatable entity but config.memory.includeIds
//              isn't true, memories render without ids and the AI can't
//              target them.
// craftMemory: includeIds is hardcoded TRUE inside the craftMemory block.
//              Visibility depends on the block rendering at all, which
//              requires config.craftMemory.enabled AND craftMemories provided.

function checkMemoryVisibility(
  config: PersonaConfig,
  memories: Memory[],
): { visible: boolean; how: string | null } {
  const includeIds = config.memory?.includeIds === true
  const hasMemoryWithId = memories.some(isMemoryWithId)
  if (!includeIds || !hasMemoryWithId) return { visible: false, how: null }
  return { visible: true, how: 'MEMORY block (memory.includeIds=true, memories provided)' }
}

function checkCraftMemoryVisibility(
  config: PersonaConfig,
  craftMemories: Memory[],
): { visible: boolean; how: string | null } {
  const enabled = config.craftMemory?.enabled === true
  const hasCraftWithId = craftMemories.some(isMemoryWithId)
  if (!enabled || !hasCraftWithId) return { visible: false, how: null }
  return { visible: true, how: 'CRAFT MEMORY block (craftMemory.enabled=true, craftMemories provided, includeIds is hardcoded on)' }
}

function isMemoryWithId(memory: Memory): boolean {
  return typeof memory?.id === 'string' && memory.id.length > 0
}

function visibilityFailureMessage(
  name: string,
  config: PersonaConfig,
  memories?: Memory[],
  craftMemories?: Memory[],
): string {
  if (name === 'memory') {
    if (config.memory?.includeIds !== true) {
      return 'Entity "memory" is declared as updatable but config.memory.includeIds is not true — the MEMORY block renders without ids, so the AI has nothing to target for update or delete.'
    }
    if (!memories || memories.length === 0) {
      return 'Entity "memory" is declared as updatable but no memories were provided to the audit — the MEMORY block will be empty, giving the AI no records to target.'
    }
    return 'Entity "memory" is declared as updatable but the provided memories lack non-empty string ids.'
  }
  if (name === 'craftMemory') {
    if (config.craftMemory?.enabled !== true) {
      return 'Entity "craftMemory" is declared but config.craftMemory.enabled is not true — the CRAFT MEMORY block never renders.'
    }
    if (!craftMemories || craftMemories.length === 0) {
      return 'Entity "craftMemory" is declared as updatable but no craftMemories were provided to the audit — the CRAFT MEMORY block will be empty, giving the AI no records to target.'
    }
    return 'Entity "craftMemory" is declared as updatable but the provided craftMemories lack non-empty string ids.'
  }
  return `Entity "${name}" is declared as updatable but no record with an id reaches the prompt — the AI has nothing to target for update or delete.`
}

function visibilityFailureSuggestion(name: string): string {
  if (name === 'memory') {
    return 'Set memory.includeIds: true in the persona config and ensure memories are provided at chat time. If memory is only ever created (never updated or deleted), set createOnly: true on the memory entity config.'
  }
  if (name === 'craftMemory') {
    return 'Set craftMemory.enabled: true in the persona config and ensure craftMemories are provided at chat time. If craftMemory is only ever created, set createOnly: true on the entity config.'
  }
  return `Declare a contextInput whose key matches "${name}" (or its plural) AND populate the runtime context at that key with record(s) carrying a non-empty string id. If this entity is only ever created, set createOnly: true on the entity config.`
}

// ─── Domain entity visibility detection ─────────────────────────────────────
//
// For each entity, walk the conventional key names in priority order. A key
// makes an entity visible only when BOTH:
//   1. `config.contextInputs[key]` is declared — without this the SDK skips
//      the block entirely and no id reaches the prompt.
//   2. `context[key]` holds at least one record with a non-empty `id` string.
//
// We intentionally don't accept arbitrary contextInput keys (e.g., a
// contextInput called `userSettings` carrying profile records). Conventional
// naming is enforceable and keeps the audit's answer unambiguous. Developers
// with exotic plumbing can rename or set `createOnly: true`.

function findVisibility(
  entityName: string,
  context: Record<string, unknown>,
  contextInputs: Record<string, unknown>,
): { visible: boolean; how: string | null } {
  for (const key of Object.keys(contextInputs)) {
    if (!keyMatchesEntity(key, entityName)) continue
    if (!hasRecordWithId(context[key])) continue
    return { visible: true, how: `context.${key} (via contextInputs.${key})` }
  }

  return { visible: false, how: null }
}

function hasRecordWithId(value: unknown): boolean {
  if (value == null) return false
  if (Array.isArray(value)) {
    return value.some(isObjectWithId)
  }
  if (typeof value === 'object') {
    return isObjectWithId(value)
  }
  return false
}

function isObjectWithId(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0
}

// Match a contextInput key to an entity via three idiomatic conventions:
//   1. Explicit suffix:        profile / profiles / profileRecord / profileRecords
//   2. Pure plural:            threads / forcingFunctions / coachingNotes
//   3. Semantic prefix + plural: openTasks / recentWorkouts / recentMistakes
// The "semantic prefix" convention is pervasive in real personas — the prefix
// names the subset of records being surfaced (open, recent, active, etc.).
// The rule: tokenize the key in camelCase; the LAST token, lowercased, must
// equal the entity's last token (as-is or naively pluralized).

function keyMatchesEntity(key: string, entityName: string): boolean {
  const k = key.toLowerCase()
  const n = entityName.toLowerCase()

  if (k === n) return true
  if (k === `${n}s`) return true
  if (k === `${n}record`) return true
  if (k === `${n}records`) return true

  const keyTokens = tokenize(key)
  const entityTokens = tokenize(entityName)
  if (keyTokens.length === 0 || entityTokens.length === 0) return false

  const lastKey = keyTokens[keyTokens.length - 1]
  const lastEntity = entityTokens[entityTokens.length - 1]

  if (lastKey === lastEntity) return true
  if (lastKey === naivePluralize(lastEntity)) return true

  return false
}

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
}

function naivePluralize(word: string): string {
  if (word.endsWith('y') && !/[aeiou]y$/.test(word)) {
    return word.slice(0, -1) + 'ies'
  }
  if (/(?:s|x|z|ch|sh)$/.test(word)) {
    return word + 'es'
  }
  return word + 's'
}
