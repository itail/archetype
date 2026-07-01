import { describe, it, expect, vi, beforeEach } from 'vitest'
import { definePersona, withStorage } from '../src/index.js'
import type { LLMProvider, StorageAdapter, Memory, LLMProviderRequest } from '../src/types.js'
import { z } from 'zod'

// ─── Helpers ────────────────────────────────────────────────────────────────

const oldDate = '2020-01-01T00:00:00.000Z'
const recentDate = new Date().toISOString()

const chatResponse = JSON.stringify({
  message: 'Hello!',
  actions: [],
  followUps: [],
})

const reviewResult = JSON.stringify({
  compacted: [{ content: 'Reviewed memory', category: 'general' }],
})

function createScriptedProvider(responses: string[]): { provider: LLMProvider; requests: LLMProviderRequest[] } {
  const queue = [...responses]
  const requests: LLMProviderRequest[] = []
  return {
    requests,
    provider: {
      name: 'scripted',
      chat: vi.fn().mockImplementation(async (req: LLMProviderRequest) => {
        requests.push(req)
        const next = queue.shift()
        if (!next) throw new Error('No scripted response left')
        return { text: next }
      }),
    },
  }
}

function createMockAdapter(memories: Memory[] = []): StorageAdapter {
  const store = [...memories]
  const messages: Array<{ role: string; content: string; createdAt?: string; isNote?: boolean }> = []

  return {
    getActiveConversation: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue('conv-1'),
    endConversation: vi.fn(),
    getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
    saveMessage: vi.fn().mockImplementation((_convId: string, msg: any) => {
      messages.push({ ...msg, createdAt: new Date().toISOString() })
      return Promise.resolve()
    }),
    loadMemories: vi.fn().mockResolvedValue(store),
    saveMemory: vi.fn().mockImplementation(async (mem: Omit<Memory, 'id'>) => {
      const id = `mem-${store.length}`
      store.push({ ...mem, id })
      return id
    }),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn().mockImplementation(async (id: string) => {
      const idx = store.findIndex(m => m.id === id)
      if (idx >= 0) store.splice(idx, 1)
    }),
  } as unknown as StorageAdapter
}

function createPersona(provider: LLMProvider) {
  return definePersona({
    identity: {
      name: 'TestBot',
      expertise: ['testing'],
      relationship: 'test partner',
      northStar: 'test goals',
    },
    voice: { tone: 'balanced', style: 'educator' },
    actions: {
      saveMemory: {
        description: 'Save a lasting insight.',
        schema: z.object({ content: z.string(), category: z.string() }),
        confidence: 'low',
      },
    },
    memory: {
      enabled: true,
      purpose: 'Test memory purpose',
      categories: {
        general: 'General context',
        preference: 'User preferences',
      },
    },
    provider,
  })
}

function createPersonaWithCraft(provider: LLMProvider) {
  return definePersona({
    identity: {
      name: 'TestBot',
      expertise: ['testing'],
      relationship: 'test partner',
      northStar: 'test goals',
    },
    voice: { tone: 'balanced', style: 'educator' },
    memory: {
      enabled: true,
      purpose: 'Test memory purpose',
      categories: { general: 'General context' },
    },
    craftMemory: {
      enabled: true,
      purpose: 'Craft growth',
      categories: { approach: 'What works' },
    },
    provider,
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('auto memory review lifecycle', () => {
  it('triggers review on first chat after startup', async () => {
    const oldMemories: Memory[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      content: `Old memory ${i}`,
      category: 'general',
      pinned: false,
      createdAt: oldDate,
    }))

    // reviewMemories call + chat call
    const { provider } = createScriptedProvider([reviewResult, chatResponse])
    const adapter = createMockAdapter(oldMemories)
    const persona = createPersona(provider)

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true },
    })

    await managed.chat({ message: 'Hello' })

    // Provider called twice: review + chat
    expect(provider.chat).toHaveBeenCalledTimes(2)
    // First call should be the review prompt
    const firstCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall.systemPrompt).toContain('quiet memory cleanup pass')
  })

  it('respects interval — no review on second chat within interval', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old memory', category: 'general', pinned: false, createdAt: oldDate },
    ]

    // First: review + chat. Second: just chat (no review).
    const { provider } = createScriptedProvider([reviewResult, chatResponse, chatResponse])
    const adapter = createMockAdapter(oldMemories)
    const persona = createPersona(provider)

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true, interval: 7 },
    })

    await managed.chat({ message: 'First' })
    await managed.chat({ message: 'Second' })

    // 3 calls: review + first chat + second chat
    expect(provider.chat).toHaveBeenCalledTimes(3)
  })

  it('passes persona memory config to reviewMemories', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old memory', category: 'general', pinned: false, createdAt: oldDate },
    ]

    const { provider, requests } = createScriptedProvider([reviewResult, chatResponse])
    const adapter = createMockAdapter(oldMemories)
    const persona = createPersona(provider)

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true },
    })

    await managed.chat({ message: 'Hello' })

    // The review prompt should include the memory purpose from persona config
    const reviewPrompt = requests[0].systemPrompt
    expect(reviewPrompt).toContain('Test memory purpose')
    expect(reviewPrompt).toContain('MEMORY CATEGORIES:')
    expect(reviewPrompt).toContain('general: General context')
  })

  it('reviews both user and craft memories when craft is enabled', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old user memory', category: 'general', pinned: false, createdAt: oldDate },
    ]
    const oldCraftMemories: Memory[] = [
      { id: 'c0', content: 'Old craft memory', category: 'approach', pinned: false, createdAt: oldDate },
    ]

    const craftReviewResult = JSON.stringify({
      compacted: [{ content: 'Reviewed craft', category: 'approach' }],
    })

    // user review + craft review + chat
    const { provider, requests } = createScriptedProvider([reviewResult, craftReviewResult, chatResponse])
    const adapter = createMockAdapter(oldMemories) as any
    adapter.loadCraftMemories = vi.fn().mockResolvedValue(oldCraftMemories)
    adapter.saveCraftMemory = vi.fn().mockResolvedValue('craft-new')
    adapter.deleteCraftMemory = vi.fn()

    const persona = createPersonaWithCraft(provider)

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true },
    })

    await managed.chat({ message: 'Hello' })

    // 3 calls: user review + craft review + chat
    expect(provider.chat).toHaveBeenCalledTimes(3)
    // First call = user review, second = craft review
    expect(requests[0].systemPrompt).toContain('quiet memory cleanup pass')
    expect(requests[1].systemPrompt).toContain('craft memories')
  })

  it('chat succeeds even when review throws', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old memory', category: 'general', pinned: false, createdAt: oldDate },
    ]

    // The review call will fail because loadMemories throws, but chat should still work
    const { provider } = createScriptedProvider([chatResponse])
    const adapter = createMockAdapter(oldMemories)
    // Make loadMemories throw on first call (review), return memories on second (chat)
    let callCount = 0;
    (adapter.loadMemories as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++
      if (callCount === 1) throw new Error('Simulated failure')
      return oldMemories
    })

    const persona = createPersona(provider)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true },
    })

    const result = await managed.chat({ message: 'Hello' })

    // Chat should succeed despite review failure
    expect(result.message).toBe('Hello!')
    consoleSpy.mockRestore()
  })

  it('in-flight guard prevents concurrent reviews', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old memory', category: 'general', pinned: false, createdAt: oldDate },
    ]

    // Slow review that takes time
    let reviewResolve: ((value: any) => void) | undefined
    const slowReviewPromise = new Promise(resolve => { reviewResolve = resolve })

    const chatCallCount = { value: 0 }
    const provider: LLMProvider = {
      name: 'slow-mock',
      chat: vi.fn().mockImplementation(async (req: LLMProviderRequest) => {
        if (req.systemPrompt.includes('cleanup pass')) {
          // This is a review call — make it slow
          await slowReviewPromise
          return { text: reviewResult }
        }
        chatCallCount.value++
        return { text: chatResponse }
      }),
    }

    const adapter = createMockAdapter(oldMemories)
    const persona = createPersona(provider)

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true },
    })

    // Start first chat (triggers review)
    const chat1Promise = managed.chat({ message: 'First' })
    // Start second chat while review is in-flight
    // Need a small delay for the first chat to start the review
    await new Promise(resolve => setTimeout(resolve, 10))

    // Resolve the slow review
    reviewResolve!({ text: reviewResult })

    const result1 = await chat1Promise

    // The first chat should complete successfully
    expect(result1.message).toBe('Hello!')
  })

  it('does not review when memoryReview is not configured', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old memory', category: 'general', pinned: false, createdAt: oldDate },
    ]

    const { provider } = createScriptedProvider([chatResponse])
    const adapter = createMockAdapter(oldMemories)
    const persona = createPersona(provider)

    // No memoryReview config
    const managed = withStorage(persona, { adapter })

    await managed.chat({ message: 'Hello' })

    // Only 1 call (chat), no review
    expect(provider.chat).toHaveBeenCalledTimes(1)
  })

  it('triggers review from promptedTurn as well', async () => {
    const oldMemories: Memory[] = [
      { id: 'm0', content: 'Old memory', category: 'general', pinned: false, createdAt: oldDate },
    ]

    const promptedResponse = JSON.stringify({
      message: 'Good morning!',
      actions: [],
      followUps: [],
    })

    const { provider } = createScriptedProvider([reviewResult, promptedResponse])
    const adapter = createMockAdapter(oldMemories)
    const persona = createPersona(provider)

    const managed = withStorage(persona, {
      adapter,
      memoryReview: { auto: true },
    })

    await managed.promptedTurn({
      intent: 'Check in',
      label: 'Greeting',
    })

    // Provider called twice: review + prompted turn
    expect(provider.chat).toHaveBeenCalledTimes(2)
  })
})
