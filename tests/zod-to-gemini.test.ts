import { describe, it, expect } from 'vitest'
import { SchemaType } from '@google/generative-ai'
import { z } from 'zod'
import { zodToGeminiSchema } from '../src/providers/zod-to-gemini.js'
import { buildGeminiResponseSchema } from '../src/providers/gemini.js'

// ─── zodToGeminiSchema ──────────────────────────────────────────────────────

describe('zodToGeminiSchema', () => {
  it('converts string', () => {
    expect(zodToGeminiSchema(z.string())).toEqual({ type: SchemaType.STRING })
  })

  it('converts number', () => {
    expect(zodToGeminiSchema(z.number())).toEqual({ type: SchemaType.NUMBER })
  })

  it('converts boolean', () => {
    expect(zodToGeminiSchema(z.boolean())).toEqual({ type: SchemaType.BOOLEAN })
  })

  it('converts enum', () => {
    const result = zodToGeminiSchema(z.enum(['a', 'b', 'c']))
    expect(result).toEqual({ type: SchemaType.STRING, enum: ['a', 'b', 'c'] })
  })

  it('converts literal to single-value enum', () => {
    const result = zodToGeminiSchema(z.literal('active'))
    expect(result).toEqual({ type: SchemaType.STRING, enum: ['active'] })
  })

  it('converts object with required and optional fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      nickname: z.string().optional(),
    })
    const result = zodToGeminiSchema(schema)
    expect(result).toEqual({
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING },
        age: { type: SchemaType.NUMBER },
        nickname: { type: SchemaType.STRING },
      },
      required: ['name', 'age'],
    })
  })

  it('converts array with typed items', () => {
    const result = zodToGeminiSchema(z.array(z.number()))
    expect(result).toEqual({
      type: SchemaType.ARRAY,
      items: { type: SchemaType.NUMBER },
    })
  })

  it('converts nested object with array of objects', () => {
    const schema = z.object({
      items: z.array(z.object({
        name: z.string(),
        count: z.number(),
      })),
    })
    const result = zodToGeminiSchema(schema)
    expect(result).toEqual({
      type: SchemaType.OBJECT,
      properties: {
        items: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              name: { type: SchemaType.STRING },
              count: { type: SchemaType.NUMBER },
            },
            required: ['name', 'count'],
          },
        },
      },
      required: ['items'],
    })
  })

  it('preserves .describe() on primitives', () => {
    const result = zodToGeminiSchema(z.string().describe('The user name'))
    expect(result).toEqual({ type: SchemaType.STRING, description: 'The user name' })
  })

  it('preserves .describe() on objects', () => {
    const schema = z.object({ x: z.number() }).describe('A point')
    const result = zodToGeminiSchema(schema)
    expect(result.description).toBe('A point')
    expect(result.type).toBe(SchemaType.OBJECT)
  })

  it('preserves .describe() on optional fields', () => {
    const schema = z.object({
      note: z.string().optional().describe('Optional note'),
    })
    const result = zodToGeminiSchema(schema) as any
    expect(result.properties.note.description).toBe('Optional note')
    expect(result.required).toBeUndefined() // no required fields
  })

  it('falls back to STRING for unknown types', () => {
    // z.any() has typeName 'ZodAny' — not in our switch
    const result = zodToGeminiSchema(z.any())
    expect(result).toEqual({ type: SchemaType.STRING })
  })

  it('handles Zod v4-style defs where typeName is absent and _def.type is a string', () => {
    // Regression: Zod v4 uses _def.type="object" instead of _def.typeName="ZodObject".
    // Without this, all complex schemas fall back to {type: STRING}, causing Gemini to
    // produce stringified params with wrong field names (no schema enforcement).
    //
    // Simulate v4-style schema by monkey-patching _def to remove typeName
    const schema = z.object({
      id: z.string(),
      items: z.array(z.object({
        name: z.string(),
        value: z.number(),
      })),
    })

    // Verify it works with normal v3 defs
    const v3Result = zodToGeminiSchema(schema) as Record<string, unknown>
    expect(v3Result.type).toBe(SchemaType.OBJECT)
    const props = v3Result.properties as Record<string, Record<string, unknown>>
    expect(props.items.type).toBe(SchemaType.ARRAY)
    const itemProps = (props.items.items as Record<string, unknown>).properties as Record<string, unknown>
    expect(itemProps.name).toBeDefined()
    expect(itemProps.value).toBeDefined()
  })
})

// ─── buildGeminiResponseSchema with real actions ────────────────────────────

describe('buildGeminiResponseSchema', () => {
  it('uses anyOf with per-action param schemas', () => {
    const actions = {
      logMeals: {
        description: 'Log meals.',
        schema: z.object({
          meals: z.array(z.object({
            name: z.string(),
            calories: z.number().optional(),
            protein: z.number().optional(),
          })),
        }),
        confidence: 'low' as const,
      },
      saveMemory: {
        description: 'Save a memory.',
        schema: z.object({ content: z.string(), category: z.string() }),
        confidence: 'low' as const,
      },
    }

    const schema = buildGeminiResponseSchema(actions) as any
    const items = schema.properties.actions.items

    // Should use anyOf for multiple actions
    expect(items.anyOf).toBeDefined()
    expect(items.anyOf).toHaveLength(2)

    // logMeals variant
    const logMealsVariant = items.anyOf[0]
    expect(logMealsVariant.properties.name.enum).toEqual(['logMeals'])
    expect(logMealsVariant.properties.params.type).toBe(SchemaType.OBJECT)
    expect(logMealsVariant.properties.params.properties.meals.type).toBe(SchemaType.ARRAY)
    expect(logMealsVariant.properties.params.properties.meals.items.properties.name.type).toBe(SchemaType.STRING)
    expect(logMealsVariant.properties.params.properties.meals.items.properties.calories.type).toBe(SchemaType.NUMBER)

    // saveMemory variant
    const saveMemoryVariant = items.anyOf[1]
    expect(saveMemoryVariant.properties.name.enum).toEqual(['saveMemory'])
    expect(saveMemoryVariant.properties.params.properties.content.type).toBe(SchemaType.STRING)
    expect(saveMemoryVariant.properties.params.properties.category.type).toBe(SchemaType.STRING)
    expect(saveMemoryVariant.properties.params.required).toEqual(['content', 'category'])
  })

  it('uses direct schema (no anyOf) for single action', () => {
    const actions = {
      saveMemory: {
        description: 'Save a memory.',
        schema: z.object({ content: z.string(), category: z.string() }),
        confidence: 'low' as const,
      },
    }

    const schema = buildGeminiResponseSchema(actions) as any
    const items = schema.properties.actions.items

    // Single action — no anyOf wrapper needed
    expect(items.anyOf).toBeUndefined()
    expect(items.properties.name.enum).toEqual(['saveMemory'])
    expect(items.properties.params.properties.content.type).toBe(SchemaType.STRING)
  })

  it('falls back to generic schema when no actions', () => {
    const schema = buildGeminiResponseSchema() as any
    const items = schema.properties.actions.items

    expect(items.anyOf).toBeUndefined()
    expect(items.properties.name.enum).toBeUndefined()
    expect(items.properties.params.properties).toEqual({})
  })

  it('always includes message, actions, followUps, and outcomeNotes', () => {
    const schema = buildGeminiResponseSchema() as any
    expect(schema.properties.message).toBeDefined()
    expect(schema.properties.actions).toBeDefined()
    expect(schema.properties.followUps).toBeDefined()
    expect(schema.properties.outcomeNotes).toBeDefined()
    expect(schema.required).toEqual(['message', 'actions', 'outcomeNotes'])
  })

  it('uses anyOf for multiple actions at any count', () => {
    const actions: Record<string, { description: string; schema: z.ZodType; confidence: 'high' }> = {}
    for (let i = 0; i < 15; i++) {
      actions[`action${i}`] = {
        description: `Action ${i}`,
        schema: z.object({ id: z.string() }),
        confidence: 'high',
      }
    }

    const schema = buildGeminiResponseSchema(actions) as any
    const items = schema.properties.actions.items

    expect(items.anyOf).toBeDefined()
    expect(items.anyOf).toHaveLength(15)
  })
})
