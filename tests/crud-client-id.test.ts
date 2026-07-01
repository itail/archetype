import { describe, it, expect } from 'vitest'
import { validateCrudActions, resolveTempIds } from '../src/engine/crud.js'
import type { CrudAction, EntityConfig } from '../src/types.js'
import { z } from 'zod'

const testEntities: Record<string, EntityConfig> = {
  workout: {
    schema: z.object({ focus: z.string() }),
    label: 'Workout',
    displayField: 'focus',
  },
  exercise: {
    schema: z.object({
      workoutId: z.string(),
      name: z.string(),
      plannedSets: z.number(),
    }),
    label: 'Exercise',
    displayField: 'name',
  },
}

// ─── validateCrudActions: auto-ID on create ─────────────────────────────────

describe('validateCrudActions: client-generated IDs', () => {
  it('passes through AI-provided ID on create', () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'workout', id: '_w1', params: { focus: 'Push' } },
    ]
    const { valid } = validateCrudActions(actions, testEntities)
    expect(valid).toHaveLength(1)
    expect(valid[0].id).toBe('_w1')
  })

  it('generates UUID fallback when create has no ID', () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'workout', params: { focus: 'Push' } },
    ]
    const { valid } = validateCrudActions(actions, testEntities)
    expect(valid).toHaveLength(1)
    expect(valid[0].id).toBeTruthy()
    expect(valid[0].id!.startsWith('_')).toBe(false) // UUID, not temp
  })

  it('still requires ID for update', () => {
    const actions: CrudAction[] = [
      { operation: 'update', entity: 'workout', params: { focus: 'Pull' } },
    ]
    const { invalid } = validateCrudActions(actions, testEntities)
    expect(invalid).toHaveLength(1)
    expect(invalid[0].error).toContain('requires an id')
  })
})

// ─── resolveTempIds ─────────────────────────────────────────────────────────

describe('resolveTempIds', () => {
  it('resolves _ prefixed IDs to UUIDs', () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'workout', id: '_w1', params: { focus: 'Push' } },
    ]
    const resolved = resolveTempIds(actions)
    expect(resolved[0].id).not.toBe('_w1')
    expect(resolved[0].id!.length).toBeGreaterThan(10) // UUID-length
  })

  it('resolves cross-references in params', () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'workout', id: '_w1', params: { focus: 'Push' } },
      { operation: 'create', entity: 'exercise', id: '_ex1', params: { workoutId: '_w1', name: 'Bench', plannedSets: 4 } },
      { operation: 'create', entity: 'exercise', id: '_ex2', params: { workoutId: '_w1', name: 'Incline', plannedSets: 3 } },
    ]
    const resolved = resolveTempIds(actions)

    const workoutId = resolved[0].id!
    expect(workoutId).not.toBe('_w1')

    // Both exercises should reference the workout's real UUID
    expect((resolved[1].params as any).workoutId).toBe(workoutId)
    expect((resolved[2].params as any).workoutId).toBe(workoutId)

    // Exercise IDs should also be resolved
    expect(resolved[1].id).not.toBe('_ex1')
    expect(resolved[2].id).not.toBe('_ex2')
  })

  it('leaves non-prefixed IDs unchanged', () => {
    const actions: CrudAction[] = [
      { operation: 'update', entity: 'workout', id: 'real-uuid-123', params: { focus: 'Pull' } },
    ]
    const resolved = resolveTempIds(actions)
    expect(resolved[0].id).toBe('real-uuid-123')
  })

  it('returns same array when no temp IDs present', () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'workout', id: 'server-generated', params: { focus: 'Push' } },
    ]
    const resolved = resolveTempIds(actions)
    expect(resolved).toBe(actions) // Same reference — no copy needed
  })

  it('generates consistent IDs for same temp reference', () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'workout', id: '_w1', params: { focus: 'Push' } },
      { operation: 'create', entity: 'exercise', id: '_e1', params: { workoutId: '_w1', name: 'Bench', plannedSets: 4 } },
    ]
    const resolved = resolveTempIds(actions)
    // The workout's resolved ID should match the exercise's workoutId reference
    expect(resolved[0].id).toBe((resolved[1].params as any).workoutId)
  })
})
