import { describe, it, expect, vi } from 'vitest'
import { reviewMemories, compactMemories } from '../src/managed/memory-review.js'
import type { StorageAdapter, Memory, LLMProvider } from '../src/types.js'

function makeMockAdapter(memories: Memory[]): StorageAdapter {
  const store = [...memories]
  return {
    loadMemories: vi.fn().mockResolvedValue(store),
    deleteMemory: vi.fn().mockImplementation(async (id: string) => {
      const idx = store.findIndex(m => m.id === id)
      if (idx >= 0) store.splice(idx, 1)
    }),
    saveMemory: vi.fn().mockImplementation(async (mem: Omit<Memory, 'id'>) => {
      const id = `reviewed-${store.length}`
      store.push({ ...mem, id })
      return id
    }),
    // Stubs for unused methods
    getActiveConversation: vi.fn(),
    createConversation: vi.fn(),
    endConversation: vi.fn(),
    getMessages: vi.fn(),
    saveMessage: vi.fn(),
    updateMemory: vi.fn(),
  } as unknown as StorageAdapter
}

function makeMockProvider(compactedResult: Array<{ content: string; category: string }>): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      text: JSON.stringify({ compacted: compactedResult }),
    }),
  }
}

describe('reviewMemories', () => {
  const oldDate = '2020-01-01T00:00:00.000Z' // very old

  it('reviews old non-pinned memories', async () => {
    const memories: Memory[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      content: `Memory ${i}`,
      category: 'general',
      pinned: false,
      createdAt: oldDate,
    }))

    const adapter = makeMockAdapter(memories)
    const provider = makeMockProvider([
      { content: 'Reviewed insight A', category: 'general' },
      { content: 'Reviewed insight B', category: 'strategic_context' },
    ])

    const result = await reviewMemories({
      adapter,
      provider,
      memoryPurpose: 'Keep the sharpest durable context for future conversations.',
      categoryDescriptions: {
        general: 'General long-term context',
        strategic_context: 'High-level context that should shape future reasoning',
      },
    })

    expect(result.removed).toBe(8)
    expect(result.created).toBe(2)
    expect(adapter.deleteMemory).toHaveBeenCalledTimes(8)
    expect(adapter.saveMemory).toHaveBeenCalledTimes(2)
    const systemPrompt = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].systemPrompt
    expect(systemPrompt).toContain('MEMORY PURPOSE:')
    expect(systemPrompt).toContain('future conversations')
    expect(systemPrompt).toContain('MEMORY CATEGORIES:')
  })

  it('preserves pinned memories', async () => {
    const memories: Memory[] = [
      { id: 'p1', content: 'Pinned', category: 'values', pinned: true, createdAt: oldDate },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        content: `Memory ${i}`,
        category: 'general',
        pinned: false,
        createdAt: oldDate,
      })),
    ]

    const adapter = makeMockAdapter(memories)
    const provider = makeMockProvider([
      { content: 'Reviewed', category: 'general' },
    ])

    const result = await reviewMemories({ adapter, provider })

    // Only the 6 non-pinned should be candidates
    expect(result.removed).toBe(6)
    // Pinned memory should not be deleted
    const deleteIds = (adapter.deleteMemory as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(deleteIds).not.toContain('p1')
  })

  it('reviews even a single old memory (no minimum)', async () => {
    const memories: Memory[] = [
      { id: 'm1', content: 'Always add tomato', category: 'preference', pinned: false, createdAt: oldDate },
    ]

    const adapter = makeMockAdapter(memories)
    const provider = makeMockProvider([
      { content: 'Enjoys tomatoes as a regular addition to meals', category: 'preference' },
    ])

    const result = await reviewMemories({ adapter, provider })

    expect(result.removed).toBe(1)
    expect(result.created).toBe(1)
    expect(provider.chat).toHaveBeenCalledTimes(1)
  })

  it('skips when no candidates (all recent)', async () => {
    const recentDate = new Date().toISOString()
    const memories: Memory[] = [
      { id: 'm1', content: 'Mem 1', category: 'general', pinned: false, createdAt: recentDate },
      { id: 'm2', content: 'Mem 2', category: 'general', pinned: false, createdAt: recentDate },
    ]

    const adapter = makeMockAdapter(memories)
    const provider = makeMockProvider([])

    const result = await reviewMemories({ adapter, provider })

    expect(result.removed).toBe(0)
    expect(result.created).toBe(0)
    expect(provider.chat).not.toHaveBeenCalled()
  })

  it('handles LLM parse failure gracefully', async () => {
    const memories: Memory[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      content: `Memory ${i}`,
      category: 'general',
      pinned: false,
      createdAt: oldDate,
    }))

    const adapter = makeMockAdapter(memories)
    const provider: LLMProvider = {
      name: 'mock',
      chat: vi.fn().mockResolvedValue({ text: 'not valid json' }),
    }

    const result = await reviewMemories({ adapter, provider })

    expect(result.removed).toBe(0)
    expect(result.created).toBe(0)
  })

  it('respects maxAge parameter', async () => {
    const recentDate = new Date().toISOString() // today
    const memories: Memory[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `old${i}`,
        content: `Old memory ${i}`,
        category: 'general',
        pinned: false,
        createdAt: oldDate,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `new${i}`,
        content: `Recent memory ${i}`,
        category: 'general',
        pinned: false,
        createdAt: recentDate,
      })),
    ]

    const adapter = makeMockAdapter(memories)
    const provider = makeMockProvider([
      { content: 'Reviewed old', category: 'general' },
    ])

    const result = await reviewMemories({ adapter, provider, maxAge: 1 })

    // Only the 5 old memories should be reviewed
    expect(result.removed).toBe(5)
    const deleteIds = (adapter.deleteMemory as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    for (const id of deleteIds) {
      expect(id).toMatch(/^old/)
    }
  })

  it('includes anti-boxing framing in review prompt', async () => {
    const memories: Memory[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      content: `Memory ${i}`,
      category: 'general',
      pinned: false,
      createdAt: oldDate,
    }))

    const adapter = makeMockAdapter(memories)
    const provider = makeMockProvider([
      { content: 'Reviewed', category: 'general' },
    ])

    await reviewMemories({ adapter, provider })

    const systemPrompt = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].systemPrompt
    // Anti-boxing now distinguishes behavioral rules (soften) from stated user
    // facts (never invert) — the fix for the memory-inversion failure.
    expect(systemPrompt).toContain('Soften only genuine BEHAVIORAL boxing')
    expect(systemPrompt).toContain('NEVER be negated, inverted')
  })

  it('deprecated compactMemories alias works', () => {
    expect(compactMemories).toBe(reviewMemories)
  })
})
