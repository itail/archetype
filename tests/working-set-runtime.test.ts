import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildWorkingSetSection, commitWorkingSet, definePersona, reviewWorkingSetDelta, withStorage } from '../src/index.js'
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse, Memory, Message, PersonaConfig, StorageAdapter, WorkingSet } from '../src/types.js'

function createScriptedProvider(responses: unknown[]): { provider: LLMProvider; requests: LLMProviderRequest[] } {
  const requests: LLMProviderRequest[] = []

  return {
    requests,
    provider: {
      name: 'scripted',
      async chat(request: LLMProviderRequest): Promise<LLMProviderResponse> {
        requests.push(request)
        const next = responses.shift()
        if (next == null) throw new Error('No scripted response left for provider')
        return { text: typeof next === 'string' ? next : JSON.stringify(next) }
      },
    },
  }
}

function createWorkingSetAdapter(): StorageAdapter & { state: { workingSet: WorkingSet | null } } {
  const messages: Message[] = []
  const memories: Memory[] = []
  const state = { workingSet: null as WorkingSet | null }

  return {
    state,
    getActiveConversation: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue('conv-1'),
    endConversation: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockImplementation(() => Promise.resolve([...messages])),
    saveMessage: vi.fn().mockImplementation((_convId, msg) => {
      messages.push({ ...msg, createdAt: new Date().toISOString() })
      return Promise.resolve()
    }),
    loadMemories: vi.fn().mockResolvedValue(memories),
    saveMemory: vi.fn().mockResolvedValue('mem-1'),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    loadWorkingSet: vi.fn().mockImplementation(async () => state.workingSet),
    saveWorkingSet: vi.fn().mockImplementation(async (_convId, workingSet) => {
      state.workingSet = workingSet
    }),
    clearWorkingSet: vi.fn().mockImplementation(async () => {
      state.workingSet = null
    }),
  }
}

const BASE_CONFIG: Omit<PersonaConfig, 'provider'> = {
  identity: {
    name: 'WorkingSetBot',
    expertise: ['drafting'],
    relationship: 'assistant',
    northStar: 'clean negotiation',
  },
  voice: { tone: 'balanced', style: 'quick' },
  staging: { model: 'working-set' },
  actions: {
    setReplyDraft: {
      description: 'Accept the current best reply draft.',
      schema: z.object({
        threadId: z.string(),
        draft: z.string(),
      }),
      layer: 'meaning',
      defaultReviewState: 'accepted',
      commitMode: 'not_required',
      targetKey: (params) => `thread:${String(params.threadId)}:reply-draft`,
    },
    archiveThread: {
      description: 'Stage archiving this thread.',
      schema: z.object({
        threadId: z.string(),
      }),
      layer: 'transport',
      defaultReviewState: 'accepted',
      commitMode: 'explicit',
      targetKey: (params) => `thread:${String(params.threadId)}:archive`,
    },
  },
}

describe('working-set runtime', () => {
  it('accepts meaning deltas by default and keeps transport deltas ready until commit', async () => {
    const { provider } = createScriptedProvider([
      {
        message: 'I drafted the reply and staged the archive.',
        actions: [
          { name: 'setReplyDraft', params: { threadId: 'thread-1', draft: 'That works for me.' } },
          { name: 'archiveThread', params: { threadId: 'thread-1' } },
        ],
      },
    ])

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.chat({ message: 'Handle this thread.' })

    expect(result.workingSet?.deltas).toHaveLength(2)
    const draft = result.workingSet?.deltas.find((delta) => delta.action.name === 'setReplyDraft')
    const archive = result.workingSet?.deltas.find((delta) => delta.action.name === 'archiveThread')

    expect(draft?.reviewState).toBe('accepted')
    expect(draft?.commitState).toBe('not_required')
    expect(archive?.reviewState).toBe('accepted')
    expect(archive?.commitState).toBe('ready')
    expect(result.workingSetSummary?.accepted).toBe(2)
    expect(result.workingSetSummary?.ready).toBe(1)
  })

  it('supersedes older accepted deltas with the same target key', async () => {
    const { provider } = createScriptedProvider([
      {
        message: 'First draft.',
        actions: [{ name: 'setReplyDraft', params: { threadId: 'thread-1', draft: 'First pass' } }],
      },
      {
        message: 'Warmer draft.',
        actions: [{ name: 'setReplyDraft', params: { threadId: 'thread-1', draft: 'Warmer second pass' } }],
      },
    ])

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const first = await persona.chat({ message: 'Draft it.' })
    const second = await persona.chat({ message: 'Make it warmer.', workingSet: first.workingSet })

    expect(second.workingSet?.deltas).toHaveLength(2)
    expect(second.workingSet?.deltas[0]?.reviewState).toBe('superseded')
    expect(second.workingSet?.deltas[1]?.reviewState).toBe('accepted')
    expect(second.workingSet?.deltas[1]?.supersedes).toBe(second.workingSet?.deltas[0]?.id)
  })

  it('managed mode persists working truth across turns and can commit transport deltas', async () => {
    const { provider, requests } = createScriptedProvider([
      {
        message: 'I drafted the reply.',
        actions: [{ name: 'setReplyDraft', params: { threadId: 'thread-1', draft: 'Happy to confirm Friday.' } }],
      },
      {
        message: 'I also staged the archive.',
        actions: [{ name: 'archiveThread', params: { threadId: 'thread-1' } }],
      },
    ])

    const adapter = createWorkingSetAdapter()
    const persona = withStorage(definePersona({ ...BASE_CONFIG, provider }), {
      adapter,
    })

    await persona.chat({ message: 'Draft the reply.' })
    expect(adapter.state.workingSet?.deltas).toHaveLength(1)

    const second = await persona.chat({ message: 'Now archive it too.' })
    expect(requests[1]?.systemPrompt).toContain('CURRENT WORKING SET:')
    expect(second.workingSetSummary?.ready).toBe(1)

    const committed = await persona.commitWorkingSet({
      conversationId: 'conv-1',
      handlers: {
        archiveThread: async () => ({ success: true }),
      },
    })

    const archiveDelta = committed.workingSet.deltas.find((delta) => delta.action.name === 'archiveThread')
    expect(archiveDelta?.commitState).toBe('committed')
    expect(adapter.state.workingSet?.deltas.find((delta) => delta.action.name === 'archiveThread')?.commitState).toBe('committed')
  })

  it('reviewWorkingSetDelta centralizes review transitions for pending deltas', async () => {
    const now = new Date().toISOString()
    const pendingTransport: WorkingSet = {
      id: 'ws-review',
      createdAt: now,
      updatedAt: now,
      deltas: [
        {
          id: 'delta-pending',
          action: { name: 'archiveThread', params: { threadId: 'thread-1' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-1' },
          annotation: 'archiveThread: thread-1',
          layer: 'transport',
          reviewState: 'pending',
          commitState: 'not_required',
          targetKey: 'thread:thread-1:archive',
          createdAt: now,
          updatedAt: now,
        },
      ],
    }

    const accepted = reviewWorkingSetDelta(pendingTransport, {
      deltaId: 'delta-pending',
      decision: 'accept',
    })
    expect(accepted.deltas[0]?.reviewState).toBe('accepted')
    expect(accepted.deltas[0]?.commitState).toBe('ready')

    const rejected = reviewWorkingSetDelta(pendingTransport, {
      deltaId: 'delta-pending',
      decision: 'reject',
    })
    expect(rejected.deltas[0]?.reviewState).toBe('rejected')
    expect(rejected.deltas[0]?.commitState).toBe('not_required')
  })

  it('reviewWorkingSetDelta can re-arm failed transport deltas for retry', async () => {
    const now = new Date().toISOString()
    const failedTransport: WorkingSet = {
      id: 'ws-failed',
      createdAt: now,
      updatedAt: now,
      deltas: [
        {
          id: 'delta-failed',
          action: { name: 'archiveThread', params: { threadId: 'thread-9' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-9' },
          annotation: 'archiveThread: thread-9',
          layer: 'transport',
          reviewState: 'accepted',
          commitState: 'failed',
          targetKey: 'thread:thread-9:archive',
          createdAt: now,
          updatedAt: now,
          error: 'SMTP timeout',
        },
      ],
    }

    const retried = reviewWorkingSetDelta(failedTransport, {
      deltaId: 'delta-failed',
      decision: 'accept',
    })

    expect(retried.deltas[0]?.reviewState).toBe('accepted')
    expect(retried.deltas[0]?.commitState).toBe('ready')
    expect(retried.deltas[0]?.error).toBeUndefined()
  })

  it('working-set prompt section only surfaces accepted current truth', async () => {
    const now = new Date().toISOString()
    const workingSet: WorkingSet = {
      id: 'ws-prompt',
      createdAt: now,
      updatedAt: now,
      deltas: [
        {
          id: 'meaning-1',
          action: { name: 'setReplyDraft', params: { threadId: 'thread-1', draft: 'Sounds good.' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-1', draft: 'Sounds good.' },
          annotation: 'Set the current reply draft for thread-1.',
          layer: 'meaning',
          reviewState: 'accepted',
          commitState: 'not_required',
          targetKey: 'thread:thread-1:reply-draft',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'transport-pending',
          action: { name: 'archiveThread', params: { threadId: 'thread-1' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-1' },
          annotation: 'Archive thread-1.',
          layer: 'transport',
          reviewState: 'pending',
          commitState: 'not_required',
          targetKey: 'thread:thread-1:archive',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'transport-accepted',
          action: { name: 'archiveThread', params: { threadId: 'thread-2' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-2' },
          annotation: 'Archive thread-2.',
          layer: 'transport',
          reviewState: 'accepted',
          commitState: 'ready',
          targetKey: 'thread:thread-2:archive',
          createdAt: now,
          updatedAt: now,
        },
      ],
    }

    const section = buildWorkingSetSection(workingSet)
    expect(section).toContain('Set the current reply draft for thread-1. [meaning; current draft]')
    expect(section).toContain('Archive thread-2. [transport; accepted but not executed]')
    expect(section).not.toContain('Archive thread-1.')
  })

  it('managed mode can review and persist working-set deltas', async () => {
    const { provider } = createScriptedProvider([])
    const adapter = createWorkingSetAdapter()
    const now = new Date().toISOString()
    adapter.state.workingSet = {
      id: 'ws-managed-review',
      createdAt: now,
      updatedAt: now,
      deltas: [
        {
          id: 'delta-managed',
          action: { name: 'archiveThread', params: { threadId: 'thread-3' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-3' },
          annotation: 'archiveThread: thread-3',
          layer: 'transport',
          reviewState: 'pending',
          commitState: 'not_required',
          targetKey: 'thread:thread-3:archive',
          createdAt: now,
          updatedAt: now,
        },
      ],
    }

    const persona = withStorage(definePersona({ ...BASE_CONFIG, provider }), { adapter })
    const reviewed = await persona.reviewWorkingSet({
      conversationId: 'conv-1',
      deltaId: 'delta-managed',
      decision: 'accept',
    })

    expect(reviewed.workingSet.deltas[0]?.reviewState).toBe('accepted')
    expect(reviewed.workingSet.deltas[0]?.commitState).toBe('ready')
    expect(reviewed.summary.ready).toBe(1)
    expect(adapter.state.workingSet?.deltas[0]?.commitState).toBe('ready')
  })

  it('prompted turns can stage working-set deltas too', async () => {
    const { provider } = createScriptedProvider([
      {
        message: 'The clearest next move is to keep this waiting.',
        actions: [{ name: 'archiveThread', params: { threadId: 'thread-2' } }],
      },
    ])

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.promptedTurn({
      label: 'Morning open',
      intent: 'Look at the current communication situation and stage the clearest next move.',
    })

    expect(result.workingSet?.deltas).toHaveLength(1)
    expect(result.workingSet?.deltas[0]?.commitState).toBe('ready')
  })

  it('commitWorkingSet only executes accepted transport deltas', async () => {
    const workingSet: WorkingSet = {
      id: 'ws-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deltas: [
        {
          id: 'delta-1',
          action: { name: 'archiveThread', params: { threadId: 'thread-1' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-1' },
          annotation: 'archiveThread: thread-1',
          layer: 'transport',
          reviewState: 'accepted',
          commitState: 'ready',
          targetKey: 'thread:thread-1:archive',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'delta-2',
          action: { name: 'archiveThread', params: { threadId: 'thread-2' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-2' },
          annotation: 'archiveThread: thread-2',
          layer: 'transport',
          reviewState: 'rejected',
          commitState: 'ready',
          targetKey: 'thread:thread-2:archive',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }

    const result = await commitWorkingSet(workingSet, {
      archiveThread: async () => ({ success: true }),
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.status).toBe('executed')
    expect(result.workingSet.deltas.find((delta) => delta.id === 'delta-1')?.commitState).toBe('committed')
    expect(result.workingSet.deltas.find((delta) => delta.id === 'delta-2')?.commitState).toBe('ready')
  })

  it('rejected transport deltas stay out of execution even after they were once ready', async () => {
    const now = new Date().toISOString()
    const reviewedOut = reviewWorkingSetDelta({
      id: 'ws-reject',
      createdAt: now,
      updatedAt: now,
      deltas: [
        {
          id: 'delta-r1',
          action: { name: 'archiveThread', params: { threadId: 'thread-7' }, confidence: 'medium' },
          validatedParams: { threadId: 'thread-7' },
          annotation: 'archiveThread: thread-7',
          layer: 'transport',
          reviewState: 'accepted',
          commitState: 'ready',
          targetKey: 'thread:thread-7:archive',
          createdAt: now,
          updatedAt: now,
        },
      ],
    }, {
      deltaId: 'delta-r1',
      decision: 'reject',
    })

    const handler = vi.fn(async () => ({ success: true }))
    const result = await commitWorkingSet(reviewedOut, {
      archiveThread: handler,
    })

    expect(handler).not.toHaveBeenCalled()
    expect(result.results).toHaveLength(0)
    expect(result.workingSet.deltas[0]?.reviewState).toBe('rejected')
    expect(result.workingSet.deltas[0]?.commitState).toBe('not_required')
  })
})
