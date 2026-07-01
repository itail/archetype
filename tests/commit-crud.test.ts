import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { commitCrud, validateCrudActions } from '../src/engine/crud.js'
import type { CrudAction, TurnTrace } from '../src/types.js'
import type { CrudEntityHandler } from '../src/engine/crud.js'
import { createTrace } from '../src/engine/chat.js'

const mockHandler: CrudEntityHandler = {
  create: vi.fn().mockResolvedValue({ success: true, data: { id: 'created' } }),
  update: vi.fn().mockResolvedValue({ success: true }),
  delete: vi.fn().mockResolvedValue({ success: true }),
}

describe('commitCrud', () => {
  it('dispatches create to the correct entity handler', async () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'task', id: 'task-1', params: { title: 'Test' } },
    ]
    const results = await commitCrud(actions, { task: mockHandler })
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
    expect(mockHandler.create).toHaveBeenCalledWith('task-1', { title: 'Test' })
  })

  it('dispatches update and delete correctly', async () => {
    const actions: CrudAction[] = [
      { operation: 'update', entity: 'task', id: 'task-1', params: { title: 'Updated' } },
      { operation: 'delete', entity: 'task', id: 'task-2' },
    ]
    const results = await commitCrud(actions, { task: mockHandler })
    expect(results).toHaveLength(2)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(true)
    expect(mockHandler.update).toHaveBeenCalledWith('task-1', { title: 'Updated' })
    expect(mockHandler.delete).toHaveBeenCalledWith('task-2')
  })

  it('returns error for missing entity handler', async () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'unknown', id: 'x', params: { foo: 'bar' } },
    ]
    const results = await commitCrud(actions, {})
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('No handler for entity: unknown')
  })

  it('returns error for missing operation handler', async () => {
    const actions: CrudAction[] = [
      { operation: 'delete', entity: 'task', id: 'task-1' },
    ]
    const results = await commitCrud(actions, { task: { create: mockHandler.create } })
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('No delete handler')
  })

  it('catches handler exceptions', async () => {
    const failing: CrudEntityHandler = {
      create: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    }
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'task', id: 'task-1', params: { title: 'Test' } },
    ]
    const results = await commitCrud(actions, { task: failing })
    expect(results[0].success).toBe(false)
    expect(results[0].error).toBe('DB connection lost')
  })

  it('populates trace.domainActions with timing', async () => {
    const trace = createTrace()
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'task', id: 'task-1', params: { title: 'Test' } },
    ]
    await commitCrud(actions, { task: mockHandler }, { trace })
    expect(trace.domainActions).toHaveLength(1)
    expect(trace.domainActions[0].name).toBe('create_task')
    expect(trace.domainActions[0].status).toBe('executed')
    expect(trace.domainActions[0].durationMs).toBeDefined()
  })

  it('records failures in trace', async () => {
    const trace = createTrace()
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'missing', id: 'x', params: {} },
    ]
    await commitCrud(actions, {}, { trace })
    expect(trace.domainActions[0].status).toBe('failed')
    expect(trace.domainActions[0].error).toContain('No handler')
  })

  it('returns results 1:1 with input actions', async () => {
    const actions: CrudAction[] = [
      { operation: 'create', entity: 'task', id: 't1', params: { title: 'A' } },
      { operation: 'create', entity: 'missing', id: 't2', params: {} },
      { operation: 'update', entity: 'task', id: 't1', params: { title: 'B' } },
    ]
    const results = await commitCrud(actions, { task: mockHandler })
    expect(results).toHaveLength(3)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(false)
    expect(results[2].success).toBe(true)
  })
})

describe('operation restrictions', () => {
  it('rejects operations the host does not implement, with the supported list', () => {
    const { valid, invalid } = validateCrudActions(
      [
        { operation: 'update', entity: 'weight', id: 'w1', params: { lbs: 180 } },
        { operation: 'create', entity: 'weight', params: { lbs: 180 } },
      ],
      { weight: { schema: z.object({ lbs: z.number() }), operations: ['create', 'delete'] } },
    )
    expect(invalid).toHaveLength(1)
    expect(invalid[0].error).toContain('does not support update')
    expect(invalid[0].error).toContain('supported: create, delete')
    expect(valid).toHaveLength(1)
  })
})
