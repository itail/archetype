import { describe, it, expect, vi } from 'vitest'
import { definePersona, withStorage, PEER_ACTION_NAME } from '../src/index.js'
import type { LLMProvider, StorageAdapter, Memory, Message, PeerConfig } from '../src/types.js'
import { z } from 'zod'

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockProvider(responses: string[]): LLMProvider {
  const queue = [...responses]
  const defaultResp = JSON.stringify({ message: 'Default response', actions: [], followUps: [] })
  return {
    name: 'mock',
    chat: vi.fn().mockImplementation(async () => ({
      text: queue.shift() ?? defaultResp,
    })),
  }
}

function createMockAdapter(): StorageAdapter {
  const messages: Message[] = []
  const memories: Memory[] = []

  return {
    getActiveConversation: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue('conv-1'),
    endConversation: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
    saveMessage: vi.fn().mockImplementation((_convId: string, msg: Omit<Message, 'createdAt'>) => {
      messages.push({ ...msg, createdAt: new Date().toISOString() })
      return Promise.resolve()
    }),
    loadMemories: vi.fn().mockResolvedValue([...memories]),
    saveMemory: vi.fn().mockImplementation((mem: Omit<Memory, 'id'>) => {
      const id = `mem-${memories.length + 1}`
      memories.push({ ...mem, id })
      return Promise.resolve(id)
    }),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  }
}

function createBasePersona(provider: LLMProvider) {
  return definePersona({
    identity: {
      name: 'PA',
      expertise: ['executive assistance'],
      relationship: 'personal assistant',
      northStar: 'calm, organized communication',
    },
    voice: { tone: 'balanced', style: 'quick' },
    actions: {},
    provider,
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('peer consultation', () => {
  it('auto-registers consultPeer action when peers are configured', async () => {
    const provider = createMockProvider([
      JSON.stringify({ message: 'Simple response', actions: [], followUps: [] }),
    ])
    const adapter = createMockAdapter()
    const peerProvider = createMockProvider([])
    const peerAdapter = createMockAdapter()

    const peerPersona = withStorage(
      definePersona({
        identity: { name: 'Relay', expertise: ['data curation'], relationship: 'logistics partner', northStar: 'deliver the right context' },
        voice: { tone: 'direct', style: 'quick' },
        provider: peerProvider,
      }),
      { adapter: peerAdapter },
    )

    const managed = withStorage(createBasePersona(provider), {
      adapter,
      peers: {
        relay: {
          persona: peerPersona,
          expertise: 'inbox data curation',
          contextBuilder: async () => ({ rawInbox: 'test data' }),
        },
      },
    })

    // The system prompt should include consultPeer action description
    await managed.chat({ message: 'Hello' })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('consultPeer')
    expect(call.systemPrompt).toContain('relay')
    expect(call.systemPrompt).toContain('inbox data curation')
  })

  it('does not register consultPeer when no peers configured', async () => {
    const provider = createMockProvider([
      JSON.stringify({ message: 'Simple response', actions: [], followUps: [] }),
    ])
    const adapter = createMockAdapter()

    const managed = withStorage(createBasePersona(provider), { adapter })
    await managed.chat({ message: 'Hello' })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).not.toContain('consultPeer')
  })

  it('calls peer and re-calls engine when consultPeer action is emitted', async () => {
    // PA response #1: emits consultPeer
    const paResponse1 = JSON.stringify({
      message: 'Let me check with Relay.',
      actions: [{ name: PEER_ACTION_NAME, params: { peer: 'relay', query: 'Get me the inbox summary' } }],
      followUps: [],
    })
    // PA response #2: after receiving peer data
    const paResponse2 = JSON.stringify({
      message: 'You have 3 threads that need attention. Sarah sent a budget review.',
      actions: [],
      followUps: ['Should I draft a reply to Sarah?'],
    })

    const paProvider = createMockProvider([paResponse1, paResponse2])
    const paAdapter = createMockAdapter()

    // Peer response
    const peerResponse = JSON.stringify({
      message: 'CURATED: 3 active threads. Sarah (budget review, urgent). Mark (API migration, waiting). Newsletter (noise, suppress).',
      actions: [],
      followUps: [],
    })
    const peerProvider = createMockProvider([peerResponse])
    const peerAdapter = createMockAdapter()

    const peerPersona = withStorage(
      definePersona({
        identity: { name: 'Relay', expertise: ['data curation'], relationship: 'logistics partner', northStar: 'deliver the right context' },
        voice: { tone: 'direct', style: 'quick' },
        provider: peerProvider,
      }),
      { adapter: peerAdapter },
    )

    const contextBuilder = vi.fn().mockResolvedValue({ rawInbox: 'Sarah: budget review\nMark: API migration\nNewsletter: promo' })

    const managed = withStorage(createBasePersona(paProvider), {
      adapter: paAdapter,
      peers: {
        relay: {
          persona: peerPersona,
          expertise: 'inbox data curation',
          contextBuilder,
        },
      },
    })

    const result = await managed.chat({
      message: 'What needs my attention?',
      personaId: 'orbit',
      correlationId: 'test-correlation-1',
    })

    // PA was called twice (assess → re-call with peer data)
    expect(paProvider.chat).toHaveBeenCalledTimes(2)

    // Peer was called once
    expect(peerProvider.chat).toHaveBeenCalledTimes(1)

    // Context builder was called with the PA's query
    expect(contextBuilder).toHaveBeenCalledWith('Get me the inbox summary', {})

    // Final response is from the re-call (not the assessment)
    expect(result.message).toContain('3 threads')
    expect(result.message).toContain('Sarah')

    // consultPeer action is filtered out of the result
    expect(result.actions.find(a => a.name === PEER_ACTION_NAME)).toBeUndefined()

    // Follow-ups come from the re-call
    expect(result.followUps).toContain('Should I draft a reply to Sarah?')

    // Trace contains peer consultation
    expect(result.trace.peerConsultations).toHaveLength(1)
    expect(result.trace.peerConsultations![0].peer).toBe('relay')
    expect(result.trace.peerConsultations![0].query).toBe('Get me the inbox summary')
    expect(result.trace.peerConsultations![0].response).toContain('CURATED')
    expect(result.trace.peerConsultations![0].durationMs).toBeGreaterThanOrEqual(0)

    // The re-call's system prompt includes peer response
    const reCallArgs = (paProvider.chat as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(reCallArgs.systemPrompt).toContain('FROM RELAY')
    expect(reCallArgs.systemPrompt).toContain('CURATED')

    // Only the final message is persisted (user + assistant)
    expect(paAdapter.saveMessage).toHaveBeenCalledTimes(2)
    const savedAssistant = (paAdapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[1][1]
    expect(savedAssistant.role).toBe('assistant')
    expect(savedAssistant.content).toContain('3 threads')
    // Consultation annotation is in the saved message
    expect(savedAssistant.content).toContain('---consulted: relay---')
  })

  it('skips peer consultation when PA does not emit consultPeer', async () => {
    const paResponse = JSON.stringify({
      message: 'You mentioned that last time. Sarah is waiting.',
      actions: [],
      followUps: [],
    })
    const paProvider = createMockProvider([paResponse])
    const paAdapter = createMockAdapter()
    const peerProvider = createMockProvider([])
    const peerAdapter = createMockAdapter()

    const peerPersona = withStorage(
      definePersona({
        identity: { name: 'Relay', expertise: ['data curation'], relationship: 'logistics partner', northStar: 'deliver the right context' },
        voice: { tone: 'direct', style: 'quick' },
        provider: peerProvider,
      }),
      { adapter: peerAdapter },
    )

    const managed = withStorage(createBasePersona(paProvider), {
      adapter: paAdapter,
      peers: {
        relay: {
          persona: peerPersona,
          expertise: 'inbox data curation',
          contextBuilder: async () => ({ rawInbox: 'data' }),
        },
      },
    })

    const result = await managed.chat({ message: 'Thanks' })

    // Only 1 PA call — no peer consultation
    expect(paProvider.chat).toHaveBeenCalledTimes(1)
    expect(peerProvider.chat).not.toHaveBeenCalled()
    expect(result.trace.peerConsultations).toBeUndefined()
    expect(result.message).toContain('Sarah is waiting')
  })

  it('handles unknown peer name gracefully', async () => {
    const paResponse = JSON.stringify({
      message: 'Checking...',
      actions: [{ name: PEER_ACTION_NAME, params: { peer: 'nonexistent', query: 'help' } }],
      followUps: [],
    })
    const paProvider = createMockProvider([paResponse])
    const paAdapter = createMockAdapter()
    const peerProvider = createMockProvider([])
    const peerAdapter = createMockAdapter()

    const peerPersona = withStorage(
      definePersona({
        identity: { name: 'Relay', expertise: ['data curation'], relationship: 'logistics partner', northStar: 'deliver context' },
        voice: { tone: 'direct', style: 'quick' },
        provider: peerProvider,
      }),
      { adapter: peerAdapter },
    )

    const managed = withStorage(createBasePersona(paProvider), {
      adapter: paAdapter,
      peers: {
        relay: {
          persona: peerPersona,
          expertise: 'inbox data curation',
          contextBuilder: async () => ({ rawInbox: 'data' }),
        },
      },
    })

    const result = await managed.chat({ message: 'Ask the wrong peer' })

    // Error recorded in trace
    expect(result.trace.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown peer: "nonexistent"')]),
    )
    // Peer was not called
    expect(peerProvider.chat).not.toHaveBeenCalled()
  })

  it('handles peer contextBuilder failure gracefully', async () => {
    const paResponse = JSON.stringify({
      message: 'Checking...',
      actions: [{ name: PEER_ACTION_NAME, params: { peer: 'relay', query: 'get data' } }],
      followUps: [],
    })
    const paProvider = createMockProvider([paResponse])
    const paAdapter = createMockAdapter()
    const peerProvider = createMockProvider([])
    const peerAdapter = createMockAdapter()

    const peerPersona = withStorage(
      definePersona({
        identity: { name: 'Relay', expertise: ['data curation'], relationship: 'logistics partner', northStar: 'context' },
        voice: { tone: 'direct', style: 'quick' },
        provider: peerProvider,
      }),
      { adapter: peerAdapter },
    )

    const managed = withStorage(createBasePersona(paProvider), {
      adapter: paAdapter,
      peers: {
        relay: {
          persona: peerPersona,
          expertise: 'inbox data curation',
          contextBuilder: async () => { throw new Error('Gmail API timeout') },
        },
      },
    })

    const result = await managed.chat({ message: 'Check inbox' })

    // Error recorded in trace
    expect(result.trace.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Peer consultation "relay" failed')]),
    )
    expect(result.trace.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Gmail API timeout')]),
    )
  })

  it('passes personaId and correlationId through to traces', async () => {
    const paResponse = JSON.stringify({
      message: 'Got it.',
      actions: [{ name: PEER_ACTION_NAME, params: { peer: 'relay', query: 'inbox' } }],
      followUps: [],
    })
    const paReCall = JSON.stringify({
      message: 'Here is your inbox.',
      actions: [],
      followUps: [],
    })
    const paProvider = createMockProvider([paResponse, paReCall])
    const paAdapter = createMockAdapter()

    const peerResponse = JSON.stringify({ message: 'Curated data', actions: [], followUps: [] })
    const peerProvider = createMockProvider([peerResponse])
    const peerAdapter = createMockAdapter()

    const peerPersona = withStorage(
      definePersona({
        identity: { name: 'Relay', expertise: ['data curation'], relationship: 'logistics partner', northStar: 'context' },
        voice: { tone: 'direct', style: 'quick' },
        provider: peerProvider,
      }),
      { adapter: peerAdapter },
    )

    const managed = withStorage(createBasePersona(paProvider), {
      adapter: paAdapter,
      peers: {
        relay: {
          persona: peerPersona,
          expertise: 'inbox curation',
          contextBuilder: async () => ({ rawInbox: 'data' }),
        },
      },
    })

    const result = await managed.chat({
      message: 'Show me inbox',
      personaId: 'orbit',
      correlationId: 'corr-123',
    })

    // The peer's trace should have the correlation ID
    const peerConsultation = result.trace.peerConsultations![0]
    expect(peerConsultation.trace.correlationId).toBe('corr-123')
    expect(peerConsultation.trace.personaId).toBe('relay')
  })
})
