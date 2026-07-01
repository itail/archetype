import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineEntity } from '../src/core/entities.js'
import { buildEntityRegistry } from '../src/core/entity-registry.js'
import {
  parseActionName,
  actionLabel,
  getActionDisplayTitle,
  isEntityAction,
  allowedOperations,
} from '../src/core/entity-helpers.js'
import type { ParsedAction } from '../src/types.js'

// ─── Shared registry for tests ─────────────────────────────────────────────

const threadEntity = defineEntity({
  name: 'thread',
  label: 'Thread',
  displayField: 'title',
  schema: z.object({ title: z.string(), status: z.string() }),
  operations: {
    create: { confidence: 'low' },
    update: { confidence: 'high' },
    delete: { confidence: 'high' },
  },
})

const ffEntity = defineEntity({
  name: 'ff',
  label: 'Forcing Function',
  displayField: 'what',
  schema: z.object({ what: z.string(), owner: z.string(), due: z.string() }),
  operations: {
    create: { confidence: 'medium' },
    update: { confidence: 'high' },
  },
})

const cueEntity = defineEntity({
  name: 'cue',
  label: 'Tactic',
  displayField: 'cueText',
  schema: z.object({ cueText: z.string() }),
  operations: {
    create: { confidence: 'medium' },
    update: { confidence: 'medium' },
    delete: { confidence: 'medium' },
  },
})

const registry = buildEntityRegistry(
  { name: 'thread', ...threadEntity },
  { name: 'ff', ...ffEntity },
  { name: 'cue', ...cueEntity },
)

// ─── parseActionName ────────────────────────────────────────────────────────

describe('parseActionName', () => {
  it('parses create actions', () => {
    expect(parseActionName('createThread')).toEqual({ verb: 'create', entityName: 'thread' })
  })

  it('parses update actions', () => {
    expect(parseActionName('updateFf')).toEqual({ verb: 'update', entityName: 'ff' })
  })

  it('parses delete actions', () => {
    expect(parseActionName('deleteThread')).toEqual({ verb: 'delete', entityName: 'thread' })
  })

  it('parses save actions (memory)', () => {
    expect(parseActionName('saveMemory')).toEqual({ verb: 'save', entityName: 'memory' })
  })

  it('handles multi-word entity names', () => {
    expect(parseActionName('createExecNote')).toEqual({ verb: 'create', entityName: 'execNote' })
    expect(parseActionName('deleteDiscussionPoint')).toEqual({ verb: 'delete', entityName: 'discussionPoint' })
  })

  it('returns null for unrecognized names', () => {
    expect(parseActionName('random')).toBeNull()
    expect(parseActionName('listThreads')).toBeNull()
    expect(parseActionName('')).toBeNull()
    expect(parseActionName('create')).toBeNull()  // no entity part
  })
})

// ─── actionLabel ────────────────────────────────────────────────────────────

describe('actionLabel', () => {
  it('uses entity label from registry', () => {
    expect(actionLabel('createThread', registry)).toBe('Add Thread')
    expect(actionLabel('updateFf', registry)).toBe('Update Forcing Function')
    expect(actionLabel('deleteCue', registry)).toBe('Delete Tactic')
  })

  it('uses "Add" for save verb', () => {
    // saveMemory isn't in our registry, but verb label still works
    expect(actionLabel('saveMemory', registry)).toBe('Add Memory')
  })

  it('falls back to capitalize(entityName) for unknown entities', () => {
    expect(actionLabel('createMeal', registry)).toBe('Add Meal')
    expect(actionLabel('deleteDocument', registry)).toBe('Delete Document')
  })

  it('returns raw name for unparseable action', () => {
    expect(actionLabel('randomAction', registry)).toBe('randomAction')
  })
})

// ─── getActionDisplayTitle ──────────────────────────────────────────────────

describe('getActionDisplayTitle', () => {
  function action(name: string, params: Record<string, unknown>): ParsedAction {
    return { name, params, confidence: 'medium' }
  }

  it('uses displayField for create actions', () => {
    const result = getActionDisplayTitle(
      action('createThread', { title: 'Revenue Target Q3', status: 'active' }),
      registry,
    )
    expect(result).toBe('Revenue Target Q3')
  })

  it('uses displayField for entities with custom displayField', () => {
    const result = getActionDisplayTitle(
      action('createCue', { cueText: 'Ask about blockers first' }),
      registry,
    )
    expect(result).toBe('Ask about blockers first')
  })

  it('falls back to common field names when no displayField', () => {
    // Build a registry with an entity that has no displayField
    const noDisplayEntity = defineEntity({
      name: 'note',
      schema: z.object({ text: z.string() }),
      operations: { create: { confidence: 'low' } },
    })
    const r = buildEntityRegistry({ name: 'note', ...noDisplayEntity })

    const result = getActionDisplayTitle(
      action('createNote', { text: 'Some note content' }),
      r,
    )
    expect(result).toBe('Some note content')
  })

  it('handles update with {id, updates} shape', () => {
    const result = getActionDisplayTitle(
      action('updateThread', { id: '123', updates: { status: 'stuck' } }),
      registry,
    )
    expect(result).toBe('status: stuck')
  })

  it('handles update with multiple fields in updates', () => {
    const result = getActionDisplayTitle(
      action('updateThread', { id: '123', updates: { title: 'New', status: 'active' } }),
      registry,
    )
    expect(result).toBe('title, status')
  })

  it('handles update with {id, field, value} shape (legacy)', () => {
    const result = getActionDisplayTitle(
      action('updateThread', { id: '123', field: 'status', value: 'stuck' }),
      registry,
    )
    expect(result).toBe('status: stuck')
  })

  it('handles delete with reason', () => {
    const result = getActionDisplayTitle(
      action('deleteThread', { id: '123', reason: 'No longer relevant' }),
      registry,
    )
    expect(result).toBe('No longer relevant')
  })

  it('returns empty string for delete without reason', () => {
    const result = getActionDisplayTitle(
      action('deleteThread', { id: '123' }),
      registry,
    )
    expect(result).toBe('')
  })

  it('truncates long text', () => {
    const longTitle = 'A'.repeat(100)
    const result = getActionDisplayTitle(
      action('createThread', { title: longTitle, status: 'active' }),
      registry,
    )
    expect(result.length).toBe(61) // 60 + '…'
    expect(result.endsWith('…')).toBe(true)
  })

  it('returns empty string for unparseable action', () => {
    const result = getActionDisplayTitle(
      action('randomAction', { foo: 'bar' }),
      registry,
    )
    expect(result).toBe('')
  })
})

// ─── isEntityAction ─────────────────────────────────────────────────────────

describe('isEntityAction', () => {
  it('returns true for matching entity', () => {
    expect(isEntityAction('createThread', 'thread')).toBe(true)
    expect(isEntityAction('updateThread', 'thread')).toBe(true)
    expect(isEntityAction('deleteThread', 'thread')).toBe(true)
  })

  it('returns false for non-matching entity', () => {
    expect(isEntityAction('createThread', 'ff')).toBe(false)
    expect(isEntityAction('updateFf', 'thread')).toBe(false)
  })

  it('returns false for unparseable name', () => {
    expect(isEntityAction('randomAction', 'thread')).toBe(false)
  })

  it('handles memory actions', () => {
    expect(isEntityAction('saveMemory', 'memory')).toBe(true)
    expect(isEntityAction('updateMemory', 'memory')).toBe(true)
    expect(isEntityAction('deleteMemory', 'memory')).toBe(true)
    expect(isEntityAction('saveMemory', 'thread')).toBe(false)
  })
})

describe('allowedOperations', () => {
  it('defaults to all three operations', () => {
    expect(allowedOperations({})).toEqual(['create', 'update', 'delete'])
  })

  it('honors an explicit operations list', () => {
    expect(allowedOperations({ operations: ['update'] })).toEqual(['update'])
    expect(allowedOperations({ operations: ['create', 'delete'] })).toEqual(['create', 'delete'])
  })

  it('treats createOnly as operations: [create]', () => {
    expect(allowedOperations({ createOnly: true })).toEqual(['create'])
  })

  it('explicit operations win over createOnly', () => {
    expect(allowedOperations({ createOnly: true, operations: ['create', 'update'] })).toEqual(['create', 'update'])
  })
})
