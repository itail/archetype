import { describe, it, expect, vi } from 'vitest'
import {
  createBatch,
  updateActionStatus,
  editActionParams,
  commitBatch,
  summarizeBatch,
} from '../src/engine/staging.js'
import type { ParsedAction, ActionDefinition } from '../src/types.js'
import { z } from 'zod'

const actionDefs: Record<string, ActionDefinition> = {
  saveMemory: {
    description: 'Save a memory',
    schema: z.object({ content: z.string(), category: z.string() }),
    confidence: 'low',
  },
  updateThread: {
    description: 'Update a thread',
    schema: z.object({ id: z.string(), field: z.string(), value: z.string() }),
    confidence: 'medium',
  },
  deleteThread: {
    description: 'Delete a thread',
    schema: z.object({ id: z.string() }),
    confidence: 'high',
  },
}

describe('createBatch', () => {
  it('valid actions → all pending with annotations', () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
    ]

    const batch = createBatch(actions, actionDefs)

    expect(batch.actions).toHaveLength(2)
    expect(batch.actions.every(a => a.status === 'pending')).toBe(true)
    expect(batch.actions[0].annotation).toContain('saveMemory')
    expect(batch.actions[1].annotation).toContain('updateThread')
    expect(batch.actions[0].index).toBe(0)
    expect(batch.actions[1].index).toBe(1)
  })

  it('unknown action name → rejected', () => {
    const actions: ParsedAction[] = [
      { name: 'nonexistent', params: { foo: 'bar' }, confidence: 'medium' },
    ]

    const batch = createBatch(actions, actionDefs)

    expect(batch.actions[0].status).toBe('rejected')
    expect(batch.actions[0].annotation).toContain('Unknown action: nonexistent')
  })

  it('bad params → rejected with Zod error', () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 123 }, confidence: 'low' },
    ]

    const batch = createBatch(actions, actionDefs)

    expect(batch.actions[0].status).toBe('rejected')
    expect(batch.actions[0].annotation).toContain('Invalid params')
  })

  it('empty array → empty batch', () => {
    const batch = createBatch([], actionDefs)

    expect(batch.actions).toHaveLength(0)
    expect(batch.id).toBeTruthy()
  })

  it('generates unique batch IDs', () => {
    const a = createBatch([], actionDefs)
    const b = createBatch([], actionDefs)

    expect(a.id).not.toBe(b.id)
  })
})

describe('updateActionStatus', () => {
  const actions: ParsedAction[] = [
    { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
  ]

  it('accept a pending action', () => {
    const batch = createBatch(actions, actionDefs)
    const updated = updateActionStatus(batch, 0, 'accepted')

    expect(updated.actions[0].status).toBe('accepted')
    expect(updated.actions[1].status).toBe('pending') // untouched
    expect(batch.actions[0].status).toBe('pending')    // original immutable
  })

  it('reject a pending action', () => {
    const batch = createBatch(actions, actionDefs)
    const updated = updateActionStatus(batch, 1, 'rejected')

    expect(updated.actions[1].status).toBe('rejected')
  })

  it('throws RangeError on out-of-bounds index', () => {
    const batch = createBatch(actions, actionDefs)

    expect(() => updateActionStatus(batch, 5, 'accepted')).toThrow(RangeError)
    expect(() => updateActionStatus(batch, -1, 'accepted')).toThrow(RangeError)
  })
})

describe('editActionParams', () => {
  const actions: ParsedAction[] = [
    { name: 'saveMemory', params: { content: 'old', category: 'general' }, confidence: 'low' },
    { name: 'updateThread', params: { id: '1', field: 'title', value: 'old' }, confidence: 'medium' },
  ]

  it('valid edit updates params and annotation', () => {
    const batch = createBatch(actions, actionDefs)
    const edited = editActionParams(batch, 0, { content: 'new', category: 'insight' }, actionDefs)

    expect(edited.actions[0].validatedParams).toEqual({ content: 'new', category: 'insight' })
    expect(edited.actions[0].annotation).toContain('insight')
    // Original untouched
    expect(batch.actions[0].validatedParams).toEqual({ content: 'old', category: 'general' })
  })

  it('invalid edit throws', () => {
    const batch = createBatch(actions, actionDefs)

    expect(() => editActionParams(batch, 0, { content: 123 }, actionDefs)).toThrow('Invalid params')
  })

  it('preserves other actions', () => {
    const batch = createBatch(actions, actionDefs)
    const edited = editActionParams(batch, 0, { content: 'new', category: 'general' }, actionDefs)

    expect(edited.actions[1]).toEqual(batch.actions[1])
  })
})

describe('commitBatch', () => {
  it('runs only accepted actions', async () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
      { name: 'deleteThread', params: { id: '2' }, confidence: 'high' },
    ]

    let batch = createBatch(actions, actionDefs)
    batch = updateActionStatus(batch, 0, 'accepted')
    batch = updateActionStatus(batch, 1, 'rejected')
    batch = updateActionStatus(batch, 2, 'accepted')

    const handler = vi.fn().mockResolvedValue({ success: true })
    const result = await commitBatch(batch, {
      saveMemory: handler,
      updateThread: handler,
      deleteThread: handler,
    })

    expect(handler).toHaveBeenCalledTimes(2)
    expect(result.results).toHaveLength(2)
    expect(result.results.every(r => r.success)).toBe(true)
  })

  it('skips rejected and pending actions', async () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
    ]

    let batch = createBatch(actions, actionDefs)
    batch = updateActionStatus(batch, 0, 'rejected')
    // index 1 stays pending

    const handler = vi.fn().mockResolvedValue({ success: true })
    const result = await commitBatch(batch, { saveMemory: handler, updateThread: handler })

    expect(handler).not.toHaveBeenCalled()
    expect(result.results).toHaveLength(0)
  })

  it('handles handler errors gracefully', async () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]

    let batch = createBatch(actions, actionDefs)
    batch = updateActionStatus(batch, 0, 'accepted')

    const handler = vi.fn().mockRejectedValue(new Error('DB failed'))
    const result = await commitBatch(batch, { saveMemory: handler })

    expect(result.results[0].success).toBe(false)
    expect(result.results[0].error).toContain('DB failed')
  })

  it('returns correct summary', async () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
      { name: 'deleteThread', params: { id: '2' }, confidence: 'high' },
    ]

    let batch = createBatch(actions, actionDefs)
    batch = updateActionStatus(batch, 0, 'accepted')
    batch = updateActionStatus(batch, 1, 'rejected')
    // index 2 stays pending

    const handler = vi.fn().mockResolvedValue({ success: true })
    const result = await commitBatch(batch, { saveMemory: handler })

    expect(result.summary.total).toBe(3)
    expect(result.summary.accepted).toBe(1)
    expect(result.summary.rejected).toBe(1)
    expect(result.summary.pending).toBe(1)
    expect(result.summary.acceptedLabels).toHaveLength(1)
    expect(result.summary.rejectedLabels).toHaveLength(1)
  })
})

describe('summarizeBatch', () => {
  it('counts actions by status', () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'a', category: 'general' }, confidence: 'low' },
      { name: 'saveMemory', params: { content: 'b', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'x' }, confidence: 'medium' },
    ]

    let batch = createBatch(actions, actionDefs)
    batch = updateActionStatus(batch, 0, 'accepted')
    batch = updateActionStatus(batch, 1, 'accepted')
    batch = updateActionStatus(batch, 2, 'rejected')

    const summary = summarizeBatch(batch)

    expect(summary.total).toBe(3)
    expect(summary.accepted).toBe(2)
    expect(summary.rejected).toBe(1)
    expect(summary.pending).toBe(0)
  })

  it('builds labels from annotations', () => {
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'deleteThread', params: { id: '1' }, confidence: 'high' },
    ]

    let batch = createBatch(actions, actionDefs)
    batch = updateActionStatus(batch, 0, 'accepted')
    batch = updateActionStatus(batch, 1, 'rejected')

    const summary = summarizeBatch(batch)

    expect(summary.acceptedLabels).toHaveLength(1)
    expect(summary.acceptedLabels[0]).toContain('saveMemory')
    expect(summary.rejectedLabels).toHaveLength(1)
    expect(summary.rejectedLabels[0]).toContain('deleteThread')
  })
})
