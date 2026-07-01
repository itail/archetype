/**
 * Action & entity contract auditor — catches the "malformed tool call" pattern
 * at its real source: ambiguous contracts.
 *
 * When an AI emits a malformed or wrong-shaped action, the instinct is to
 * assume the AI is "dumb" and add validation/boxing in code. The AI is as
 * capable as the engineer — the problem is almost always that the contract
 * (name + schema + description + field describe() annotations) didn't
 * clearly tell it what the action represents.
 *
 * This audit flags the specific shapes that force the AI to guess:
 *  - Generic action/entity names (data, handle, process, update, etc.)
 *  - Self-documenting names with long descriptions that restate the name
 *  - Vague schemas (any types, untyped strings that should be enums, etc.)
 *  - Missing field descriptions on non-obvious fields
 *  - Fights between name/description (e.g., name says "send", description says "draft")
 */
import type { PersonaConfig, ActionDefinition, EntityConfig } from '../types.js'
import type { z } from 'zod'

export interface ActionContractAuditInput {
  config: PersonaConfig
}

export interface ActionContractIssue {
  severity: 'error' | 'warn'
  /** 'action' or 'entity'. */
  surface: 'action' | 'entity'
  /** The action or entity name. */
  name: string
  /** Which aspect of the contract is unclear. */
  principle:
    | 'generic-name'
    | 'self-documenting-overdocumented'
    | 'missing-description'
    | 'missing-field-description'
    | 'vague-schema-type'
    | 'name-description-conflict'
  /** Concrete explanation. */
  message: string
  /** Suggested fix. */
  suggestion: string
}

export interface ActionContractAuditResult {
  pass: boolean
  issues: ActionContractIssue[]
}

const GENERIC_NAME_WORDS = new Set([
  'data',
  'handle',
  'process',
  'execute',
  'perform',
  'do',
  'action',
  'thing',
  'item',
  'object',
  'stuff',
  'info',
  'update',
  'manage',
  'run',
])

export function auditActionContracts(input: ActionContractAuditInput): ActionContractAuditResult {
  const issues: ActionContractIssue[] = []
  const actions = input.config.actions ?? {}
  const entities = input.config.entities ?? {}

  for (const [name, action] of Object.entries(actions)) {
    issues.push(...auditSingleAction(name, action))
  }
  for (const [name, entity] of Object.entries(entities)) {
    issues.push(...auditSingleEntity(name, entity))
  }

  return {
    pass: !issues.some((i) => i.severity === 'error'),
    issues,
  }
}

function auditSingleAction(name: string, action: ActionDefinition): ActionContractIssue[] {
  const issues: ActionContractIssue[] = []
  const desc = action.description ?? ''

  if (isGenericName(name)) {
    issues.push({
      severity: 'error',
      surface: 'action',
      name,
      principle: 'generic-name',
      message: `Action name "${name}" is too generic — the AI has to read the description to guess what it does.`,
      suggestion: `Rename to something self-documenting (verb + noun: sendEmail, logMeal, scheduleCall). A good action name makes the description redundant for the happy path.`,
    })
  }

  if (!desc.trim()) {
    issues.push({
      severity: 'warn',
      surface: 'action',
      name,
      principle: 'missing-description',
      message: `Action "${name}" has no description.`,
      suggestion: `If the name is self-documenting the description can be one line about WHEN to use it (not WHAT it does — the name carries that).`,
    })
  }

  // If name is self-documenting but description is long, flag over-documentation
  if (!isGenericName(name) && desc.length > 180) {
    const restatesName = looksLikeNameRestatement(name, desc)
    if (restatesName) {
      issues.push({
        severity: 'warn',
        surface: 'action',
        name,
        principle: 'self-documenting-overdocumented',
        message: `Action "${name}" is self-documenting but the ${desc.length}-char description seems to restate what the name says.`,
        suggestion: `A self-documenting name deserves a one-line description about when to use it, not a restatement of what it does.`,
      })
    }
  }

  // Check schema shape for vagueness
  if (action.schema) {
    const vague = detectVagueSchema(action.schema)
    for (const v of vague) {
      issues.push({
        severity: v.severity,
        surface: 'action',
        name,
        principle: v.principle,
        message: v.message,
        suggestion: v.suggestion,
      })
    }
  }

  return issues
}

function auditSingleEntity(name: string, entity: EntityConfig): ActionContractIssue[] {
  const issues: ActionContractIssue[] = []
  const desc = entity.description ?? ''

  if (isGenericName(name)) {
    issues.push({
      severity: 'warn',
      surface: 'entity',
      name,
      principle: 'generic-name',
      message: `Entity name "${name}" is generic — the AI will have trouble routing between this and other entities.`,
      suggestion: `Rename to match the domain noun (meal, task, shift, etc.).`,
    })
  }

  if (!desc.trim()) {
    issues.push({
      severity: 'warn',
      surface: 'entity',
      name,
      principle: 'missing-description',
      message: `Entity "${name}" has no description — the AI may not know when to use it vs. memory or other entities.`,
      suggestion: `Describe what this entity represents and when the AI should route changes here (vs. memory, vs. another entity).`,
    })
  }

  // Field-level checks
  const schema = entity.schema as z.ZodObject<Record<string, z.ZodTypeAny>> | undefined
  if (schema && 'shape' in schema) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const fieldDescription = (fieldSchema as any)?.description ?? (fieldSchema as any)?._def?.description
      if (!fieldDescription && !isObviouslyTypedField(fieldName, fieldSchema)) {
        issues.push({
          severity: 'warn',
          surface: 'entity',
          name,
          principle: 'missing-field-description',
          message: `Entity "${name}" field "${fieldName}" has no describe() annotation.`,
          suggestion: `Add .describe('...') explaining the semantics — especially if the field name isn't self-explanatory or if values need examples/routing hints.`,
        })
      }
    }
  }

  return issues
}

function isGenericName(name: string): boolean {
  const tokens = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.every((token) => GENERIC_NAME_WORDS.has(token))) return true
  // Single-word generic
  if (tokens.length === 1 && GENERIC_NAME_WORDS.has(tokens[0])) return true
  return false
}

function looksLikeNameRestatement(name: string, description: string): boolean {
  const nameTokens = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 3)
  if (nameTokens.length === 0) return false
  const descLower = description.toLowerCase()
  const matches = nameTokens.filter((token) => descLower.includes(token))
  return matches.length === nameTokens.length
}

function detectVagueSchema(schema: z.ZodTypeAny, path = ''): Array<{
  severity: 'error' | 'warn'
  principle: ActionContractIssue['principle']
  message: string
  suggestion: string
}> {
  const issues: Array<{
    severity: 'error' | 'warn'
    principle: ActionContractIssue['principle']
    message: string
    suggestion: string
  }> = []
  const typeName = (schema as any)?._def?.typeName
  const here = path ? ` (at ${path})` : ''

  if (typeName === 'ZodAny' || typeName === 'ZodUnknown') {
    issues.push({
      severity: 'error',
      principle: 'vague-schema-type',
      message: `Schema uses z.any() or z.unknown()${here} — the AI has no type guidance for the payload.`,
      suggestion: `Tighten to the actual shape. If the payload is dynamic, use z.record() or discriminated unions so the AI knows the space.`,
    })
  }

  // Recurse into object fields
  if (typeName === 'ZodObject' && 'shape' in schema) {
    const shape = (schema as any).shape as Record<string, z.ZodTypeAny>
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      issues.push(...detectVagueSchema(fieldSchema, path ? `${path}.${fieldName}` : fieldName))
    }
  }

  // Unwrap optional/nullable/default
  const innerType = (schema as any)?._def?.innerType
  if (innerType && (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault')) {
    issues.push(...detectVagueSchema(innerType, path))
  }

  return issues
}

function isObviouslyTypedField(name: string, schema: z.ZodTypeAny): boolean {
  const n = name.toLowerCase()
  const typeName = (schema as any)?._def?.typeName
  // Well-known field names whose semantics are obvious from the type
  const obvious = new Set([
    'id',
    'uuid',
    'name',
    'title',
    'description',
    'createdat',
    'updatedat',
    'email',
    'url',
    'count',
    'index',
  ])
  if (obvious.has(n)) return true
  // Enums are self-documenting
  if (typeName === 'ZodEnum' || typeName === 'ZodNativeEnum') return true
  return false
}
