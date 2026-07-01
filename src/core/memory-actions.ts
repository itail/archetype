import { z } from 'zod'
import type { ActionDefinition, EntityConfig } from '../types.js'

const DEFAULT_CATEGORIES = 'approach | commitment | pattern | context | preference | values | general'

/**
 * Build the category description string for the saveMemory action schema.
 * When custom categories are defined, lists them with descriptions.
 */
export function buildCategoryDescription(categories?: Record<string, string>): string {
  if (!categories || Object.keys(categories).length === 0) {
    return `Category: ${DEFAULT_CATEGORIES}`
  }
  const entries = Object.entries(categories)
    .map(([name, desc]) => `${name} (${desc})`)
    .join(' | ')
  return `Category: ${entries}`
}

/**
 * Built-in legacy memory actions.
 * Archetype's foundation path is CRUD-native memory entities.
 * These named actions remain available for older integrations that still
 * expose memory as named actions instead of entities.
 */
export const MEMORY_ACTIONS: Record<string, ActionDefinition> = {
  saveMemory: {
    description: 'Save a new durable insight about the user that you want to remember across future conversations.',
    schema: z.object({
      content: z.string().describe('The insight to remember — single concise sentence'),
      category: z.string().describe(`Category: ${DEFAULT_CATEGORIES}`),
      source: z.enum(['user', 'inferred', 'suggested']).optional().describe('Optional: where this memory comes from. Use "user" when they explicitly said it, "inferred" when you noticed a pattern, "suggested" when this is an agent-proposed idea not clearly adopted yet.'),
      stability: z.enum(['durable', 'tentative', 'temporary']).optional().describe('Time horizon: "durable" for reliable truths, "tentative" for still-forming patterns, "temporary" for situation-bound facts.'),
      contextHint: z.string().optional().describe('Optional: a very short situational frame when needed to keep the memory interpretable later. Not a transcript.'),
    }),
    confidence: 'low',
  },
  updateMemory: {
    description: 'Update an existing memory by ID when information has changed or evolved. Reference the (id:xxx) from the MEMORY section.',
    schema: z.object({
      id: z.string().describe('The memory ID to update (from the MEMORY section)'),
      content: z.string().optional().describe('The updated content'),
      category: z.string().optional().describe(`Category: ${DEFAULT_CATEGORIES}`),
      source: z.enum(['user', 'inferred', 'suggested']).optional(),
      stability: z.enum(['durable', 'tentative', 'temporary']).optional(),
      contextHint: z.string().optional(),
    }),
    confidence: 'low',
  },
  deleteMemory: {
    description: 'Delete a memory that is no longer accurate or relevant. Reference the (id:xxx) from the MEMORY section.',
    schema: z.object({
      id: z.string().describe('The memory ID to delete (from the MEMORY section)'),
    }),
    confidence: 'low',
  },
}

/**
 * Build memory actions with custom category descriptions.
 * Returns the default MEMORY_ACTIONS when no custom categories are defined.
 */
export function buildMemoryActions(categories?: Record<string, string>): Record<string, ActionDefinition> {
  if (!categories || Object.keys(categories).length === 0) {
    return MEMORY_ACTIONS
  }

  return {
    ...MEMORY_ACTIONS,
    saveMemory: {
      ...MEMORY_ACTIONS.saveMemory,
      schema: z.object({
        content: z.string().describe('The insight to remember — single concise sentence'),
        category: z.string().describe(buildCategoryDescription(categories)),
        source: z.enum(['user', 'inferred', 'suggested']).optional().describe('Optional: where this memory comes from.'),
        stability: z.enum(['durable', 'tentative', 'temporary']).optional().describe('Optional: how strongly this memory should shape future judgment.'),
        contextHint: z.string().optional().describe('Optional: compact situational frame when the memory needs context to stay interpretable later.'),
      }),
    },
  }
}

/** Action names that are built-in memory actions (for auto-handling in managed mode) */
export const MEMORY_ACTION_NAMES = new Set(Object.keys(MEMORY_ACTIONS))

// ─── Craft Memory Actions ───────────────────────────────────────────────────

const DEFAULT_CRAFT_CATEGORIES = 'approach | timing | pattern | insight | general'

function buildCraftCategoryDescription(categories?: Record<string, string>): string {
  if (!categories || Object.keys(categories).length === 0) {
    return `Category: ${DEFAULT_CRAFT_CATEGORIES}`
  }
  const entries = Object.entries(categories)
    .map(([name, desc]) => `${name} (${desc})`)
    .join(' | ')
  return `Category: ${entries}`
}

export const CRAFT_MEMORY_ACTIONS: Record<string, ActionDefinition> = {
  saveCraftMemory: {
    description: 'Save a professional growth observation — something you learned about your own craft that would make you better across all future conversations.',
    schema: z.object({
      content: z.string().describe('The craft observation — a concise, transferable insight'),
      category: z.string().describe(`Category: ${DEFAULT_CRAFT_CATEGORIES}`),
      source: z.enum(['user', 'inferred', 'suggested']).optional().describe('Optional: where this craft observation came from. Usually "inferred".'),
      stability: z.enum(['durable', 'tentative', 'temporary']).optional().describe('Time horizon: "durable" for reliable practice-level patterns, "tentative" for still-forming observations, "temporary" for observations tied to a specific moment or phase.'),
      contextHint: z.string().optional().describe('Optional: very short situational frame when needed to keep the observation honest.'),
    }),
    confidence: 'low',
  },
  updateCraftMemory: {
    description: 'Update an existing craft memory by ID when the observation has evolved or sharpened. Reference the (id:xxx) from the CRAFT MEMORY section.',
    schema: z.object({
      id: z.string().describe('The craft memory ID to update'),
      content: z.string().optional().describe('The updated observation'),
      category: z.string().optional().describe(`Category: ${DEFAULT_CRAFT_CATEGORIES}`),
      source: z.enum(['user', 'inferred', 'suggested']).optional(),
      stability: z.enum(['durable', 'tentative', 'temporary']).optional(),
      contextHint: z.string().optional(),
    }),
    confidence: 'low',
  },
  deleteCraftMemory: {
    description: 'Delete a craft memory that turned out to be situational noise, not a real pattern. Reference the (id:xxx) from the CRAFT MEMORY section.',
    schema: z.object({
      id: z.string().describe('The craft memory ID to delete'),
    }),
    confidence: 'low',
  },
}

/**
 * Build craft memory actions with custom category descriptions.
 */
export function buildCraftMemoryActions(categories?: Record<string, string>): Record<string, ActionDefinition> {
  if (!categories || Object.keys(categories).length === 0) {
    return CRAFT_MEMORY_ACTIONS
  }

  return {
    ...CRAFT_MEMORY_ACTIONS,
    saveCraftMemory: {
      ...CRAFT_MEMORY_ACTIONS.saveCraftMemory,
      schema: z.object({
        content: z.string().describe('The craft observation — a concise, transferable insight'),
        category: z.string().describe(buildCraftCategoryDescription(categories)),
        source: z.enum(['user', 'inferred', 'suggested']).optional().describe('Optional: where this craft observation came from.'),
        stability: z.enum(['durable', 'tentative', 'temporary']).optional().describe('Optional: how strongly this observation should shape your practice.'),
        contextHint: z.string().optional().describe('Optional: compact situational frame when needed.'),
      }),
    },
  }
}

/** Action names that are built-in craft memory actions */
export const CRAFT_MEMORY_ACTION_NAMES = new Set(Object.keys(CRAFT_MEMORY_ACTIONS))

// ─── Entity schemas for memory CRUD ────────────────────────────────────────

/**
 * Build a memory entity config for the generic CRUD system.
 * Memory is registered as an internal entity when memory is enabled so
 * durable memory mutations flow through CRUD.
 */
export function buildMemoryEntityConfig(categories?: Record<string, string>): EntityConfig {
  return {
    schema: z.object({
      content: z.string().describe('The insight to remember — single concise sentence'),
      category: z.string().describe(buildCategoryDescription(categories)),
      source: z.enum(['user', 'inferred', 'suggested']).optional().describe('Optional: where this memory came from.'),
      stability: z.enum(['durable', 'tentative', 'temporary']).optional().describe('Optional: how strongly this memory should shape future judgment.'),
      contextHint: z.string().optional().describe('Optional: a compact situational frame when the memory needs context to stay interpretable later.'),
    }),
    label: 'Memory',
    displayField: 'content',
    description: 'Durable insights about the user worth remembering across future conversations',
  }
}

/**
 * Build a craft memory entity config for the generic CRUD system.
 */
export function buildCraftMemoryEntityConfig(categories?: Record<string, string>): EntityConfig {
  return {
    schema: z.object({
      content: z.string().describe('The craft observation — a concise, transferable insight'),
      category: z.string().describe(buildCraftCategoryDescription(categories)),
      source: z.enum(['user', 'inferred', 'suggested']).optional().describe('Optional: where this craft observation came from.'),
      stability: z.enum(['durable', 'tentative', 'temporary']).optional().describe('Optional: how strongly this observation should shape your practice.'),
      contextHint: z.string().optional().describe('Optional: compact situational frame when needed.'),
    }),
    label: 'Craft Memory',
    displayField: 'content',
    description: 'Professional growth observations about your own craft — transferable across all users',
  }
}
