import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  definePersona,
  withStorage,
  buildGreetingPrompt,
  buildChatLLMRequest,
  buildPromptedTurnLLMRequest,
  buildPromptedTurnPrompt,
  buildRetrospectPrompt,
  annotateMessage,
  buildAttachmentCarryForwardMessage,
  loadBrainFile,
  configVersion,
} from '../src/index.js'
import { buildSystemPrompt } from '../src/core/prompt-builder.js'
import { buildVoiceBlock } from '../src/core/voice.js'
import { buildGeminiResponseSchema } from '../src/providers/gemini.js'
import { zodToGeminiSchema } from '../src/providers/zod-to-gemini.js'
import type { LLMProvider, StorageAdapter, Memory, Message, PersonaConfig } from '../src/types.js'
import { z } from 'zod'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockProvider(responseOverride?: string): LLMProvider {
  const defaultResponse = JSON.stringify({
    message: 'Hello! Good to see you.',
    actions: [],
    followUps: ['How was your day?'],
  })
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseOverride ?? defaultResponse }),
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
    saveMessage: vi.fn().mockImplementation((_convId, msg) => {
      messages.push({ ...msg, createdAt: new Date().toISOString() })
      return Promise.resolve()
    }),
    loadMemories: vi.fn().mockResolvedValue(memories),
    saveMemory: vi.fn().mockResolvedValue('mem-1'),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  }
}

const BASE_CONFIG: Omit<PersonaConfig, 'provider'> = {
  identity: {
    name: 'TestBot',
    expertise: ['testing'],
    relationship: 'test partner',
    northStar: 'quality assurance',
  },
  voice: { tone: 'warm', style: 'educator' },
}

// ─── 1A. Locale on ChatInput ────────────────────────────────────────────────

describe('locale injection', () => {
  it('injects Hebrew locale into system prompt', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: { ...BASE_CONFIG, provider },
      input: { message: 'test', locale: 'he' },
    })
    expect(prompt).toContain('RESPOND IN Hebrew.')
  })

  it('injects English locale into system prompt', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: { ...BASE_CONFIG, provider },
      input: { message: 'test', locale: 'en' },
    })
    expect(prompt).toContain('RESPOND IN English.')
  })

  it('omits locale when not provided', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: { ...BASE_CONFIG, provider },
      input: { message: 'test' },
    })
    expect(prompt).not.toContain('RESPOND IN')
  })

  it('falls back to raw locale for unknown codes', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: { ...BASE_CONFIG, provider },
      input: { message: 'test', locale: 'swahili' },
    })
    expect(prompt).toContain('RESPOND IN swahili.')
  })

  it('adds attachment continuity guidance when the turn includes images', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: { ...BASE_CONFIG, provider },
      input: {
        message: 'what do you see?',
        attachments: [{ type: 'image', mimeType: 'image/jpeg', data: 'base64data' }],
      },
    })
    expect(prompt).toContain('Attachment continuity:')
    expect(prompt).toContain('attachmentNotes')
  })
})

// ─── 1B. Formatting on VoiceConfig ──────────────────────────────────────────

describe('formatting in voice block', () => {
  it('appends formatting to voice block', () => {
    const voice = buildVoiceBlock({
      tone: 'warm',
      style: 'educator',
      formatting: 'Use **bold** for emphasis and emoji as seasoning.',
    })
    expect(voice).toContain('Use **bold** for emphasis and emoji as seasoning.')
  })

  it('omits formatting when not provided', () => {
    const voice = buildVoiceBlock({
      tone: 'warm',
      style: 'educator',
    })
    expect(voice).not.toContain('bold')
  })
})

describe('brain loading', () => {
  it('fills prompt slots from markdown brain sections', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: {
        ...BASE_CONFIG,
        provider,
        brain: {
          source: 'markdown',
          markdown: `---
id: test-brain
version: 1
role: test partner
---

## Voice Formatting
Use short paragraphs.

## Methodology
Notice the real situation before offering advice.

## Directives
Be crisp and specific.`,
        },
      },
      input: { message: 'test' },
    })

    expect(prompt).toContain('Use short paragraphs.')
    expect(prompt).toContain('Notice the real situation before offering advice.')
    expect(prompt).toContain('Be crisp and specific.')
  })

  it('loads a brain from file and changes config version when the brain changes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'archetype-brain-'))
    const file = join(tmpDir, 'brain.md')
    writeFileSync(file, `---
id: temp-brain
version: 1
role: test partner
---

## Methodology
Version one.`, 'utf8')

    const provider = createMockProvider()
    const config = {
      ...BASE_CONFIG,
      provider,
      brain: { source: 'file' as const, path: file },
    }

    const versionA = configVersion(config)
    const loaded = loadBrainFile(file)
    expect(loaded.metadata.id).toBe('temp-brain')
    expect(loaded.sections['methodology']).toBe('Version one.')

    writeFileSync(file, `---
id: temp-brain
version: 2
role: test partner
---

## Methodology
Version two.`, 'utf8')

    const versionB = configVersion(config)
    expect(versionA).not.toBe(versionB)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appends config methodology after brain methodology when both exist', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: {
        ...BASE_CONFIG,
        provider,
        methodology: 'App overlay behavior.',
        brain: {
          source: 'markdown',
          markdown: `---
id: combined-brain
version: 1
role: test partner
---

## Methodology
Portable role judgment.`,
        },
      },
      input: { message: 'test' },
    })

    expect(prompt).toContain('Portable role judgment.')
    expect(prompt).toContain('App overlay behavior.')
    expect(prompt.indexOf('Portable role judgment.')).toBeLessThan(prompt.indexOf('App overlay behavior.'))
  })
})

// ─── 1C. followUpsDescription override ──────────────────────────────────────

describe('followUpsDescription override', () => {
  it('keeps the user-voice contract when adding app context', () => {
    const customDesc = 'Suggest what the user might naturally want to say next.'
    const schema = buildGeminiResponseSchema(undefined, { followUpsDescription: customDesc })
    expect((schema.properties.followUps as any).description).toContain(customDesc)
    expect((schema.properties.followUps as any).description).toContain('written in their voice, not yours')
    expect((schema.properties.followUps as any).description).toContain('App-specific context')
  })

  it('uses default when no override', () => {
    const schema = buildGeminiResponseSchema()
    expect((schema.properties.followUps as any).description).toContain('written in their voice, not yours')
  })
})

// ─── 1D. PersonaEngine.greet() ──────────────────────────────────────────────

describe('PersonaEngine.greet()', () => {
  it('calls LLM with an app-initiated greeting prompt and follow-up schema', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'Hey there! How are you doing today?' })

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.greet({
      timezone: 'America/New_York',
      userIdentity: 'Test User',
    })

    expect(result.greeting).toBe('Hey there! How are you doing today?')
    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('TestBot')
    expect(call.systemPrompt).toContain('This turn was initiated by the app')
    expect(call.systemPrompt).toContain('Generate a warm, natural check-in')
    expect(call.responseSchema).toBeDefined()
    expect(call.message).toContain('Use the turn instructions and structured context as the live input.')
  })

  it('includes locale in greeting prompt', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: JSON.stringify({ message: 'שלום!', actions: [] }) })

    const persona = definePersona({ ...BASE_CONFIG, provider })
    await persona.greet({ locale: 'he' })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('RESPOND IN Hebrew.')
  })

  it('normalizes array-shaped message field into plain text', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ message: ['Hey there', 'Good to see you again.'], actions: [] }),
    })

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.greet({})

    expect(result.greeting).toBe('Hey there\nGood to see you again.')
  })

  it('includes recent history via provider history param', async () => {
    const provider = createMockProvider()

    const persona = definePersona({ ...BASE_CONFIG, provider })
    await persona.greet({
      history: [
        { role: 'assistant', content: 'Morning. Want to plan breakfast?' },
        { role: 'user', content: 'Not yet, maybe later.' },
      ],
    })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // History is passed through the provider's history param (via chat())
    expect(call.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Morning. Want to plan breakfast?' }),
      expect.objectContaining({ role: 'user', content: 'Not yet, maybe later.' }),
    ]))
  })
})

// ─── 1D. PersonaEngine.promptedTurn() ───────────────────────────────────────

describe('PersonaEngine.promptedTurn()', () => {
  it('calls LLM with app-initiated intent and a lightweight follow-up schema', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        message: 'Here is a thoughtful nudge.',
        followUps: ['What pattern should I watch?', 'Say more about that'],
      }),
    })

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.promptedTurn({
      label: 'Reflection',
      turnKind: 'proactive-conversation',
      intent: 'Offer a brief post-session reflection that helps the user integrate what just happened.',
      history: [
        { role: 'user', content: 'That meeting felt scattered.' },
        { role: 'assistant', content: 'What was the biggest source of drift?' },
      ],
    })

    expect(result.message).toBe('Here is a thoughtful nudge.')
    expect(result.actions).toEqual([])
    expect(result.followUps).toEqual(['What pattern should I watch?', 'Say more about that'])

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('REFLECTION:')
    expect(call.systemPrompt).toContain('Intent: Offer a brief post-session reflection')
    expect(call.systemPrompt).toContain('This turn was initiated by the app')
    expect(call.systemPrompt).toContain('"followUps": Natural next things the user might realistically tap or say next')
    expect(call.systemPrompt).not.toContain('Operational reality:')
    // History is passed through the provider's history param (via chat()), not inlined in the prompt
    expect(call.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'That meeting felt scattered.' }),
    ]))
    expect(call.responseSchema).toBeDefined()
    expect(call.message).toContain('Use the turn instructions and structured context as the live input.')
  })

  it('normalizes structured JSON payloads with message field', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ message: 'A quick reflective note.', actions: [] }),
    })

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.promptedTurn({
      intent: 'Offer a short reflective note.',
    })

    expect(result.message).toBe('A quick reflective note.')
  })

  it('falls back gracefully when the provider returns plain text', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'A direct check-in.' })

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const result = await persona.promptedTurn({
      intent: 'Offer a direct check-in.',
    })

    expect(result.message).toBe('A direct check-in.')
    expect(result.followUps).toBeUndefined()
  })

  it('retries CRUD validation as internal guidance without making the retry prompt user-facing', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          message: 'I drafted this.',
          actions: [
            {
              name: 'crud',
              params: {
                operation: 'create',
                entity: 'task',
                id: '_task1',
                params: { title: 'Draft plan' },
              },
            },
          ],
          outcomeNotes: [],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          message: 'Here is the clean operational summary.',
          actions: [
            {
              name: 'crud',
              params: {
                operation: 'create',
                entity: 'task',
                id: '_task1',
                params: { title: 'Draft plan', evidence: 'from transcript' },
              },
            },
          ],
          outcomeNotes: [],
        }),
      })

    const persona = definePersona({
      ...BASE_CONFIG,
      provider,
      entities: {
        task: {
          schema: z.object({
            title: z.string(),
            evidence: z.string().optional(),
          }),
        },
      },
    })

    const result = await persona.promptedTurn({
      intent: 'Produce the operational summary.',
      turnKind: 'operational',
      crudValidation: actions => (
        actions.some(a => a.entity === 'task' && !a.params?.evidence)
          ? ['task requires evidence']
          : null
      ),
      crudValidationRetries: 1,
    })

    expect(result.message).toBe('Here is the clean operational summary.')
    expect(provider.chat).toHaveBeenCalledTimes(2)
    const first = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const second = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1][0]

    expect(first.message).toBe(second.message)
    expect(second.message).not.toContain('CRUD validation errors')
    expect(second.history ?? []).toEqual([])
    expect(second.systemPrompt).toContain('VALIDATION FEEDBACK')
    expect(second.systemPrompt).toContain('task requires evidence')
    expect(second.systemPrompt).toContain('Do not mention validation')
  })
})

describe('exact LLM request builders', () => {
  it('matches the runtime provider request for full chat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T19:55:00.000Z'))
    try {
      const provider = createMockProvider()
      const persona = definePersona({ ...BASE_CONFIG, provider })
      const input = {
        message: 'Help me think through dinner.',
        timezone: 'America/Los_Angeles',
        history: [{ role: 'user' as const, content: 'Breakfast was fine.' }],
      }

      const prepared = buildChatLLMRequest(persona.config, input)
      await persona.chat(input)

      const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.systemPrompt).toBe(prepared.request.systemPrompt)
      expect(call.history).toEqual(prepared.request.history)
      expect(call.message).toBe(prepared.request.message)
      expect(call.responseSchema).toEqual(prepared.request.responseSchema)
      expect(call.attachments).toEqual(prepared.request.attachments)
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches the runtime provider request for proactive prompted turns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T19:55:00.000Z'))
    try {
      const provider = createMockProvider()
      const persona = definePersona({ ...BASE_CONFIG, provider })
      const input = {
        label: 'Greeting',
        turnKind: 'proactive-conversation' as const,
        intent: 'Check in warmly after a long gap.',
        timezone: 'America/Los_Angeles',
        history: [{ role: 'assistant' as const, content: 'We can keep this simple tonight.' }],
      }

      const prepared = buildPromptedTurnLLMRequest(persona.config, input)
      await persona.promptedTurn(input)

      const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.systemPrompt).toBe(prepared.request.systemPrompt)
      expect(call.history).toEqual(prepared.request.history)
      expect(call.message).toBe(prepared.request.message)
      expect(call.responseSchema).toEqual(prepared.request.responseSchema)
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches the runtime provider request for operational prompted turns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T19:55:00.000Z'))
    try {
      const provider = createMockProvider()
      const persona = definePersona({ ...BASE_CONFIG, provider })
      const input = {
        label: 'Daily Brief',
        turnKind: 'operational' as const,
        intent: 'Run the next operational pass over the shared state.',
        timezone: 'America/Los_Angeles',
        context: { queue: 'Thread A\nThread B' },
      }

      const prepared = buildPromptedTurnLLMRequest(persona.config, input)
      await persona.promptedTurn(input)

      const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.systemPrompt).toBe(prepared.request.systemPrompt)
      expect(call.history).toEqual(prepared.request.history)
      expect(call.message).toBe(prepared.request.message)
      expect(call.responseSchema).toEqual(prepared.request.responseSchema)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PersonaEngine.retrospect()', () => {
  it('calls LLM with a silent retrospective prompt and action-only schema', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'memory',
              params: {
                content: 'Often ends the day low on fat and compensates late at night.',
                category: 'pattern',
              },
            },
          },
        ],
      }),
    })

    const persona = definePersona({ ...BASE_CONFIG, memory: { enabled: true }, provider })
    const result = await persona.retrospect({
      userIdentity: 'Alex',
      history: [
        { role: 'user', content: 'I ended up needing almonds again before bed.' },
        { role: 'assistant', content: 'That keeps happening late.' },
      ],
      context: {
        recentDays: 'Day 1: low fat until night.\nDay 2: low fat until night.',
      },
      memories: [
        { id: 'mem-1', content: 'Likes Mediterranean flavors.', category: 'preference' },
      ],
    })

    expect(result.actions).toEqual([])
    expect(result.crudActions).toHaveLength(1)
    expect(result.crudActions?.[0]).toMatchObject({
      operation: 'create',
      entity: 'memory',
    })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('RETROSPECTIVE MODE:')
    expect(call.systemPrompt).toContain('RECENT CONVERSATION:')
    expect(call.systemPrompt).toContain('what would have improved earlier recommendations')
    expect(call.message).toBe('Run the silent retrospective and return only the memory mutations that should change.')
    expect(call.responseSchema).toEqual({
      type: 'object',
      properties: {
        actions: expect.anything(),
        diagnostics: expect.anything(),
      },
    })
  })

  it('drops non-memory actions from retrospective responses', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'memory',
              params: { content: 'Skips breakfast often.', category: 'routine' },
            },
          },
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'meal',
              params: { description: 'Eggs' },
            },
          },
        ],
      }),
    })

    const persona = definePersona({
      ...BASE_CONFIG,
      provider,
      memory: { enabled: true },
      entities: {
        meal: {
          schema: z.object({ description: z.string() }),
          label: 'Meal',
          displayField: 'description',
        },
      },
    })
    const result = await persona.retrospect({})

    expect(result.actions).toEqual([])
    expect(result.crudActions).toHaveLength(1)
    expect(result.crudActions?.[0]).toMatchObject({
      operation: 'create',
      entity: 'memory',
    })
  })
})

// ─── 1E. buildGreetingPrompt() / buildPromptedTurnPrompt() ─────────────────

describe('buildGreetingPrompt()', () => {
  it('builds a greeting prompt with full system prompt sections', () => {
    const provider = createMockProvider()
    const prompt = buildGreetingPrompt({
      config: { ...BASE_CONFIG, provider },
      input: {
        timezone: 'America/New_York',
        userIdentity: 'Test User',
      },
    })
    expect(prompt).toContain('TestBot')
    expect(prompt).toContain('checking in')
    expect(prompt).toContain('come back')
    // Now composes on buildSystemPrompt — includes action output contract
    expect(prompt).toContain('Output contract:')
  })

  it('includes guidelines when provided', () => {
    const provider = createMockProvider()
    const prompt = buildGreetingPrompt({
      config: { ...BASE_CONFIG, provider },
      input: { timezone: 'UTC' },
      guidelines: 'Be extra warm in morning greetings.',
    })
    expect(prompt).toContain('Be extra warm in morning greetings.')
  })

  it('includes memories with reduced budget', () => {
    const provider = createMockProvider()
    const prompt = buildGreetingPrompt({
      config: { ...BASE_CONFIG, provider },
      input: {
        memories: [
          { id: 'm1', content: 'Loves Mediterranean food', category: 'preference' },
        ],
      },
    })
    expect(prompt).toContain('Mediterranean food')
  })
})

describe('buildPromptedTurnPrompt()', () => {
  it('builds an app-initiated prompt with intent and history continuity', () => {
    const provider = createMockProvider()
    const prompt = buildPromptedTurnPrompt({
      config: { ...BASE_CONFIG, provider },
      input: {
        timezone: 'UTC',
        userIdentity: 'Test User',
      },
      label: 'Post-Debrief',
      turnKind: 'proactive-conversation',
      intent: 'Offer a short post-debrief reflection that builds on the existing conversation.',
      history: [
        { role: 'assistant', content: 'We saw a lot of confusion in the room.' },
        { role: 'user', content: 'Yes, and I think I contributed to it.' },
      ],
      guidelines: 'Keep it concise and grounded.',
    })

    expect(prompt).toContain('POST-DEBRIEF:')
    expect(prompt).toContain('Intent: Offer a short post-debrief reflection')
    expect(prompt).toContain('This turn was initiated by the app')
    expect(prompt).toContain('RECENT CONVERSATION:')
    expect(prompt).toContain('Keep it concise and grounded.')
    // Now composes on buildSystemPrompt — includes the full action contract
    expect(prompt).toContain('Output contract:')
  })
})

describe('buildRetrospectPrompt()', () => {
  it('frames retrospective as a silent pattern-finding pass without user-facing coaching', () => {
    const provider = createMockProvider()
    const prompt = buildRetrospectPrompt({
      config: {
        ...BASE_CONFIG,
        provider,
        memory: {
          enabled: true,
          purpose: 'Carry forward the handful of things that would materially improve future conversations with this person.',
        },
        contextInputs: {
          recentDays: {
            label: "RECENT DAYS",
            format: "block",
          },
        },
      },
      input: {
        timezone: 'UTC',
        userIdentity: 'Test User',
        memories: [
          { id: 'mem-1', content: 'Likes savory breakfasts.', category: 'preference' },
        ],
        context: {
          recentDays: 'Repeatedly low on fat until late evening.',
        },
      },
      history: [
        { role: 'assistant', content: 'You keep needing nuts late at night.' },
        { role: 'user', content: 'Yeah, that keeps happening.' },
      ],
      guidelines: 'Notice repeated nutrition patterns that should influence future suggestions.',
    })

    expect(prompt).toContain('RETROSPECTIVE MODE:')
    expect(prompt).toContain('MEMORY PURPOSE:')
    expect(prompt).toContain('materially improve future conversations')
    expect(prompt).toContain('silent internal reflection pass')
    expect(prompt).toContain('RECENT CONVERSATION:')
    expect(prompt).toContain('Repeatedly low on fat until late evening.')
    expect(prompt).toContain('Notice repeated nutrition patterns')
    expect(prompt).toContain('--- ENTITIES')
    expect(prompt).not.toContain('"message": string')
  })
})

// ─── 1E. Auto-annotate messages in managed mode ─────────────────────────────

describe('auto-annotate messages in managed mode', () => {
  it('appends annotations to saved assistant message', async () => {
    const response = JSON.stringify({
      message: 'Logged your breakfast!',
      actions: [
        { name: 'logMeal', params: { description: 'Oatmeal', calories: 300 } },
      ],
      followUps: [],
    })
    const provider = createMockProvider(response)
    const adapter = createMockAdapter()

    const persona = definePersona({
      ...BASE_CONFIG,
      actions: {
        logMeal: {
          description: 'Log a meal',
          schema: z.object({ description: z.string(), calories: z.number() }),
          confidence: 'low',
        },
      },
      provider,
    })

    const managed = withStorage(persona, { adapter })
    await managed.chat({ message: 'I had oatmeal' })

    // Check that the assistant message content includes annotations
    const assistantCall = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(assistantCall[1].content).toContain('---actions:')
    expect(assistantCall[1].content).toContain('logMeal')
  })

  it('does not annotate when no actions', async () => {
    const response = JSON.stringify({
      message: 'Sounds good!',
      actions: [],
      followUps: [],
    })
    const provider = createMockProvider(response)
    const adapter = createMockAdapter()

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })
    await managed.chat({ message: 'Hello' })

    const assistantCall = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(assistantCall[1].content).toBe('Sounds good!')
    expect(assistantCall[1].content).not.toContain('---actions:')
  })
})

// ─── 1E. annotateMessage() utility ──────────────────────────────────────────

describe('annotateMessage()', () => {
  it('appends annotations with default separator', () => {
    const result = annotateMessage('Hello!', ['logged: Breakfast', 'saved memory: Likes oats'])
    expect(result).toBe('Hello!\n---actions: logged: Breakfast | saved memory: Likes oats')
  })

  it('returns original message when no annotations', () => {
    const result = annotateMessage('Hello!', [])
    expect(result).toBe('Hello!')
  })

  it('includes outcome notes before action annotations', () => {
    const result = annotateMessage('Hello!', ['action1'], ['Weight logged'])
    expect(result).toBe('Hello!\n---outcomes: Weight logged\n---actions: action1')
  })
})

// ─── 1F. managed.greet() / managed.promptedTurn() ──────────────────────────

describe('managed.greet()', () => {
  it('creates conversation, calls greet, saves assistant message', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'Good morning!' })

    const adapter = createMockAdapter()
    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })

    const result = await managed.greet({
      timezone: 'America/New_York',
      userIdentity: 'Test User',
    })

    expect(result.greeting).toBe('Good morning!')
    expect(result.conversationId).toBe('conv-1')
    expect(adapter.createConversation).toHaveBeenCalledWith('greeting', undefined)

    // Should have saved one assistant message
    expect(adapter.saveMessage).toHaveBeenCalledTimes(1)
    const savedMsg = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(savedMsg[0]).toBe('conv-1')
    expect(savedMsg[1].role).toBe('assistant')
    expect(savedMsg[1].content).toBe('Good morning!')
  })

  it('passes locale through to greeting prompt', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'בוקר טוב!' })

    const adapter = createMockAdapter()
    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })

    await managed.greet({ locale: 'he' })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('RESPOND IN Hebrew.')
  })
})

describe('managed.promptedTurn()', () => {
  it('creates a conversation, stores the assistant message, and returns the conversation id', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'A useful follow-up reflection.' })

    const adapter = createMockAdapter()
    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })

    const result = await managed.promptedTurn({
      label: 'Post-Debrief',
      intent: 'Offer a short post-debrief reflection.',
      trigger: 'post_debrief',
    })

    expect(result.message).toBe('A useful follow-up reflection.')
    expect(result.conversationId).toBe('conv-1')
    expect(adapter.createConversation).toHaveBeenCalledWith('post_debrief', undefined)
    expect(adapter.saveMessage).toHaveBeenCalledTimes(1)
    const saved = (adapter.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(saved[1].role).toBe('assistant')
    expect(saved[1].content).toBe('A useful follow-up reflection.')
  })

  it('persists memory CRUD through the managed Layer 2 path', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        message: 'A calm morning note.',
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'memory',
              params: {
                content: 'Prefers short morning check-ins before work.',
                category: 'preference',
              },
            },
          },
        ],
        followUps: [],
      }),
    })

    const adapter = createMockAdapter()
    const persona = definePersona({ ...BASE_CONFIG, provider, memory: { enabled: true } })
    const managed = withStorage(persona, { adapter })

    await managed.promptedTurn({
      label: 'Morning greeting',
      intent: 'Check in gently at the start of the day.',
    })

    expect(adapter.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Prefers short morning check-ins before work.',
      category: 'preference',
      pinned: false,
      createdAt: expect.any(String),
    }))
  })

  it('executes SDK memory CRUD but only returns app-owned CRUD actions', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        message: 'I drafted a useful follow-up.',
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'memory',
              params: {
                content: 'Prefers concise post-meeting summaries.',
                category: 'preference',
              },
            },
          },
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'task',
              params: {
                title: 'Send summary to the team',
              },
            },
          },
        ],
        followUps: [],
      }),
    })

    const adapter = createMockAdapter()
    const persona = definePersona({
      ...BASE_CONFIG,
      provider,
      memory: { enabled: true },
      entities: {
        task: {
          schema: z.object({ title: z.string() }),
          label: 'Task',
          displayField: 'title',
        },
      },
    })
    const managed = withStorage(persona, { adapter })

    const result = await managed.promptedTurn({
      label: 'Post-meeting follow-up',
      intent: 'Offer a concise next step after the meeting.',
    })

    expect(adapter.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Prefers concise post-meeting summaries.',
      category: 'preference',
      pinned: false,
      createdAt: expect.any(String),
    }))
    expect(result.crudActions).toEqual([
      expect.objectContaining({
        operation: 'create',
        entity: 'task',
        params: { title: 'Send summary to the team' },
      }),
    ])
  })
})

describe('managed.chat() SDK CRUD boundary', () => {
  it('executes SDK memory CRUD but only returns app-owned CRUD actions', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        message: 'I captured that and drafted the next step.',
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'memory',
              params: {
                content: 'Likes decisions summarized in one sentence first.',
                category: 'preference',
              },
            },
          },
          {
            name: 'crud',
            params: {
              operation: 'create',
              entity: 'task',
              params: {
                title: 'Share final decision summary',
              },
            },
          },
        ],
        followUps: [],
      }),
    })

    const adapter = createMockAdapter()
    const persona = definePersona({
      ...BASE_CONFIG,
      provider,
      memory: { enabled: true },
      entities: {
        task: {
          schema: z.object({ title: z.string() }),
          label: 'Task',
          displayField: 'title',
        },
      },
    })
    const managed = withStorage(persona, { adapter })

    const result = await managed.chat({ message: 'Can you turn this into a next step?' })

    expect(adapter.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Likes decisions summarized in one sentence first.',
      category: 'preference',
      pinned: false,
      createdAt: expect.any(String),
    }))
    expect(result.crudActions).toEqual([
      expect.objectContaining({
        operation: 'create',
        entity: 'task',
        params: { title: 'Share final decision summary' },
      }),
    ])
  })
})

describe('managed.retrospect()', () => {
  it('executes memory CRUD without saving conversation messages', async () => {
    const provider = createMockProvider()
    ;(provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        actions: [
          {
            name: 'crud',
            params: {
              operation: 'update',
              entity: 'memory',
              id: 'mem-1',
              params: '{"content":"Often needs more dietary fat earlier in the day."}',
            },
          },
        ],
      }),
    })

    const adapter = createMockAdapter()
    const persona = definePersona({ ...BASE_CONFIG, memory: { enabled: true }, provider })
    const managed = withStorage(persona, { adapter })

    const result = await managed.retrospect({
      history: [
        { role: 'user', content: 'I keep having to chase fat late at night.' },
      ],
    })

    expect(result.crudActions).toHaveLength(1)
    expect(result.results).toEqual([
      {
        name: 'update_memory',
        status: 'executed',
      },
    ])
    expect(adapter.updateMemory).toHaveBeenCalledWith('mem-1', {
      content: 'Often needs more dietary fat earlier in the day.',
    })
    expect(adapter.saveMessage).not.toHaveBeenCalled()
    expect(adapter.createConversation).not.toHaveBeenCalled()
  })
})

// ─── 1G. ZodNullable in zodToGeminiSchema ───────────────────────────────────

describe('ZodNullable in zodToGeminiSchema', () => {
  it('converts nullable string to schema with nullable: true', () => {
    const schema = zodToGeminiSchema(z.string().nullable())
    expect(schema.nullable).toBe(true)
    expect(schema.type).toBeDefined()
  })

  it('converts nullable number to schema with nullable: true', () => {
    const schema = zodToGeminiSchema(z.number().nullable())
    expect(schema.nullable).toBe(true)
    expect(schema.type).toBeDefined()
  })

  it('preserves description on nullable types', () => {
    const schema = zodToGeminiSchema(z.string().nullable().describe('A nullable field'))
    expect(schema.nullable).toBe(true)
    expect(schema.description).toBe('A nullable field')
  })

  it('handles nullable arrays', () => {
    const schema = zodToGeminiSchema(z.array(z.string()).nullable())
    expect(schema.nullable).toBe(true)
    expect(schema.type).toBeDefined()
  })
})

// ─── Managed mode passes locale and attachments ─────────────────────────────

describe('managed mode passes locale and attachments', () => {
  it('passes locale to stateless chat', async () => {
    const provider = createMockProvider()
    const adapter = createMockAdapter()

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })

    await managed.chat({ message: 'test', locale: 'he' })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('RESPOND IN Hebrew.')
  })

  it('passes attachments to stateless chat', async () => {
    const provider = createMockProvider()
    const adapter = createMockAdapter()

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })

    const attachments = [{
      type: 'image' as const,
      mimeType: 'image/jpeg',
      data: 'base64data',
    }]

    await managed.chat({ message: 'check this', attachments })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.attachments).toEqual(attachments)
  })

  it('stores and reuses prior image notes in managed mode', async () => {
    const provider = {
      name: 'mock',
      chat: vi.fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            message: 'That looks like salmon, eggs, and toast.',
            actions: [],
            attachmentNotes: ['Earlier photo showed a savory breakfast with salmon, eggs, and toast.'],
            followUps: [],
          }),
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            message: 'Given that earlier breakfast photo, adding fruit would round it out.',
            actions: [],
            followUps: [],
          }),
        }),
    } satisfies LLMProvider

    const messages: Message[] = []
    let activeConversationId: string | null = null
    const adapter: StorageAdapter = {
      getActiveConversation: vi.fn().mockImplementation(async () => (
        activeConversationId
          ? { id: activeConversationId, trigger: 'manual', createdAt: new Date().toISOString() }
          : null
      )),
      createConversation: vi.fn().mockImplementation(async () => {
        activeConversationId = 'conv-1'
        return activeConversationId
      }),
      endConversation: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockImplementation(async () => [...messages]),
      saveMessage: vi.fn().mockImplementation(async (_convId, msg) => {
        messages.push({ ...msg, createdAt: new Date().toISOString() })
      }),
      loadMemories: vi.fn().mockResolvedValue([]),
      saveMemory: vi.fn().mockResolvedValue('mem-1'),
      updateMemory: vi.fn().mockResolvedValue(undefined),
      deleteMemory: vi.fn().mockResolvedValue(undefined),
    }

    const persona = definePersona({ ...BASE_CONFIG, provider })
    const managed = withStorage(persona, { adapter })

    await managed.chat({
      message: 'What is in this photo?',
      attachments: [{ type: 'image', mimeType: 'image/jpeg', data: 'base64data' }],
    })

    const savedNote = messages.find(message => message.role === 'system')
    expect(savedNote?.content).toBe(
      buildAttachmentCarryForwardMessage([
        'Earlier photo showed a savory breakfast with salmon, eggs, and toast.',
      ]),
    )

    await managed.chat({ message: 'Was that breakfast missing anything?' })

    const secondCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(secondCall.systemPrompt).toContain('PRIOR IMAGE CONTEXT:')
    expect(secondCall.systemPrompt).toContain('Earlier photo showed a savory breakfast with salmon, eggs, and toast.')
  })
})

// ─── followUpsDescription flows through engine ──────────────────────────────

describe('followUpsDescription flows through engine', () => {
  it('passes custom followUpsDescription without dropping the core user-voice contract', async () => {
    const provider = createMockProvider()
    const persona = definePersona({
      ...BASE_CONFIG,
      followUpsDescription: 'Suggest tappable next steps.',
      provider,
    })

    await persona.chat({ message: 'test' })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const schema = call.responseSchema
    expect(schema.properties.followUps.description).toContain('Suggest tappable next steps.')
    expect(schema.properties.followUps.description).toContain('written in their voice, not yours')
  })
})
