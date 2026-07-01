import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineEntity } from '../src/core/entities.js'
import { buildEntityRegistry } from '../src/core/entity-registry.js'

// ─── Test fixtures ──────────────────────────────────────────────────────────

const threadEntity = defineEntity({
  name: 'thread',
  label: 'Thread',
  displayField: 'title',
  schema: z.object({ title: z.string(), status: z.string(), owner: z.string() }),
  contextFormat: 'list',
  contextBudget: 4000,
  contextPriority: 'critical',
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
    delete: { confidence: 'high' },
  },
})

const cueEntity = defineEntity({
  name: 'cue',
  label: 'Tactic',
  displayField: 'cueText',
  schema: z.object({ cueText: z.string(), scope: z.string() }),
  operations: {
    create: { confidence: 'medium' },
    update: { confidence: 'medium' },
    delete: { confidence: 'medium' },
  },
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildEntityRegistry', () => {
  it('merges actions from multiple entities', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
      { name: 'ff', ...ffEntity },
    )

    expect(Object.keys(registry.actions)).toEqual([
      'createThread', 'updateThread', 'deleteThread',
      'createFf', 'updateFf', 'deleteFf',
    ])
  })

  it('merges context inputs keyed by entity name', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
      { name: 'ff', ...ffEntity },
    )

    expect(registry.contextInputs).toHaveProperty('thread')
    expect(registry.contextInputs).toHaveProperty('ff')
    expect(registry.contextInputs.thread.label).toBe('THREADS')
    expect(registry.contextInputs.ff.label).toBe('FFS')
  })

  it('returns entity names in order', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
      { name: 'ff', ...ffEntity },
      { name: 'cue', ...cueEntity },
    )

    expect(registry.entityNames).toEqual(['thread', 'ff', 'cue'])
  })

  it('getEntityForAction returns correct metadata', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
      { name: 'ff', ...ffEntity },
    )

    expect(registry.getEntityForAction('createThread')).toEqual({
      name: 'thread', label: 'Thread', displayField: 'title',
    })
    expect(registry.getEntityForAction('updateFf')).toEqual({
      name: 'ff', label: 'Forcing Function', displayField: 'what',
    })
    expect(registry.getEntityForAction('deleteFf')).toEqual({
      name: 'ff', label: 'Forcing Function', displayField: 'what',
    })
  })

  it('getEntityForAction returns null for unknown action', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
    )

    expect(registry.getEntityForAction('createMeal')).toBeNull()
    expect(registry.getEntityForAction('random')).toBeNull()
  })

  it('entities array contains full metadata', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
      { name: 'cue', ...cueEntity },
    )

    expect(registry.entities).toHaveLength(2)
    expect(registry.entities[0].name).toBe('thread')
    expect(registry.entities[0].label).toBe('Thread')
    expect(registry.entities[0].displayField).toBe('title')
    expect(registry.entities[1].name).toBe('cue')
    expect(registry.entities[1].label).toBe('Tactic')
    expect(registry.entities[1].displayField).toBe('cueText')
  })

  it('works with a single entity', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
    )

    expect(registry.entityNames).toEqual(['thread'])
    expect(Object.keys(registry.actions)).toEqual(['createThread', 'updateThread', 'deleteThread'])
  })

  it('works with zero entities', () => {
    const registry = buildEntityRegistry()

    expect(registry.entityNames).toEqual([])
    expect(registry.actions).toEqual({})
    expect(registry.contextInputs).toEqual({})
    expect(registry.getEntityForAction('anything')).toBeNull()
  })

  it('preserves action definitions (schema, confidence)', () => {
    const registry = buildEntityRegistry(
      { name: 'thread', ...threadEntity },
    )

    expect(registry.actions.createThread.confidence).toBe('low')
    expect(registry.actions.updateThread.confidence).toBe('high')

    // Schema still validates
    const parsed = registry.actions.createThread.schema.safeParse({
      title: 'Test', status: 'active', owner: 'Alex',
    })
    expect(parsed.success).toBe(true)
  })
})
