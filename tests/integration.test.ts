import { describe, it, expect, vi } from 'vitest'
import { definePersona, withStorage } from '../src/index.js'
import type { LLMProvider, StorageAdapter, Memory, Message, Conversation } from '../src/types.js'
import { z } from 'zod'

// ─── Mock Provider ───────────────────────────────────────────────────────────

function createMockProvider(responseOverride?: string | string[]): LLMProvider {
  const defaultResponse = JSON.stringify({
    message: "I see you're thinking about revenue. What's the one decision that would unlock the most progress?",
    actions: [
      { name: 'saveMemory', params: { content: 'CEO focused on revenue growth', category: 'strategic_context' } },
    ],
    followUps: ['What does success look like by end of Q2?'],
  })

  const responses = Array.isArray(responseOverride)
    ? [...responseOverride]
    : [responseOverride ?? defaultResponse]

  return {
    name: 'mock',
    chat: vi.fn().mockImplementation(async () => ({ text: responses.shift() ?? defaultResponse })),
  }
}

// ─── definePersona + stateless chat ──────────────────────────────────────────

describe('definePersona + chat', () => {
  it('creates a persona and runs stateless chat', async () => {
    const provider = createMockProvider()
    const persona = definePersona({
      identity: {
        name: 'Coach',
        expertise: ['executive coaching'],
        relationship: 'trusted thinking partner',
        northStar: "CEO's growth",
      },
      voice: { tone: 'balanced', style: 'educator' },
      actions: {
        saveMemory: {
          description: 'Save a lasting insight.',
          schema: z.object({ content: z.string(), category: z.string() }),
          confidence: 'low',
        },
      },
      eq: { frequencyRule: true },
      provider,
    })

    expect(persona.name).toBe('Coach')
    expect(persona.providerName).toBe('mock')

    const result = await persona.chat({
      message: 'I need to figure out our revenue strategy',
      history: [],
      context: {},
    })

    expect(result.message).toContain('revenue')
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].name).toBe('saveMemory')
    expect(result.actions[0].confidence).toBe('low')
    expect(result.followUps).toHaveLength(1)

    // Verify the provider was called with a system prompt
    expect(provider.chat).toHaveBeenCalledTimes(1)
    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('You are Coach')
    expect(call.systemPrompt).toContain('Continuity:')
    expect(call.message).toBe('I need to figure out our revenue strategy')
  })

  it('filters actions not in defined actions', async () => {
    const response = JSON.stringify({
      message: 'OK',
      actions: [
        { name: 'saveMemory', params: { content: 'test', category: 'general' } },
        { name: 'unknownAction', params: { foo: 'bar' } },
      ],
    })
    const provider = createMockProvider(response)
    const persona = definePersona({
      identity: { name: 'Test', expertise: ['testing'], relationship: 'tester', northStar: 'quality' },
      voice: { tone: 'direct', style: 'quick' },
      actions: {
        saveMemory: {
          description: 'Save memory',
          schema: z.object({ content: z.string(), category: z.string() }),
          confidence: 'low',
        },
      },
      provider,
    })

    const result = await persona.chat({ message: 'test' })
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].name).toBe('saveMemory')
  })

  it('handles JSON parse failure gracefully', async () => {
    const provider = createMockProvider('This is just a plain text response, not JSON')
    const persona = definePersona({
      identity: { name: 'Test', expertise: ['testing'], relationship: 'tester', northStar: 'quality' },
      voice: { tone: 'direct', style: 'quick' },
      provider,
    })

    const result = await persona.chat({ message: 'test' })
    expect(result.message).toContain('plain text response')
    expect(result.actions).toEqual([])
  })

  it('handles stringified params from Gemini (flat union quirk)', async () => {
    const provider = createMockProvider(JSON.stringify({
      message: 'Cleaning up duplicates.',
      actions: [
        { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content": "CEO likes direct feedback", "category": "preference"}' } },
      ],
    }))

    const persona = definePersona({
      identity: { name: 'Test', expertise: ['testing'], relationship: 'tester', northStar: 'quality' },
      voice: { tone: 'direct', style: 'quick' },
      memory: { enabled: true },
      provider,
    })

    const result = await persona.chat({ message: 'test' })
    expect(result.crudActions).toHaveLength(1)
    expect(result.crudActions![0].entity).toBe('memory')
    expect(result.crudActions![0].params).toEqual({ content: 'CEO likes direct feedback', category: 'preference' })
  })

  it('retries once when an action has invalid params and uses the repaired action', async () => {
    const provider = createMockProvider([
      JSON.stringify({
        message: 'I updated it.',
        actions: [
          { name: 'updateThread', params: { updates: { status: 'stuck' } } },
        ],
      }),
      JSON.stringify({
        message: 'I updated it.',
        actions: [
          { name: 'updateThread', params: { id: 'thread-1', updates: { status: 'stuck' } } },
        ],
      }),
    ])

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      actions: {
        updateThread: {
          description: 'Update a thread by id.',
          schema: z.object({
            id: z.string(),
            updates: z.object({ status: z.string().optional() }).partial(),
          }),
          confidence: 'medium',
        },
      },
      provider,
    })

    const result = await persona.chat({ message: 'Mark thread-1 as stuck.' })

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({
      name: 'updateThread',
      params: { id: 'thread-1', updates: { status: 'stuck' } },
    })
    expect(provider.chat).toHaveBeenCalledTimes(2)

    const repairCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(repairCall.message).toContain('Invalid actions:')
    expect(repairCall.message).toContain('updateThread')
  })

  it('drops invalid actions safely when the repair response is still malformed', async () => {
    const provider = createMockProvider([
      JSON.stringify({
        message: 'I updated it.',
        actions: [
          { name: 'updateThread', params: { updates: { status: 'stuck' } } },
        ],
      }),
      JSON.stringify({
        message: 'I updated it.',
        actions: [
          { name: 'updateThread', params: { updates: { status: 'still missing id' } } },
        ],
      }),
    ])

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      actions: {
        updateThread: {
          description: 'Update a thread by id.',
          schema: z.object({
            id: z.string(),
            updates: z.object({ status: z.string().optional() }).partial(),
          }),
          confidence: 'medium',
        },
      },
      provider,
    })

    const result = await persona.chat({ message: 'Mark thread-1 as stuck.' })

    expect(result.message).toBe('I updated it.')
    expect(result.actions).toEqual([])
    expect(provider.chat).toHaveBeenCalledTimes(2)
  })
})

// ─── withStorage (managed mode) ──────────────────────────────────────────────

describe('withStorage', () => {
  function createMockAdapter(): StorageAdapter {
    const messages: Message[] = []
    const memories: Memory[] = []

    return {
      getActiveConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      endConversation: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
      saveMessage: vi.fn().mockImplementation((_convId, msg) => {
        messages.push({ ...msg, createdAt: new Date().toISOString() })
        return Promise.resolve()
      }),
      loadMemories: vi.fn().mockResolvedValue(memories),
      saveMemory: vi.fn().mockImplementation((mem) => {
        const id = `mem-${memories.length + 1}`
        memories.push({ ...mem, id })
        return Promise.resolve(id)
      }),
      updateMemory: vi.fn().mockResolvedValue(undefined),
      deleteMemory: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('auto-creates conversation and persists messages', async () => {
    const provider = createMockProvider()
    const adapter = createMockAdapter()

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      actions: {
        saveMemory: {
          description: 'Save memory',
          schema: z.object({ content: z.string(), category: z.string() }),
          confidence: 'low',
        },
      },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    const result = await managed.chat({
      message: 'Help me think about revenue',
    })

    expect(result.conversationId).toBe('conv-1')
    expect(result.message).toContain('revenue')

    // Verify conversation was created
    expect(adapter.createConversation).toHaveBeenCalledWith('manual', undefined)

    // Verify messages were saved (user + assistant)
    expect(adapter.saveMessage).toHaveBeenCalledTimes(2)
    const userMsg = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(userMsg[1].role).toBe('user')
    const assistantMsg = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(assistantMsg[1].role).toBe('assistant')
  })

  it('persists memory CRUD mutations through managed chat', async () => {
    const provider = createMockProvider(JSON.stringify({
      message: 'Noted.',
      actions: [
        {
          name: 'crud',
          params: {
            operation: 'create',
            entity: 'memory',
            params: '{"content":"Revenue is the top priority this quarter.","category":"strategic_context"}',
          },
        },
      ],
      outcomeNotes: ['Saved a durable strategic priority memory.'],
    }))
    const adapter = createMockAdapter()

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      memory: { enabled: true },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    await managed.chat({ message: 'Revenue is my top priority' })

    expect(adapter.saveMemory).toHaveBeenCalled()
    const savedMem = (adapter.saveMemory as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(savedMem.content).toContain('Revenue')
  })

  it('persists app-owned domain CRUD outcomes into managed history', async () => {
    const provider = createMockProvider([
      JSON.stringify({
        message: 'I added it.',
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'task',
              id: '_task1',
              params: { title: 'Close books' },
            },
          },
        ],
        outcomeNotes: [],
      }),
      JSON.stringify({
        message: 'The books task is now part of the plan.',
        actions: [],
        outcomeNotes: [],
      }),
    ])
    const adapter = createMockAdapter()
    const createTask = vi.fn().mockResolvedValue({ success: true, data: { label: 'Close books' } })

    const persona = definePersona({
      identity: { name: 'Ops', expertise: ['operations'], relationship: 'operator', northStar: 'truthful state' },
      voice: { tone: 'balanced', style: 'educator' },
      entities: {
        task: {
          label: 'Task',
          displayField: 'title',
          description: 'A durable task.',
          schema: z.object({ title: z.string() }),
        },
      },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    const first = await managed.chat({
      message: 'Add a close-books task',
      domainCrud: {
        handlers: {
          task: { create: createTask },
        },
        summarize: ({ actions, results }) => {
          const created = actions.filter((action, index) =>
            action.entity === 'task' && action.operation === 'create' && results[index]?.success,
          )
          return created.length > 0 ? [`Created ${created.length} task: Close books.`] : []
        },
      },
    })

    expect(createTask).toHaveBeenCalledWith(expect.any(String), { title: 'Close books' })

    const assistantSave = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[1][1]
    expect(assistantSave.content).toContain('---outcomes:')
    expect(assistantSave.content).toContain('Created 1 task: Close books.')
    expect(assistantSave.content).not.toContain('---actions:')

    await managed.chat({ message: 'What changed?', conversationId: first.conversationId })
    const secondProviderCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(secondProviderCall.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('Created 1 task: Close books.'),
      }),
    ]))
  })

  it('tells AI to use the memory entity when memory is enabled', async () => {
    const provider = createMockProvider()
    const adapter = createMockAdapter()

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      memory: { enabled: true },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    await managed.chat({ message: 'Revenue is my top priority' })

    const providerCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(providerCall.systemPrompt).toContain("Memory is what you've learned about this person")
    expect(providerCall.systemPrompt).toContain('through the crud action')
    expect(providerCall.systemPrompt).not.toContain('Memory extraction — newLearnings')
  })

  it('ends conversation', async () => {
    const adapter = createMockAdapter()
    const provider = createMockProvider()
    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    await managed.endConversation('conv-1')
    expect(adapter.endConversation).toHaveBeenCalledWith('conv-1')
  })

  it('auto-retrospective runs when last message is from previous day', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    const retrospectResponse = JSON.stringify({
      actions: [
        {
          name: 'crud',
          params: {
            operation: 'create',
            entity: 'memory',
            params: {
              content: 'CEO focuses on efficiency',
              category: 'strategic_context',
            },
          },
        },
      ],
    })
    const chatResponse = JSON.stringify({
      message: 'Let me help with revenue.',
      actions: [],
      followUps: [],
    })
    // First call = retrospect, second = chat
    const provider = createMockProvider([retrospectResponse, chatResponse])
    const messages: Message[] = [
      { role: 'user', content: 'We discussed efficiency', createdAt: yesterday },
      { role: 'assistant', content: 'Good insight', createdAt: yesterday },
    ]
    const memories: Memory[] = []

    const adapter: StorageAdapter = {
      getActiveConversation: vi.fn().mockResolvedValue({ id: 'conv-1', trigger: 'manual', createdAt: yesterday }),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      endConversation: vi.fn(),
      getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
      saveMessage: vi.fn().mockImplementation((_convId, msg) => {
        messages.push({ ...msg, createdAt: new Date().toISOString() })
        return Promise.resolve()
      }),
      loadMemories: vi.fn().mockResolvedValue(memories),
      saveMemory: vi.fn().mockImplementation((mem) => {
        const id = `mem-${memories.length + 1}`
        memories.push({ ...mem, id })
        return Promise.resolve(id)
      }),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
    }

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      memory: { enabled: true },
      provider,
    })

    const managed = withStorage(persona, {
      adapter,
      retrospect: { auto: true, guidelines: 'Look for leadership patterns' },
    })
    await managed.chat({ message: 'Help me with revenue' })

    // Provider should have been called twice: retrospect + chat
    expect(provider.chat).toHaveBeenCalledTimes(2)

    // Retrospective should have saved a memory
    expect(adapter.saveMemory).toHaveBeenCalled()
  })

  it('saves the current user message before auto-retrospective work, without leaking it into retrospect history', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    const retrospectResponse = JSON.stringify({ actions: [] })
    const chatResponse = JSON.stringify({
      message: 'Let me help with revenue.',
      actions: [],
      followUps: [],
    })
    const providerEvents: Array<{ kind: string; message: string; history: Array<{ role: string; content: string }> }> = []
    const provider = {
      name: 'mock',
      chat: vi.fn().mockImplementation(async (input: { message: string; history?: Array<{ role: string; content: string }> }) => {
        providerEvents.push({
          kind: input.message.includes('Run the silent retrospective') ? 'retrospect' : 'chat',
          message: input.message,
          history: input.history ?? [],
        })
        return {
          text: providerEvents.length === 1 ? retrospectResponse : chatResponse,
        }
      }),
    } satisfies LLMProvider

    const callOrder: string[] = []
    const messages: Message[] = [
      { role: 'user', content: 'We discussed efficiency', createdAt: yesterday },
      { role: 'assistant', content: 'Good insight', createdAt: yesterday },
    ]

    const adapter: StorageAdapter = {
      getActiveConversation: vi.fn().mockResolvedValue({ id: 'conv-1', trigger: 'manual', createdAt: yesterday }),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      endConversation: vi.fn(),
      getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
      saveMessage: vi.fn().mockImplementation((_convId, msg) => {
        callOrder.push(`saveMessage:${msg.role}`)
        messages.push({ ...msg, createdAt: new Date().toISOString() })
        return Promise.resolve()
      }),
      loadMemories: vi.fn().mockResolvedValue([]),
      saveMemory: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
    }

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      memory: { enabled: true },
      provider,
    })

    const managed = withStorage(persona, {
      adapter,
      retrospect: { auto: true },
    })

    await managed.chat({ message: 'Help me with revenue' })

    expect(callOrder[0]).toBe('saveMessage:user')
    expect(providerEvents[0]?.kind).toBe('retrospect')
    expect(providerEvents[0]?.history).toEqual([
      { role: 'user', content: 'We discussed efficiency' },
      { role: 'assistant', content: 'Good insight' },
    ])
    expect(providerEvents[1]?.kind).toBe('chat')
    expect(providerEvents[1]?.message).toBe('Help me with revenue')
    expect(providerEvents[1]?.history).toEqual([
      { role: 'user', content: 'We discussed efficiency' },
      { role: 'assistant', content: 'Good insight' },
    ])
  })

  it('executes memory actions before saving assistant message to history', async () => {
    const callOrder: string[] = []
    const response = JSON.stringify({
      message: 'I noted that.',
      actions: [
        {
          name: 'crud',
          params: {
            operation: 'create',
            entity: 'memory',
            params: {
              content: 'CEO focused on revenue',
              category: 'strategic_context',
            },
          },
        },
      ],
    })
    const provider = createMockProvider(response)

    const messages: Message[] = []
    const memories: Memory[] = []

    const adapter: StorageAdapter = {
      getActiveConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      endConversation: vi.fn(),
      getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
      saveMessage: vi.fn().mockImplementation((_convId, msg) => {
        if (msg.role === 'assistant') callOrder.push('saveMessage:assistant')
        messages.push({ ...msg, createdAt: new Date().toISOString() })
        return Promise.resolve()
      }),
      loadMemories: vi.fn().mockResolvedValue(memories),
      saveMemory: vi.fn().mockImplementation((mem) => {
        callOrder.push('saveMemory')
        memories.push({ ...mem, id: `mem-${memories.length + 1}` })
        return Promise.resolve(`mem-${memories.length}`)
      }),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
    }

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      memory: { enabled: true },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    await managed.chat({ message: 'Revenue is my focus' })

    // Memory action must execute BEFORE assistant message is saved
    expect(callOrder.indexOf('saveMemory')).toBeLessThan(callOrder.indexOf('saveMessage:assistant'))
    const assistantSave = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: [string, Message]) => c[1].role === 'assistant',
    )
    expect(assistantSave![1].content).toContain('---outcomes:')
    expect(assistantSave![1].content).toContain('crud create memory executed.')
  })

  it('stores failed memory actions as outcome continuity, not raw action annotations', async () => {
    const response = JSON.stringify({
      message: 'I noted that.',
      actions: [
        {
          name: 'crud',
          params: {
            operation: 'create',
            entity: 'memory',
            params: {
              content: 'Should fail',
              category: 'general',
            },
          },
        },
      ],
    })
    const provider = createMockProvider(response)

    const messages: Message[] = []

    const adapter: StorageAdapter = {
      getActiveConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      endConversation: vi.fn(),
      getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
      saveMessage: vi.fn().mockImplementation((_convId, msg) => {
        messages.push({ ...msg, createdAt: new Date().toISOString() })
        return Promise.resolve()
      }),
      loadMemories: vi.fn().mockResolvedValue([]),
      saveMemory: vi.fn().mockRejectedValue(new Error('storage failure')),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
    }

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      memory: { enabled: true },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    await managed.chat({ message: 'Test' })

    // Future turns should see the executor fact, while raw/debug action
    // annotations stay absent because the mutation did not land.
    const assistantSave = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: [string, Message]) => c[1].role === 'assistant',
    )
    expect(assistantSave).toBeDefined()
    expect(assistantSave![1].content).toContain('---outcomes:')
    expect(assistantSave![1].content).toContain('crud create memory failed: storage failure')
    expect(assistantSave![1].content).not.toContain('---actions:')
    expect(assistantSave![1].actionsJson).toBeNull()
  })

  it('auto-retrospective does NOT run when last message is from today', async () => {
    const now = new Date().toISOString()
    const chatResponse = JSON.stringify({
      message: 'Let me help.',
      actions: [],
      followUps: [],
    })
    const provider = createMockProvider(chatResponse)
    const messages: Message[] = [
      { role: 'user', content: 'Recent message', createdAt: now },
      { role: 'assistant', content: 'Response', createdAt: now },
    ]

    const adapter: StorageAdapter = {
      getActiveConversation: vi.fn().mockResolvedValue({ id: 'conv-1', trigger: 'manual', createdAt: now }),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      endConversation: vi.fn(),
      getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
      saveMessage: vi.fn().mockImplementation((_convId, msg) => {
        messages.push({ ...msg, createdAt: new Date().toISOString() })
        return Promise.resolve()
      }),
      loadMemories: vi.fn().mockResolvedValue([]),
      saveMemory: vi.fn().mockResolvedValue('mem-1'),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
    }

    const persona = definePersona({
      identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
      voice: { tone: 'balanced', style: 'educator' },
      provider,
    })

    const managed = withStorage(persona, {
      adapter,
      retrospect: { auto: true },
    })
    await managed.chat({ message: 'Quick question' })

    // Provider called only once (no retrospect)
    expect(provider.chat).toHaveBeenCalledTimes(1)
  })
})
