import { describe, it, expect, vi } from 'vitest'
import {
  buildAssistantHistoryMessage,
  executeSideEffects,
  getExecutedAnnotations,
  summarizeSideEffects,
  type SideEffectHandler,
  type SideEffectResult,
} from '../src/engine/side-effects.js'
import { buildActionAnnotation, buildAnnotations } from '../src/core/actions.js'
import type { ParsedAction, ActionDefinition } from '../src/types.js'
import { z } from 'zod'

const actionDefs: Record<string, ActionDefinition> = {
  updateThread: {
    description: 'Update a thread',
    schema: z.object({ entityId: z.string(), field: z.string(), newValue: z.string() }),
    confidence: 'high',
  },
  saveMemory: {
    description: 'Save a memory',
    schema: z.object({ content: z.string(), category: z.string() }),
    confidence: 'low',
  },
}

describe('executeSideEffects', () => {
  it('executes valid action with handler', async () => {
    const handler: SideEffectHandler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]

    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('executed')
    expect(results[0].success).toBe(true)
    expect(results[0].annotation).toContain('saveMemory')
    expect(handler).toHaveBeenCalledWith({ content: 'test', category: 'general' })
  })

  it('rejects unknown action', async () => {
    const actions: ParsedAction[] = [
      { name: 'unknownAction', params: {}, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, {}, actionDefs)
    expect(results[0].status).toBe('failed')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('Unknown action')
  })

  it('rejects action with no handler', async () => {
    const actions: ParsedAction[] = [
      { name: 'updateThread', params: { entityId: '1', field: 'title', newValue: 'new' }, confidence: 'high' },
    ]
    const results = await executeSideEffects(actions, {}, actionDefs)
    expect(results[0].status).toBe('failed')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('No handler')
  })

  it('rejects invalid params via Zod', async () => {
    const handler: SideEffectHandler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 123 as unknown as string }, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results[0].status).toBe('failed')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('Invalid params')
    expect(handler).not.toHaveBeenCalled()
  })

  it('catches handler errors', async () => {
    const handler: SideEffectHandler = vi.fn().mockRejectedValue(new Error('DB error'))
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results[0].status).toBe('failed')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toContain('DB error')
  })
})

describe('assistant history helpers', () => {
  it('returns annotations only for executed actions', async () => {
    const saveHandler: SideEffectHandler = vi.fn().mockResolvedValue({ success: true })
    const results = await executeSideEffects([
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { entityId: '1', field: 'title', newValue: 'new' }, confidence: 'high' },
    ], {
      saveMemory: saveHandler,
      updateThread: vi.fn().mockResolvedValue({ success: true }),
    }, actionDefs, {
      approval: { mode: 'yolo' },
    })

    expect(getExecutedAnnotations(results)).toEqual([
      'saveMemory: content=test, category=general',
    ])
  })

  it('builds stored assistant history without proposed or failed actions', async () => {
    const results = await executeSideEffects([
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
      { name: 'updateThread', params: { entityId: '1', field: 'title', newValue: 'new' }, confidence: 'high' },
      { name: 'unknownAction', params: {}, confidence: 'low' },
    ], {
      saveMemory: vi.fn().mockResolvedValue({ success: true }),
      updateThread: vi.fn().mockResolvedValue({ success: true }),
    }, actionDefs, {
      approval: { mode: 'yolo' },
    })

    const message = buildAssistantHistoryMessage('Done.', results)
    expect(message).toContain('Done.')
    expect(message).toContain('---outcomes:')
    expect(message).toContain('saveMemory executed.')
    expect(message).toContain('updateThread')
    expect(message).toContain('unknownAction failed')
    expect(message).toContain('---actions: saveMemory:')
    expect(message).not.toContain('---actions: updateThread:')
    expect(message).not.toContain('---actions: unknownAction')
  })
})

describe('changed tracking and no_op', () => {
  it('marks no_op when handler returns success but changed: false', async () => {
    const handler: SideEffectHandler = vi.fn().mockResolvedValue({ success: true, changed: false })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results[0].status).toBe('no_op')
    expect(results[0].success).toBe(true)
    expect(results[0].changed).toBe(false)
  })

  it('marks executed with changed: true when handler reports change', async () => {
    const handler: SideEffectHandler = vi.fn().mockResolvedValue({ success: true, changed: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results[0].status).toBe('executed')
    expect(results[0].changed).toBe(true)
  })

  it('defaults changed to success when handler omits it', async () => {
    const handler: SideEffectHandler = vi.fn().mockResolvedValue({ success: true })
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results[0].status).toBe('executed')
    expect(results[0].changed).toBe(true)
  })

  it('sets changed: false on catch errors', async () => {
    const handler: SideEffectHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const actions: ParsedAction[] = [
      { name: 'saveMemory', params: { content: 'test', category: 'general' }, confidence: 'low' },
    ]
    const results = await executeSideEffects(actions, { saveMemory: handler }, actionDefs)
    expect(results[0].status).toBe('failed')
    expect(results[0].changed).toBe(false)
  })
})

describe('summarizeSideEffects', () => {
  it('returns none for empty results', () => {
    const outcome = summarizeSideEffects([])
    expect(outcome.status).toBe('none')
    expect(outcome.attemptedActions).toEqual([])
  })

  it('returns succeeded when all actions changed', () => {
    const results: SideEffectResult[] = [
      { action: { name: 'a', params: {}, confidence: 'low' }, status: 'executed', success: true, changed: true },
      { action: { name: 'b', params: {}, confidence: 'low' }, status: 'executed', success: true, changed: true },
    ]
    const outcome = summarizeSideEffects(results)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.appliedActions).toEqual(['a', 'b'])
    expect(outcome.errors).toEqual([])
  })

  it('returns partial when some changed and some failed', () => {
    const results: SideEffectResult[] = [
      { action: { name: 'a', params: {}, confidence: 'low' }, status: 'executed', success: true, changed: true },
      { action: { name: 'b', params: {}, confidence: 'low' }, status: 'failed', success: false, changed: false, error: 'bad id' },
    ]
    const outcome = summarizeSideEffects(results)
    expect(outcome.status).toBe('partial')
    expect(outcome.appliedActions).toEqual(['a'])
    expect(outcome.errors).toEqual(['bad id'])
  })

  it('returns failed when nothing changed and there are errors', () => {
    const results: SideEffectResult[] = [
      { action: { name: 'a', params: {}, confidence: 'low' }, status: 'failed', success: false, changed: false, error: 'not found' },
    ]
    const outcome = summarizeSideEffects(results)
    expect(outcome.status).toBe('failed')
    expect(outcome.appliedActions).toEqual([])
  })

  it('returns no_op when handlers succeeded but nothing changed', () => {
    const results: SideEffectResult[] = [
      { action: { name: 'a', params: {}, confidence: 'low' }, status: 'no_op', success: true, changed: false },
    ]
    const outcome = summarizeSideEffects(results)
    expect(outcome.status).toBe('no_op')
    expect(outcome.summary).toContain('nothing changed')
  })

  it('skips proposed actions in summary', () => {
    const results: SideEffectResult[] = [
      { action: { name: 'a', params: {}, confidence: 'low' }, status: 'executed', success: true, changed: true },
      { action: { name: 'b', params: {}, confidence: 'high' }, status: 'proposed', success: true },
    ]
    const outcome = summarizeSideEffects(results)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.attemptedActions).toEqual(['a'])
  })
})

describe('buildActionAnnotation', () => {
  it('builds annotation string', () => {
    const annotation = buildActionAnnotation('saveMemory', { content: 'CEO values transparency', category: 'values' })
    expect(annotation).toBe('saveMemory: content=CEO values transparency, category=values')
  })

  it('handles nested params', () => {
    const annotation = buildActionAnnotation('updateThread', { entityId: '1', field: 'tags', newValue: JSON.stringify(['a', 'b']) })
    expect(annotation).toContain('entityId=1')
  })
})

describe('buildAnnotations', () => {
  it('builds multiple annotations', () => {
    const annotations = buildAnnotations([
      { name: 'saveMemory', params: { content: 'test', category: 'general' } },
      { name: 'updateThread', params: { entityId: '1', field: 'title', newValue: 'new' } },
    ])
    expect(annotations).toHaveLength(2)
    expect(annotations[0]).toContain('saveMemory')
    expect(annotations[1]).toContain('updateThread')
  })
})
