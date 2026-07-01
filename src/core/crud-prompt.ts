import { allowedOperations } from './entity-helpers.js'
import type { EntityConfig, PromptContractStyle, PromptMode } from '../types.js'
import type { z } from 'zod'

// ─── Zod traversal helpers (shared pattern with zod-to-gemini.ts) ───────────

function resolveTypeName(def: Record<string, unknown>): string {
  if (typeof def.typeName === 'string') return def.typeName
  if (typeof def.type === 'string') {
    const map: Record<string, string> = {
      string: 'ZodString', number: 'ZodNumber', boolean: 'ZodBoolean',
      array: 'ZodArray', object: 'ZodObject', optional: 'ZodOptional',
      nullable: 'ZodNullable', enum: 'ZodEnum', literal: 'ZodLiteral',
    }
    return map[def.type] ?? ''
  }
  return ''
}

function resolveShape(def: Record<string, unknown>): Record<string, z.ZodType> | null {
  const s = def.shape
  if (typeof s === 'function') return s() as Record<string, z.ZodType>
  if (s && typeof s === 'object') return s as Record<string, z.ZodType>
  return null
}

function resolveArrayItem(def: Record<string, unknown>): z.ZodType | null {
  if (def.type && typeof def.type === 'object' && '_def' in (def.type as object)) return def.type as z.ZodType
  if (def.element && typeof def.element === 'object' && '_def' in (def.element as object)) return def.element as z.ZodType
  return null
}

function resolveInnerType(def: Record<string, unknown>): z.ZodType | null {
  const inner = def.innerType
  if (inner && typeof inner === 'object' && '_def' in (inner as object)) return inner as z.ZodType
  return null
}

function isOptionalLike(zodType: z.ZodType): boolean {
  const def = (zodType as unknown as { _def?: Record<string, unknown> })._def
  if (!def) return false
  const typeName = resolveTypeName(def)
  return typeName === 'ZodOptional' || typeName === 'ZodNullable'
}

function buildExampleValue(zodType: z.ZodType): unknown {
  const def = (zodType as unknown as { _def?: Record<string, unknown> })._def
  if (!def) return '<value>'

  const typeName = resolveTypeName(def)

  switch (typeName) {
    case 'ZodString':
      return '<string>'
    case 'ZodNumber':
      return 1
    case 'ZodBoolean':
      return true
    case 'ZodLiteral':
      return def.value
    case 'ZodEnum': {
      const values = def.values ?? def.entries
      const arr = Array.isArray(values) ? values : Object.keys(values as object)
      return arr[0] ?? '<value>'
    }
    case 'ZodOptional':
    case 'ZodNullable': {
      const inner = resolveInnerType(def)
      return inner ? buildExampleValue(inner) : '<value>'
    }
    case 'ZodArray': {
      const item = resolveArrayItem(def)
      return item ? [buildExampleValue(item)] : ['<value>']
    }
    case 'ZodObject': {
      const shape = resolveShape(def)
      if (!shape) return {}
      const example: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(shape)) {
        example[key] = buildExampleValue(value)
      }
      return example
    }
    default:
      return '<value>'
  }
}

function buildRequiredExampleValue(zodType: z.ZodType): unknown {
  const def = (zodType as unknown as { _def?: Record<string, unknown> })._def
  if (!def) return '<value>'

  const typeName = resolveTypeName(def)

  switch (typeName) {
    case 'ZodObject': {
      const shape = resolveShape(def)
      if (!shape) return {}
      const example: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(shape)) {
        if (isOptionalLike(value)) continue
        example[key] = buildRequiredExampleValue(value)
      }
      return example
    }
    case 'ZodOptional':
    case 'ZodNullable': {
      const inner = resolveInnerType(def)
      return inner ? buildRequiredExampleValue(inner) : '<value>'
    }
    default:
      return buildExampleValue(zodType)
  }
}

function buildExampleCrudResponseItem(entities: Record<string, EntityConfig>): string {
  const first = Object.entries(entities)[0]
  if (!first) {
    return '{ "name": "crud", "params": { "operation": "create", "entity": "<name>", "id": "_temp1", "params": "{ ... }" } }'
  }

  const [entityName, config] = first
  const params = JSON.stringify(buildRequiredExampleValue(config.schema))
  return JSON.stringify({
    name: 'crud',
    params: {
      operation: 'create',
      entity: entityName,
      id: `_${entityName}1`,
      params,
    },
  })
}

// ─── zodToDescription: comprehensive Zod → human-readable text ──────────────

/**
 * Convert any Zod schema to a compact human-readable description.
 * Handles the full Zod type system: primitives, enums, arrays, objects,
 * optionals, nullables, literals, and .describe() annotations.
 *
 * Same traversal pattern as zodToGeminiSchema but outputs text for prompts.
 */
export function zodToDescription(zodType: z.ZodType): string {
  const def = (zodType as unknown as { _def: Record<string, unknown> })._def
  if (!def) return 'unknown'

  const typeName = resolveTypeName(def)
  const description = (def.description as string | undefined)
    ?? (zodType as unknown as { description?: string }).description

  let result: string

  switch (typeName) {
    case 'ZodString':
      result = 'string'
      break

    case 'ZodNumber':
      result = 'number'
      break

    case 'ZodBoolean':
      result = 'boolean'
      break

    case 'ZodEnum': {
      const values = def.values ?? def.entries
      const arr = Array.isArray(values) ? values : Object.keys(values as object)
      result = arr.map(value => JSON.stringify(value)).join(' | ')
      break
    }

    case 'ZodLiteral':
      result = JSON.stringify(def.value)
      break

    case 'ZodArray': {
      const item = resolveArrayItem(def)
      if (item) {
        const itemDesc = zodToDescription(item)
        const wrapped = itemDesc.includes(' | ') && !itemDesc.startsWith('{')
          ? `(${itemDesc})`
          : itemDesc
        result = `${wrapped}[]`
      } else {
        result = 'array'
      }
      break
    }

    case 'ZodObject': {
      const shape = resolveShape(def)
      if (!shape) { result = 'object'; break }
      const fields = Object.entries(shape).map(([key, val]) => {
        const fieldDef = (val as unknown as { _def: Record<string, unknown> })._def
        const fieldTypeName = resolveTypeName(fieldDef)
        const isOptional = fieldTypeName === 'ZodOptional'
        const fieldDesc = zodToDescription(val)
        const fieldDescription = (fieldDef.description as string | undefined)
          ?? (val as unknown as { description?: string }).description
        const descSuffix = fieldDescription ? ` (${fieldDescription})` : ''
        const optionalSuffix = isOptional && !fieldDesc.endsWith('?') ? '?' : ''
        return `${key}: ${fieldDesc}${optionalSuffix}${descSuffix}`
      })
      result = `{ ${fields.join(', ')} }`
      break
    }

    case 'ZodOptional': {
      const inner = resolveInnerType(def)
      if (!inner) return 'string?'
      const innerDesc = zodToDescription(inner)
      // Don't double-append ? if already present
      return innerDesc.endsWith('?') ? innerDesc : `${innerDesc}?`
    }

    case 'ZodNullable': {
      const inner = resolveInnerType(def)
      if (!inner) return 'string | null'
      return `${zodToDescription(inner)} | null`
    }

    default:
      result = 'string'
      break
  }

  return result
}

// ─── Entity block builder ───────────────────────────────────────────────────

/**
 * Render the entities block for the system prompt.
 * Includes entity definitions and CRUD format instructions.
 */
export function buildEntitiesBlock(
  entities: Record<string, EntityConfig>,
  promptMode: PromptMode = 'conversation',
  contractStyle: PromptContractStyle = 'full',
): string {
  const names = Object.keys(entities)
  if (names.length === 0) return ''

  const intro = promptMode === 'operational'
    ? '--- ENTITIES (available for create, update, and delete when the live turn calls for it) ---'
    : '--- ENTITIES (available for create, update, and delete when the conversation calls for it) ---'
  const lines: string[] = [intro]

  for (const [name, config] of Object.entries(entities)) {
    const schemaDesc = zodToDescription(config.schema)
    // Strip outer braces for inline display: { field: type, ... } → field: type, ...
    const fields = schemaDesc.startsWith('{') && schemaDesc.endsWith('}')
      ? schemaDesc.slice(2, -2)
      : schemaDesc
    lines.push(`- ${name}`)
    lines.push(`    fields: { ${fields} }`)
    const ops = allowedOperations(config)
    if (ops.length < 3) {
      lines.push(`    operations: ${ops.join(', ')} only`)
    }
    if (config.description) {
      lines.push(`    what it is: ${config.description}`)
    }
  }

  lines.push('')
  lines.push(contractStyle === 'lean' ? '--- CRUD ---' : '--- ENTITY CRUD RESPONSE CONTRACT ---')
  lines.push('crud action item: { "name": "crud", "params": { "operation": "create"|"update"|"delete", "entity": "<name>", "id": "<id>", "params": "{ ... }" } }')
  if (contractStyle === 'full') {
    lines.push('do not use a top-level "crudActions" key — entity mutations belong inside the main "actions" array')
  }
  lines.push(`example response item: ${buildExampleCrudResponseItem(entities)}`)
  if (contractStyle === 'lean') {
    lines.push('create: required fields only; temp ids start with _')
    lines.push('update: real id + changed fields only')
    lines.push('delete: operation, entity, id only')
  } else {
    lines.push('create: include all required fields in params and add optional fields only when the situation genuinely calls for them; generate a temp id starting with _')
    lines.push('update: use a real id from context and include only changed fields')
    lines.push('delete: include operation, entity, and id only')
    lines.push('cross-reference: create parent temp id first, then reuse it in child params')
  }

  return lines.join('\n')
}
