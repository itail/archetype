import { describe, it, expect, vi } from 'vitest'
import {
  executeSideEffects,
  getProposedActions,
  confirmActions,
  type SideEffectHandler,
} from '../src/engine/side-effects.js'
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

describe('approval model — yolo mode', () => {
  it('executes all actions immediately (default)', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
    ]

    const results = await executeSideEffects(
      actions,
      { saveMemory: handler, updateThread: handler },
      actionDefs,
    )

    expect(handler).toHaveBeenCalledTimes(2)
    expect(results.every(r => r.success)).toBe(true)
    expect(getProposedActions(results)).toHaveLength(0)
  })

  it('still proposes high-confidence actions even in yolo mode', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'deleteThread', params: { id: '1' }, confidence: 'high' },
    ]

    const results = await executeSideEffects(
      actions,
      { deleteThread: handler },
      actionDefs,
      { approval: { mode: 'yolo' } },
    )

    expect(handler).not.toHaveBeenCalled()
    const proposed = getProposedActions(results)
    expect(proposed).toHaveLength(1)
    expect(proposed[0].action.name).toBe('deleteThread')
  })
})

describe('approval model — propose mode', () => {
  it('proposes medium-confidence actions without executing', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
    ]

    const results = await executeSideEffects(
      actions,
      { updateThread: handler },
      actionDefs,
      { approval: { mode: 'propose' } },
    )

    expect(handler).not.toHaveBeenCalled()
    const proposed = getProposedActions(results)
    expect(proposed).toHaveLength(1)
    expect(proposed[0].validatedParams).toEqual({ id: '1', field: 'title', value: 'new' })
  })

  it('still auto-executes low-confidence actions in propose mode', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]

    const results = await executeSideEffects(
      actions,
      { saveMemory: handler },
      actionDefs,
      { approval: { mode: 'propose' } },
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(getProposedActions(results)).toHaveLength(0)
  })

  it('mixes executed and proposed based on confidence', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
      { name: 'deleteThread', params: { id: '2' }, confidence: 'high' },
    ]

    const results = await executeSideEffects(
      actions,
      { saveMemory: handler, updateThread: handler, deleteThread: handler },
      actionDefs,
      { approval: { mode: 'propose' } },
    )

    // Low executed, medium+high proposed
    expect(handler).toHaveBeenCalledTimes(1)
    const proposed = getProposedActions(results)
    expect(proposed).toHaveLength(2)
    expect(proposed.map(p => p.action.name)).toEqual(['updateThread', 'deleteThread'])
  })
})

describe('confirmActions', () => {
  it('executes previously proposed actions', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
    ]

    // Step 1: Propose
    const results = await executeSideEffects(
      actions,
      { updateThread: handler },
      actionDefs,
      { approval: { mode: 'propose' } },
    )
    expect(handler).not.toHaveBeenCalled()

    // Step 2: Confirm
    const proposed = getProposedActions(results)
    const confirmed = await confirmActions(proposed, { updateThread: handler })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(confirmed[0].success).toBe(true)
  })

  it('handles errors during confirmation', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('DB failed'))
    const actions: ParsedAction[] = [
      { name: 'updateThread', params: { id: '1', field: 'title', value: 'new' }, confidence: 'medium' },
    ]

    const results = await executeSideEffects(
      actions,
      { updateThread: handler },
      actionDefs,
      { approval: { mode: 'propose' } },
    )

    const proposed = getProposedActions(results)
    const confirmed = await confirmActions(proposed, { updateThread: handler })
    expect(confirmed[0].success).toBe(false)
    expect(confirmed[0].error).toContain('DB failed')
  })
})
