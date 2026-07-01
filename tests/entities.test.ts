import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { crud, defineEntity } from '../src/core/entities.js'

describe('defineEntity', () => {
  it('builds full CRUD operations from a single confidence', () => {
    expect(crud('medium')).toEqual({
      create: { confidence: 'medium' },
      update: { confidence: 'medium' },
      delete: { confidence: 'medium' },
    })
  })

  it('builds partial CRUD operations with optional descriptions', () => {
    expect(
      crud(
        { create: 'low', update: 'high' },
        { update: 'Prefer updating existing records over duplicates.' },
      ),
    ).toEqual({
      create: { confidence: 'low' },
      update: {
        confidence: 'high',
        description: 'Prefer updating existing records over duplicates.',
      },
    })
  })

  it('generates create action from entity definition', () => {
    const { actions } = defineEntity({
      name: 'meal',
      schema: z.object({ items: z.array(z.string()), mealType: z.string() }),
      operations: {
        create: { confidence: 'low' },
      },
    })

    expect(actions).toHaveProperty('createMeal')
    expect(actions.createMeal.confidence).toBe('low')
    expect(actions.createMeal.description).toContain('Create a new meal')

    // Validate that the schema works
    const parsed = actions.createMeal.schema.safeParse({ items: ['eggs'], mealType: 'breakfast' })
    expect(parsed.success).toBe(true)
  })

  it('generates update action with id + partial schema', () => {
    const { actions } = defineEntity({
      name: 'thread',
      schema: z.object({ title: z.string(), status: z.string(), owner: z.string() }),
      operations: {
        update: { confidence: 'high' },
      },
    })

    expect(actions).toHaveProperty('updateThread')
    expect(actions.updateThread.confidence).toBe('high')

    // Update should accept id + partial updates
    const parsed = actions.updateThread.schema.safeParse({
      id: 'abc',
      updates: { status: 'stuck' },
    })
    expect(parsed.success).toBe(true)

    // Partial means all fields optional
    const partialParsed = actions.updateThread.schema.safeParse({
      id: 'abc',
      updates: {},
    })
    expect(partialParsed.success).toBe(true)
  })

  it('generates delete action with id only', () => {
    const { actions } = defineEntity({
      name: 'document',
      schema: z.object({ title: z.string(), content: z.string() }),
      operations: {
        delete: { confidence: 'high' },
      },
    })

    expect(actions).toHaveProperty('deleteDocument')
    expect(actions.deleteDocument.confidence).toBe('high')

    const parsed = actions.deleteDocument.schema.safeParse({ id: 'xyz' })
    expect(parsed.success).toBe(true)
  })

  it('generates all CRUD actions when all operations specified', () => {
    const { actions } = defineEntity({
      name: 'meal',
      schema: z.object({ items: z.array(z.string()), mealType: z.string() }),
      operations: {
        create: { confidence: 'low' },
        update: { confidence: 'medium' },
        delete: { confidence: 'medium' },
      },
    })

    expect(Object.keys(actions)).toEqual(['createMeal', 'updateMeal', 'deleteMeal'])
  })

  it('generates context input definition', () => {
    const { contextInput } = defineEntity({
      name: 'thread',
      schema: z.object({ title: z.string() }),
      contextFormat: 'list',
      contextBudget: 4000,
      contextPriority: 'critical',
      operations: {
        update: { confidence: 'high' },
      },
    })

    expect(contextInput.label).toBe('THREADS')
    expect(contextInput.format).toBe('list')
    expect(contextInput.budget).toBe(4000)
    expect(contextInput.priority).toBe('critical')
    expect(contextInput.includeIds).toBe(true)
  })

  it('does not set includeIds when no update/delete operations', () => {
    const { contextInput } = defineEntity({
      name: 'meal',
      schema: z.object({ items: z.array(z.string()) }),
      operations: {
        create: { confidence: 'low' },
      },
    })

    expect(contextInput.includeIds).toBeUndefined()
  })

  it('returns provided label', () => {
    const result = defineEntity({
      name: 'forcingFunction',
      label: 'Forcing Function',
      schema: z.object({ what: z.string() }),
      operations: { create: { confidence: 'low' } },
    })

    expect(result.label).toBe('Forcing Function')
  })

  it('defaults label to capitalize(name) when not provided', () => {
    const result = defineEntity({
      name: 'thread',
      schema: z.object({ title: z.string() }),
      operations: { update: { confidence: 'high' } },
    })

    expect(result.label).toBe('Thread')
  })

  it('returns provided displayField', () => {
    const result = defineEntity({
      name: 'cue',
      displayField: 'cueText',
      schema: z.object({ cueText: z.string() }),
      operations: { update: { confidence: 'medium' } },
    })

    expect(result.displayField).toBe('cueText')
  })

  it('has undefined displayField when not provided', () => {
    const result = defineEntity({
      name: 'meal',
      schema: z.object({ items: z.array(z.string()) }),
      operations: { create: { confidence: 'low' } },
    })

    expect(result.displayField).toBeUndefined()
  })

  it('uses custom action descriptions', () => {
    const { actions } = defineEntity({
      name: 'thread',
      schema: z.object({ title: z.string() }),
      operations: {
        update: {
          confidence: 'high',
          description: 'Propose a change to a CEO-level thread. Requires approval.',
        },
      },
    })

    expect(actions.updateThread.description).toBe('Propose a change to a CEO-level thread. Requires approval.')
  })

  it('works cleanly with crud() in a real entity definition', () => {
    const { actions } = defineEntity({
      name: 'task',
      schema: z.object({
        title: z.string(),
        due: z.string().optional(),
        status: z.enum(['open', 'done']).optional(),
      }),
      operations: crud({ create: 'low', update: 'medium', delete: 'medium' }),
    })

    expect(Object.keys(actions)).toEqual(['createTask', 'updateTask', 'deleteTask'])
    expect(actions.updateTask.schema.safeParse({
      id: 'task-1',
      updates: { status: 'done' },
    }).success).toBe(true)
  })
})
