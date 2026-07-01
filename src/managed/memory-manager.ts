import type { StorageAdapter, Memory } from '../types.js'
const PROMPT_MEMORY_LOAD_BUDGET_MULTIPLIER = 3
const PROMPT_MEMORY_LOAD_BUDGET_MIN = 12000

/**
 * Load memories from storage adapter, formatted for prompt injection.
 */
export async function loadMemories(
  adapter: StorageAdapter,
  budget: number = 8000,
  pinnedFirst: boolean = true,
): Promise<Memory[]> {
  return adapter.loadMemories({
    // Adapters should return a candidate set, not the final prompt-trimmed slice.
    // We intentionally overfetch here so Archetype's salience-aware selection can
    // decide what survives the actual prompt budget.
    budget: expandPromptMemoryLoadBudget(budget),
    pinnedFirst,
  })
}

export function expandPromptMemoryLoadBudget(budget: number): number {
  return Math.max(
    Math.ceil(budget * PROMPT_MEMORY_LOAD_BUDGET_MULTIPLIER),
    PROMPT_MEMORY_LOAD_BUDGET_MIN,
  )
}
