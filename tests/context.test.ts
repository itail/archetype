import { describe, it, expect } from 'vitest'
import { serializeContextBlock, serializeAllContext } from '../src/core/context.js'
import type { ContextInputDefinition } from '../src/types.js'

describe('serializeContextBlock', () => {
  it('serializes an array of strings as list', () => {
    const def: ContextInputDefinition = { label: 'TOPICS', format: 'list' }
    const result = serializeContextBlock('topics', def, ['Revenue', 'Hiring', 'Product'])
    expect(result).toContain('--- TOPICS ---')
    expect(result).toContain('- Revenue')
    expect(result).toContain('- Hiring')
    expect(result).toContain('- Product')
  })

  it('serializes an array of objects with IDs (default format)', () => {
    const def: ContextInputDefinition = { label: 'OPEN THREADS', format: 'list' }
    const data = [
      { id: 't1', title: 'Revenue growth', status: 'active', owner: 'Alice' },
      { id: 't2', title: 'Hiring pipeline', status: 'stuck' },
    ]
    const result = serializeContextBlock('threads', def, data)
    expect(result).toContain('[t1]')
    expect(result).toContain('Revenue growth')
    expect(result).toContain('[active]')
    expect(result).toContain('owner=Alice')
  })

  it('serializes with includeIds for AI mutation', () => {
    const def: ContextInputDefinition = { label: 'THREADS', format: 'list', includeIds: true }
    const data = [
      { id: 'abc', title: 'Revenue growth', status: 'active', owner: 'Alice' },
      { id: 'def', title: 'Platform migration', status: 'stuck', owner: 'CTO' },
    ]
    const result = serializeContextBlock('threads', def, data)
    expect(result).toContain('(id:abc)')
    expect(result).toContain('(id:def)')
    expect(result).toContain('[active]')
    expect(result).toContain('Revenue growth')
    // Without includeIds, IDs would be in square brackets at end
    expect(result).not.toContain('[abc]')
  })

  it('shows (none) for empty arrays', () => {
    const def: ContextInputDefinition = { label: 'ITEMS', format: 'list' }
    const result = serializeContextBlock('items', def, [])
    expect(result).toContain('(none)')
  })

  it('returns empty for null data', () => {
    const def: ContextInputDefinition = { label: 'ITEMS', format: 'list' }
    expect(serializeContextBlock('items', def, null)).toBe('')
  })

  it('applies budget truncation', () => {
    const def: ContextInputDefinition = { label: 'MEMORIES', budget: 50 }
    const data = 'A'.repeat(100)
    const result = serializeContextBlock('memories', def, data)
    expect(result.length).toBeLessThan(120) // label + truncation message
    expect(result).toContain('truncated')
  })

  it('marks critical priority', () => {
    const def: ContextInputDefinition = { label: 'INJURIES', priority: 'critical' }
    const result = serializeContextBlock('injuries', def, 'Bad knee')
    expect(result).toContain('[CRITICAL]')
  })

  it('includes an intent line when provided', () => {
    const def: ContextInputDefinition = {
      label: 'CURRENT WORK ITEM',
      intent: 'The slice that should hold attention right now.',
    }
    const result = serializeContextBlock('currentWorkItem', def, 'Write the gameplay systems spec.')
    expect(result).toContain('Intent: The slice that should hold attention right now.')
    expect(result).toContain('Write the gameplay systems spec.')
  })
})

describe('serializeAllContext', () => {
  it('serializes multiple context blocks', () => {
    const defs: Record<string, ContextInputDefinition> = {
      threads: { label: 'OPEN THREADS', format: 'list' },
      profile: { label: 'ABOUT THE USER', format: 'block' },
    }
    const data = {
      threads: [{ id: '1', title: 'Revenue' }],
      profile: { name: 'Alex', role: 'CEO' },
    }
    const result = serializeAllContext(defs, data)
    expect(result).toContain('OPEN THREADS')
    expect(result).toContain('Revenue')
    expect(result).toContain('ABOUT THE USER')
    expect(result).toContain('Alex')
  })

  it('skips undefined context data', () => {
    const defs: Record<string, ContextInputDefinition> = {
      threads: { label: 'THREADS' },
      missing: { label: 'MISSING' },
    }
    const data = { threads: ['a', 'b'] }
    const result = serializeAllContext(defs, data)
    expect(result).toContain('THREADS')
    expect(result).not.toContain('MISSING')
  })
})
