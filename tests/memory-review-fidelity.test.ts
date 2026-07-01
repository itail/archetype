import { describe, it, expect, vi } from 'vitest'
import { reviewMemories } from '../src/managed/memory-review.js'
import type { StorageAdapter, Memory, LLMProvider, LLMProviderRequest } from '../src/types.js'

// The review pass must (a) not carry a numeric cull quota, (b) protect stated
// user facts from inversion, and (c) be able to pin identity-grade facts. These
// guard the July-2026 failure: "target 1/3" eroded 90→13 memories, and the
// reviewer inverted a loved recipe technique into its opposite.

const OLD = '2020-01-01T00:00:00.000Z'

function capturingProvider(compacted: unknown[]): { provider: LLMProvider; prompt: () => string } {
  let systemPrompt = ''
  return {
    prompt: () => systemPrompt,
    provider: {
      name: 'capture',
      chat: vi.fn().mockImplementation(async (req: LLMProviderRequest) => {
        systemPrompt = req.systemPrompt
        return { text: JSON.stringify({ compacted }) }
      }),
    },
  }
}

function adapter(memories: Memory[]): { adapter: StorageAdapter; saved: Array<Omit<Memory, 'id'>> } {
  const store = [...memories]
  const saved: Array<Omit<Memory, 'id'>> = []
  return {
    saved,
    adapter: {
      loadMemories: vi.fn().mockResolvedValue(store),
      deleteMemory: vi.fn(),
      saveMemory: vi.fn().mockImplementation(async (mem: Omit<Memory, 'id'>) => {
        saved.push(mem)
        return `new-${saved.length}`
      }),
      getActiveConversation: vi.fn(),
      createConversation: vi.fn(),
      endConversation: vi.fn(),
      getMessages: vi.fn(),
      saveMessage: vi.fn(),
      updateMemory: vi.fn(),
    } as unknown as StorageAdapter,
  }
}

describe('review prompt has no cull quota and carries a fidelity guard', () => {
  it('does not instruct a numeric target like "1/3"', async () => {
    const { provider, prompt } = capturingProvider([{ content: 'x', category: 'general' }])
    const { adapter: a } = adapter([{ id: 'm0', content: 'old', category: 'general', pinned: false, createdAt: OLD }])
    await reviewMemories({ adapter: a, provider })
    const p = prompt()
    expect(p).not.toMatch(/1\/3/)
    expect(p).not.toMatch(/target roughly/i)
    // fidelity guard present
    expect(p).toMatch(/never be negated, inverted/i)
  })
})
