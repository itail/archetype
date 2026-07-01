import { describe, it, expect } from 'vitest'
import { MEMORY_ACTIONS, MEMORY_ACTION_NAMES, buildMemoryActions } from '../src/core/memory-actions.js'

describe('MEMORY_ACTIONS', () => {
  it('defines saveMemory, updateMemory, deleteMemory', () => {
    expect(Object.keys(MEMORY_ACTIONS)).toEqual(['saveMemory', 'updateMemory', 'deleteMemory'])
  })

  it('saveMemory validates content + category', () => {
    const schema = MEMORY_ACTIONS.saveMemory.schema
    expect(schema.safeParse({ content: 'test', category: 'general' }).success).toBe(true)
    expect(schema.safeParse({ content: 'test' }).success).toBe(false) // missing category
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('updateMemory validates id + content', () => {
    const schema = MEMORY_ACTIONS.updateMemory.schema
    expect(schema.safeParse({ id: 'abc', content: 'updated' }).success).toBe(true)
    expect(schema.safeParse({ content: 'updated' }).success).toBe(false) // missing id
  })

  it('deleteMemory validates id', () => {
    const schema = MEMORY_ACTIONS.deleteMemory.schema
    expect(schema.safeParse({ id: 'abc' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('all memory actions have low confidence', () => {
    for (const action of Object.values(MEMORY_ACTIONS)) {
      expect(action.confidence).toBe('low')
    }
  })
})

describe('MEMORY_ACTION_NAMES', () => {
  it('contains exactly the memory action names', () => {
    expect(MEMORY_ACTION_NAMES.has('saveMemory')).toBe(true)
    expect(MEMORY_ACTION_NAMES.has('updateMemory')).toBe(true)
    expect(MEMORY_ACTION_NAMES.has('deleteMemory')).toBe(true)
    expect(MEMORY_ACTION_NAMES.has('unknownAction')).toBe(false)
  })
})

describe('buildMemoryActions', () => {
  it('returns default MEMORY_ACTIONS when no categories provided', () => {
    expect(buildMemoryActions()).toBe(MEMORY_ACTIONS)
    expect(buildMemoryActions({})).toBe(MEMORY_ACTIONS)
    expect(buildMemoryActions(undefined)).toBe(MEMORY_ACTIONS)
  })

  it('generates custom saveMemory schema description with category descriptions', () => {
    const categories = {
      preference: 'Dietary preferences, food likes/dislikes',
      routine: 'Eating patterns, meal timing',
      health: 'Health conditions, medications',
    }
    const actions = buildMemoryActions(categories)

    // saveMemory should have custom categories
    expect(actions.saveMemory).toBeDefined()
    expect(actions.saveMemory.confidence).toBe('low')

    // Schema should still validate content + category
    expect(actions.saveMemory.schema.safeParse({ content: 'test', category: 'preference' }).success).toBe(true)
    expect(actions.saveMemory.schema.safeParse({ content: 'test' }).success).toBe(false)

    // updateMemory and deleteMemory should be unchanged
    expect(actions.updateMemory).toBe(MEMORY_ACTIONS.updateMemory)
    expect(actions.deleteMemory).toBe(MEMORY_ACTIONS.deleteMemory)
  })
})
