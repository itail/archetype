import { z } from 'zod'
import type { ActionDefinition, ActionConfidence, ContextInputDefinition, ContextFormat } from '../types.js'

// ─── Entity definition ──────────────────────────────────────────────────────

export interface EntityOperationConfig {
  confidence: ActionConfidence
  /** Override the auto-generated action description */
  description?: string
}

export type CrudOperationName = 'create' | 'update' | 'delete'

export type CrudConfigInput =
  | ActionConfidence
  | Partial<Record<CrudOperationName, ActionConfidence>>

export interface EntityDefinitionInput {
  /** Entity name in singular form (e.g., 'thread', 'meal', 'document') */
  name: string
  /** Zod schema for entity fields */
  schema: z.ZodObject<z.ZodRawShape>
  /** Human-readable entity name (e.g. "Thread", "Forcing Function"). Defaults to capitalize(name). */
  label?: string
  /** Which field in params to use as display title (e.g. "title", "what", "cueText") */
  displayField?: string
  /** How to display entities in the prompt */
  contextFormat?: ContextFormat
  /** Character budget for the context block */
  contextBudget?: number
  /** Context priority level */
  contextPriority?: 'normal' | 'critical'
  /** Which CRUD operations the AI can perform */
  operations: {
    create?: EntityOperationConfig
    update?: EntityOperationConfig
    delete?: EntityOperationConfig
  }
}

export interface EntityDefinitionResult {
  /** Generated ActionDefinitions for the entity's CRUD operations */
  actions: Record<string, ActionDefinition>
  /** Generated ContextInputDefinition for prompt injection */
  contextInput: ContextInputDefinition
  /** Human-readable entity name (resolved: input.label ?? capitalize(name)) */
  label: string
  /** Which field in params to use as display title */
  displayField?: string
}

/**
 * Convenience helper for common CRUD entities.
 * Note: most apps now use `entities` on PersonaConfig directly. This utility
 * is still available for advanced integrations that need manual wiring.
 *
 * Examples:
 * ```ts
 * operations: crud('medium')
 * operations: crud({ create: 'low', update: 'medium', delete: 'high' })
 * operations: crud(
 *   { create: 'low', update: 'medium', delete: 'medium' },
 *   { update: 'Prefer updating existing tasks over duplicates.' },
 * )
 * ```
 */
export function crud(
  config: CrudConfigInput = 'medium',
  descriptions: Partial<Record<CrudOperationName, string>> = {},
): EntityDefinitionInput['operations'] {
  const confidences = typeof config === 'string'
    ? { create: config, update: config, delete: config }
    : config

  const operations: EntityDefinitionInput['operations'] = {}

  for (const op of ['create', 'update', 'delete'] as const) {
    const confidence = confidences[op]
    if (!confidence) continue
    operations[op] = {
      confidence,
      ...(descriptions[op] ? { description: descriptions[op] } : {}),
    }
  }

  return operations
}

/**
 * Define a domain entity and get auto-generated action definitions + context input.
 *
 * Note: most apps now declare entities via `entities` on PersonaConfig, which
 * handles prompt generation and response schema automatically. This function
 * is available for advanced integrations that need manual action wiring.
 *
 * Eliminates CRUD boilerplate: instead of manually writing Zod schemas for
 * createThread, updateThread, deleteThread actions + a context input definition,
 * declare the entity once and get everything generated.
 *
 * Example:
 * ```typescript
 * const threadEntity = defineEntity({
 *   name: 'thread',
 *   schema: z.object({ title: z.string(), status: z.string(), owner: z.string() }),
 *   contextFormat: 'list',
 *   operations: {
 *     update: { confidence: 'high' },   // CEO must approve
 *   },
 * })
 * ```
 */
export function defineEntity(input: EntityDefinitionInput): EntityDefinitionResult {
  const { name, schema, operations } = input
  const Name = capitalize(name)
  const actions: Record<string, ActionDefinition> = {}

  // Determine if update/delete exist (they need IDs)
  const hasUpdate = !!operations.update
  const hasDelete = !!operations.delete
  const needsIds = hasUpdate || hasDelete

  // Create action
  if (operations.create) {
    const actionName = `create${Name}`
    actions[actionName] = {
      description: operations.create.description
        ?? `Create a new ${name}. Use when a new ${name} needs to be tracked.`,
      schema: schema,
      confidence: operations.create.confidence,
    }
  }

  // Update action — takes id + partial fields
  if (operations.update) {
    const actionName = `update${Name}`
    actions[actionName] = {
      description: operations.update.description
        ?? `Update an existing ${name} by ID. Reference the (id:xxx) from the ${name.toUpperCase()}S context.`,
      schema: z.object({
        id: z.string().describe(`The ${name} ID to update`),
        updates: schema.partial().describe(`Fields to update on the ${name}`),
      }),
      confidence: operations.update.confidence,
    }
  }

  // Delete action
  if (operations.delete) {
    const actionName = `delete${Name}`
    actions[actionName] = {
      description: operations.delete.description
        ?? `Delete a ${name} by ID. Reference the (id:xxx) from the ${name.toUpperCase()}S context.`,
      schema: z.object({
        id: z.string().describe(`The ${name} ID to delete`),
      }),
      confidence: operations.delete.confidence,
    }
  }

  // Context input definition
  const contextInput: ContextInputDefinition = {
    label: `${name.toUpperCase()}S`,
    format: input.contextFormat ?? 'list',
    ...(input.contextBudget ? { budget: input.contextBudget } : {}),
    ...(input.contextPriority ? { priority: input.contextPriority } : {}),
    // Entities with update/delete need IDs in the context
    ...(needsIds ? { includeIds: true } as Record<string, unknown> : {}),
  }

  // Resolve entity metadata
  const label = input.label ?? Name
  const displayField = input.displayField

  return { actions, contextInput, label, displayField }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
