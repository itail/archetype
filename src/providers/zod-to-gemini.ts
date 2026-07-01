import { SchemaType } from '@google/generative-ai'
import type { z } from 'zod'

/**
 * Resolve the type identifier from a Zod schema.
 * Zod v3 uses `_def.typeName` ("ZodString"), v4 uses `_def.type` ("string").
 */
function resolveTypeName(def: Record<string, unknown>): string {
  // v3: _def.typeName = "ZodString" | "ZodObject" | ...
  if (typeof def.typeName === 'string') return def.typeName
  // v4: _def.type = "string" | "object" | ... — normalize to v3 style
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

/**
 * Get the inner object shape from a Zod schema (v3 uses function, v4 uses plain object).
 */
function resolveShape(def: Record<string, unknown>): Record<string, z.ZodType> | null {
  const s = def.shape
  if (typeof s === 'function') return s() as Record<string, z.ZodType>
  if (s && typeof s === 'object') return s as Record<string, z.ZodType>
  return null
}

/**
 * Get the array item type (v3: _def.type, v4: _def.element).
 */
function resolveArrayItem(def: Record<string, unknown>): z.ZodType | null {
  // v3: _def.type is the ZodType for array items
  if (def.type && typeof def.type === 'object' && '_def' in (def.type as object)) {
    return def.type as z.ZodType
  }
  // v4: _def.element is the item type
  if (def.element && typeof def.element === 'object' && '_def' in (def.element as object)) {
    return def.element as z.ZodType
  }
  return null
}

/**
 * Get the inner type for optional/nullable (v3: _def.innerType, v4: _def.innerType).
 */
function resolveInnerType(def: Record<string, unknown>): z.ZodType | null {
  const inner = def.innerType
  if (inner && typeof inner === 'object' && '_def' in (inner as object)) return inner as z.ZodType
  return null
}

/**
 * Convert a Zod schema to a Gemini-compatible schema object.
 * Supports both Zod v3 (typeName) and v4 (type string + element/shape).
 * Falls back to STRING for unknown types (safe default — model will parse from text).
 */
export function zodToGeminiSchema(zodType: z.ZodType): Record<string, unknown> {
  const def = (zodType as unknown as { _def: Record<string, unknown> })._def
  const typeName = resolveTypeName(def)
  const description = (def.description as string | undefined)
    ?? (zodType as unknown as { description?: string }).description

  let result: Record<string, unknown>

  switch (typeName) {
    case 'ZodString':
      result = { type: SchemaType.STRING }
      break

    case 'ZodNumber':
      result = { type: SchemaType.NUMBER }
      break

    case 'ZodBoolean':
      result = { type: SchemaType.BOOLEAN }
      break

    case 'ZodEnum': {
      const values = def.values ?? def.entries
      result = { type: SchemaType.STRING, enum: Array.isArray(values) ? values : Object.keys(values as object) }
      break
    }

    case 'ZodLiteral':
      result = { type: SchemaType.STRING, enum: [String(def.value)] }
      break

    case 'ZodArray': {
      const item = resolveArrayItem(def)
      result = item
        ? { type: SchemaType.ARRAY, items: zodToGeminiSchema(item) }
        : { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
      break
    }

    case 'ZodObject': {
      const shape = resolveShape(def)
      if (!shape) {
        result = { type: SchemaType.OBJECT, properties: {} }
        break
      }
      const properties: Record<string, unknown> = {}
      const required: string[] = []

      for (const [key, value] of Object.entries(shape)) {
        const innerDef = (value as unknown as { _def: Record<string, unknown> })._def
        const innerTypeName = resolveTypeName(innerDef)
        if (innerTypeName === 'ZodOptional') {
          properties[key] = zodToGeminiSchema(value)
        } else {
          properties[key] = zodToGeminiSchema(value)
          required.push(key)
        }
      }

      result = {
        type: SchemaType.OBJECT,
        properties,
        ...(required.length > 0 ? { required } : {}),
      }
      break
    }

    case 'ZodOptional': {
      const inner = resolveInnerType(def)
      if (!inner) { result = { type: SchemaType.STRING }; break }
      const innerSchema = zodToGeminiSchema(inner)
      if (description && !innerSchema.description) {
        return { ...innerSchema, description }
      }
      return innerSchema
    }

    case 'ZodNullable': {
      const inner = resolveInnerType(def)
      if (!inner) { result = { type: SchemaType.STRING, nullable: true }; break }
      const innerSchema = zodToGeminiSchema(inner)
      return { ...innerSchema, nullable: true, ...(description && !innerSchema.description ? { description } : {}) }
    }

    default:
      // Safe fallback — model will parse from the text description
      result = { type: SchemaType.STRING }
      break
  }

  if (description) {
    result.description = description
  }

  return result
}
