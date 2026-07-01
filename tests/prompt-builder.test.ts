import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildPromptedTurnPrompt, buildRetrospectPrompt } from '../src/core/prompt-builder.js'
import { buildConversationKeystone, buildIdentityBlock } from '../src/core/identity.js'
import { buildVoiceBlock } from '../src/core/voice.js'
import { buildEQBlock } from '../src/core/eq.js'
import { buildActionsBlock } from '../src/core/actions.js'
import { buildGreetingHint, shouldGreet } from '../src/core/greeting.js'
import type { PersonaConfig, ChatInput, LLMProvider } from '../src/types.js'
import { z } from 'zod'

const mockProvider: LLMProvider = {
  name: 'mock',
  async chat() { return { text: '{"message":"hi"}' } },
}

const coachConfig: PersonaConfig = {
  identity: {
    name: 'Coach',
    expertise: ['executive coaching', 'organizational behavior'],
    relationship: 'trusted thinking partner',
    northStar: "the CEO's growth and the company's forward momentum",
    scopeBoundary: "Not a therapist — say so warmly if beyond scope.",
  },
  voice: { tone: 'balanced', style: 'educator', medium: 'desktop-panel' },
  methodology: 'Threads are CEO-level challenges. Movement means decisions made.',
  directives: { default: 'You are the CEO\'s executive coach.', editable: true },
  actions: {
    updateThread: {
      description: 'Update a thread when CEO requests.',
      schema: z.object({ entityId: z.string(), field: z.string(), newValue: z.string() }),
      confidence: 'high',
    },
    saveMemory: {
      description: 'Save a lasting insight.',
      schema: z.object({ content: z.string(), category: z.string() }),
      confidence: 'low',
    },
  },
  contextInputs: {
    threads: { label: 'OPEN THREADS', format: 'list' },
    memories: { label: 'COACH MEMORY', budget: 8000, prioritize: 'pinned-first' },
  },
  eq: { frequencyRule: true, autonomyRespect: true, qualitativeFirst: true },
  provider: mockProvider,
}

// ─── Identity ────────────────────────────────────────────────────────────────

describe('buildIdentityBlock', () => {
  it('includes persona name and expertise', () => {
    const block = buildIdentityBlock(coachConfig.identity)
    expect(block).toContain('You are Coach')
    expect(block).toContain('executive coaching')
    expect(block).toContain('organizational behavior')
  })

  it('includes relationship and north star', () => {
    const block = buildIdentityBlock(coachConfig.identity)
    expect(block).toContain('trusted thinking partner')
    expect(block).toContain("the CEO's growth")
  })

  it('includes scope boundary', () => {
    const block = buildIdentityBlock(coachConfig.identity)
    expect(block).toContain('Not a therapist')
  })

  it('keeps identity neutral by default', () => {
    const block = buildIdentityBlock(coachConfig.identity)
    expect(block).not.toContain('single most impactful thing')
    expect(block).not.toContain('real person in front of you')
  })
})

describe('buildConversationKeystone', () => {
  it('includes the default relational preamble and keystone', () => {
    const block = buildConversationKeystone(coachConfig.identity)
    expect(block).toContain('single most impactful thing')
    expect(block).toContain('real person in front of you')
  })

  it('allows custom keystone', () => {
    const block = buildConversationKeystone({
      ...coachConfig.identity,
      keystone: 'What would a great coach say here?',
    })
    expect(block).toContain('What would a great coach say here?')
    expect(block).not.toContain('single most impactful')
  })
})

// ─── Voice ───────────────────────────────────────────────────────────────────

describe('buildVoiceBlock', () => {
  it('includes tone instruction', () => {
    const block = buildVoiceBlock({ tone: 'direct', style: 'quick' })
    expect(block).toContain('straightforward')
  })

  it('includes style instruction', () => {
    const block = buildVoiceBlock({ tone: 'warm', style: 'educator' })
    expect(block).toContain('teaching, not just advising')
  })

  it('includes medium framing when provided', () => {
    const block = buildVoiceBlock({ tone: 'balanced', style: 'educator', medium: 'mobile-chat' })
    expect(block).toContain('mobile chat')
  })

  it('carries style cue for quick voice', () => {
    const block = buildVoiceBlock({ tone: 'direct', style: 'quick' })
    expect(block).toContain('Concise, direct advice.')
  })
})

// ─── EQ ──────────────────────────────────────────────────────────────────────

describe('buildEQBlock', () => {
  it('returns empty when no EQ config', () => {
    expect(buildEQBlock(undefined)).toBe('')
    expect(buildEQBlock({})).toBe('')
  })

  it('includes frequency rule', () => {
    const block = buildEQBlock({ frequencyRule: true })
    expect(block).toContain('Continuity:')
    expect(block).toContain('next layer underneath')
  })

  it('includes autonomy respect', () => {
    const block = buildEQBlock({ autonomyRespect: true })
    expect(block).toContain('processing or thinking aloud')
  })

  it('includes qualitative first', () => {
    const block = buildEQBlock({ qualitativeFirst: true })
    expect(block).toContain('Lead with judgment and meaning')
  })

  it('includes coherence', () => {
    const block = buildEQBlock({ coherence: true })
    expect(block).toContain('Coherence')
    expect(block).toContain('make the shift legible')
  })

  it('includes expert judgment', () => {
    const block = buildEQBlock({ expertJudgment: true })
    expect(block).toContain('Expert judgment')
    expect(block).toContain('recommendations carry real weight')
    expect(block).toContain('critical gaps with assumptions')
  })

  it('omits conversation-only autonomy guidance in operational mode', () => {
    const block = buildEQBlock({ autonomyRespect: true, coherence: true }, 'operational')
    expect(block).not.toContain('processing or thinking aloud')
    expect(block).toContain('Coherence')
  })
})

// ─── Actions ─────────────────────────────────────────────────────────────────

describe('buildActionsBlock', () => {
  it('returns empty when no actions', () => {
    expect(buildActionsBlock(undefined)).toBe('')
    expect(buildActionsBlock({})).toBe('')
  })

  it('lists all actions with confidence labels', () => {
    const block = buildActionsBlock(coachConfig.actions!)
    expect(block).toContain('updateThread')
    expect(block).toContain('confirm first')
    expect(block).toContain('saveMemory')
    expect(block).toContain('just do it')
  })

  it('includes confidence level descriptions', () => {
    const block = buildActionsBlock(coachConfig.actions!)
    expect(block).toContain('Confidence levels:')
    expect(block).toContain('low (just do it)')
  })

  it('renders operational execution levels without human confirmation language', () => {
    const block = buildActionsBlock(coachConfig.actions!, 'operational')
    expect(block).toContain('Execution policy:')
    expect(block).toContain('do not execute it automatically in this turn')
    expect(block).not.toContain('confirm first')
  })

  it('includes param field names from Zod schema in prompt text', () => {
    // Regression: when Gemini stringifies params (anyOf schemas), the structured output
    // schema doesn't apply. The model needs to see field names in the text prompt
    // to produce correct param shapes. Without this, it guesses field names from
    // document context (e.g. "description" instead of "merchant").
    const block = buildActionsBlock(coachConfig.actions!)
    expect(block).toContain('params:')
    // Actual field names from the Zod schemas must appear
    expect(block).toContain('entityId')
    expect(block).toContain('field')
    expect(block).toContain('newValue')
    expect(block).toContain('content')
    expect(block).toContain('category')
  })

  it('renders actions as compact reference documentation', () => {
    const block = buildActionsBlock(coachConfig.actions!)
    expect(block).toContain('when:')
    expect(block).toContain('confidence:')
    expect(block).toContain('exact keys: name, params')
    expect(block).toContain('example item:')
    expect(block).not.toContain('purpose:')
  })

  it('uses a configured action for the example item', () => {
    const block = buildActionsBlock(coachConfig.actions!)
    expect(block).toContain('"name":"updateThread"')
    expect(block).not.toContain('sendInternalMemo')
  })
})

// ─── Greeting ────────────────────────────────────────────────────────────────

describe('shouldGreet', () => {
  it('returns true when no last message', () => {
    expect(shouldGreet(null)).toBe(true)
    expect(shouldGreet(undefined)).toBe(true)
  })

  it('returns true when last message >2 hours ago', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    expect(shouldGreet(threeHoursAgo)).toBe(true)
  })

  it('returns false when last message is recent', () => {
    const now = new Date('2026-04-09T10:00:00Z')
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000)
    expect(shouldGreet(fiveMinutesAgo, now)).toBe(false)
  })
})

describe('buildGreetingHint', () => {
  it('returns empty when not greeting', () => {
    expect(buildGreetingHint(false)).toBe('')
  })

  it('returns fresh session hint when greeting', () => {
    const hint = buildGreetingHint(true, 'America/Los_Angeles')
    expect(hint).toContain('fresh session')
  })
})

// ─── Full prompt assembly ────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('assembles all sections in order', () => {
    const prompt = buildSystemPrompt({
      config: coachConfig,
      input: {
        message: 'hello',
        history: [],
        context: {
          threads: [{ id: '1', title: 'Revenue growth', status: 'active' }],
        },
        memories: [
          { id: 'm1', content: 'CEO prefers direct feedback', category: 'preference', pinned: true },
        ],
        timezone: 'America/New_York',
        userIdentity: 'Alex, CEO of Acme',
      },
    })

    // Check section presence and rough ordering
    expect(prompt).toContain("Today:")
    expect(prompt).toContain('You are talking to Alex')
    expect(prompt).toContain('You are Coach')
    expect(prompt).toContain('Threads are CEO-level challenges')
    expect(prompt).toContain("CEO's executive coach")
    expect(prompt).toContain('Continuity:')
    expect(prompt).toContain('updateThread')
    expect(prompt).toContain('domain expert')
    expect(prompt).toContain('Conversation reality:')
    expect(prompt).toContain('structured context, durable work items, entities, explicit constraints, and memories are all part of the live situation')
    expect(prompt).toContain('Output contract:')
    expect(prompt).toContain('"outcomeNotes"')
    expect(prompt).toContain('"followUps"')
    expect(prompt).not.toContain('fresh session')
    expect(prompt).toContain('OPEN THREADS')
    expect(prompt).toContain('Revenue growth')
    expect(prompt).toContain('COACH MEMORY')
    expect(prompt).toContain('CEO prefers direct feedback')
    expect(prompt).toContain('come back and think with me')

    // Verify order: identity before methodology before context
    const identityIdx = prompt.indexOf('You are Coach')
    const methodIdx = prompt.indexOf('Threads are CEO-level')
    const contextIdx = prompt.indexOf('OPEN THREADS')
    const comebackIdx = prompt.indexOf('come back and think')
    const actionsIdx = prompt.indexOf('--- AVAILABLE ACTIONS ---')
    const memoryIdx = prompt.indexOf('COACH MEMORY')
    expect(identityIdx).toBeLessThan(methodIdx)
    expect(methodIdx).toBeLessThan(comebackIdx)
    expect(comebackIdx).toBeLessThan(actionsIdx)
    expect(actionsIdx).toBeLessThan(contextIdx)
    expect(methodIdx).toBeLessThan(contextIdx)
    expect(contextIdx).toBeLessThan(memoryIdx)
  })

  it('works with minimal config', () => {
    const minimal: PersonaConfig = {
      identity: {
        name: 'Helper',
        expertise: ['general knowledge'],
        relationship: 'helpful assistant',
        northStar: 'user productivity',
      },
      voice: { tone: 'balanced', style: 'quick' },
      provider: mockProvider,
    }

    const prompt = buildSystemPrompt({
      config: minimal,
      input: { message: 'hi' },
    })

    expect(prompt).toContain('You are Helper')
    expect(prompt).toContain('user productivity')
    expect(prompt).not.toContain('AVAILABLE ACTIONS')
    expect(prompt).toContain('Output contract:')
    expect(prompt).toContain('Conversation reality:')
    expect(prompt).toContain('The information in front of you is usually incomplete.')
  })

  it('renders a factual session frame without changing persona instructions', () => {
    const prompt = buildSystemPrompt({
      config: coachConfig,
      input: {
        message: 'Let’s build the game.',
        session: {
          actorId: 'pm',
          visibleTo: 'shared PM-builder work session',
          purpose: 'Build Clockwork Courier from the project brief.',
          participants: [
            { id: 'pm', label: 'Product Manager', description: 'shapes product clarity and handoffs' },
            { id: 'builder', label: 'Builder', description: 'implements and verifies the browser game artifact' },
          ],
        },
      },
    })

    expect(prompt).toContain('Session:')
    expect(prompt).toContain('- Speaking as: pm')
    expect(prompt).toContain('- Visible message goes to: shared PM-builder work session')
    expect(prompt).toContain('- Session purpose: Build Clockwork Courier from the project brief.')
    expect(prompt).toContain('pm: Product Manager')
    expect(prompt).toContain('builder: Builder')
    const sessionBlock = prompt.slice(prompt.indexOf('Session:'), prompt.indexOf('Continuity:'))
    expect(sessionBlock).not.toMatch(/\bmust\b/i)
    expect(sessionBlock).not.toMatch(/\bdo not\b/i)
  })

  it('includes memory purpose when configured', () => {
    const prompt = buildSystemPrompt({
      config: {
        ...coachConfig,
        memory: {
          purpose: 'These are the handful of things worth already knowing before future coaching conversations.',
          enabled: true,
        },
      },
      input: {
        message: 'hello',
      },
    })

    expect(prompt).toContain('MEMORY PURPOSE:')
    expect(prompt).toContain('worth already knowing before future coaching conversations')
  })

  it('does not inject discovery field into prompt', () => {
    const prompt = buildSystemPrompt({
      config: {
        ...coachConfig,
        discovery: "You're sitting down with a new client for the first time.",
      },
      input: { message: 'hello' },
    })

    // Discovery is no longer injected — the AI deduces relationship stage from memories and history
    expect(prompt).not.toContain("sitting down with a new client")
  })
})

// ─── Cold start ─────────────────────────────────────────────────────────────

describe('cold start instructions', () => {
  it('covers beginning of journey and professional responsibility', () => {
    const prompt = buildSystemPrompt({
      config: coachConfig,
      input: { message: 'hello' },
    })

    expect(prompt).toContain('The information in front of you is usually incomplete.')
    expect(prompt).toContain('The visible recipients see your message, not the system')
  })
})

// ─── Expert responsibility ──────────────────────────────────────────────────

describe('expert responsibility', () => {
  it('includes expert responsibility framing', () => {
    const prompt = buildSystemPrompt({
      config: coachConfig,
      input: { message: 'hello' },
    })

    expect(prompt).toContain('You are the domain expert.')
  })
})

// ─── Memory path selection ──────────────────────────────────────────────────

describe('memory rules', () => {
  it('uses the memory entity path when memory is enabled', () => {
    const prompt = buildSystemPrompt({
      config: {
        ...coachConfig,
        memory: { enabled: true },
      },
      input: { message: 'hello' },
    })

    expect(prompt).toContain("Memory is what you've learned about this person")
    expect(prompt).toContain('through the crud action')
    expect(prompt).not.toContain('Memory extraction — newLearnings')
  })
})

// ─── buildPromptedTurnPrompt (composes on buildSystemPrompt) ────────────────

describe('buildPromptedTurnPrompt', () => {
  it('includes the full action contract when actions are configured', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      intent: 'Analyze this meeting transcript.',
      label: 'Debrief',
    })

    expect(prompt).toContain('AVAILABLE ACTIONS')
    expect(prompt).toContain('ACTION RESPONSE CONTRACT')
    expect(prompt).toContain('updateThread')
    expect(prompt).toContain('saveMemory')
    expect(prompt).toContain('example: {"name":"updateThread"')
    expect(prompt).toContain('example: {"name":"saveMemory"')
    expect(prompt).toContain('Action order: actions are attempts that execute in array order within this turn')
    expect(prompt).toContain('any action can succeed or fail')
    expect(prompt).toContain('Later actions run after earlier state changes')
    expect(prompt).toContain('when a result could change what you do next')
    expect(prompt).toContain('A same-turn visible completion, verification, or handoff message cannot reflect outcomes you have not seen yet.')
    expect(prompt).toContain('Output contract:')
    expect(prompt).toContain('"outcomeNotes"')
    expect(prompt).not.toContain('Follow-ups')
  })

  it('includes entities block when entities are configured', () => {
    const configWithEntities: PersonaConfig = {
      ...coachConfig,
      actions: {},
      entities: {
        thread: {
          schema: z.object({ title: z.string(), status: z.string() }),
          label: 'Thread',
          displayField: 'title',
        },
      },
    }
    const prompt = buildPromptedTurnPrompt({
      config: configWithEntities,
      input: { timezone: 'UTC' },
      intent: 'Analyze the transcript.',
    })

    expect(prompt).toContain('thread')
    expect(prompt).toContain('ENTITY CRUD RESPONSE CONTRACT')
    expect(prompt).toContain('do not use a top-level "crudActions" key')
    expect(prompt).toContain('example response item:')
    expect(prompt).toContain('Output contract:')
  })

  it('includes OUTCOME_NOTES_INSTRUCTION when actions or entities exist', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      intent: 'Coach the CEO.',
    })

    expect(prompt).toContain('Outcome notes')
    expect(prompt).toContain('subject may be the conversation, institution, or world depending on mode')
  })

  it('includes intent and label in prompt output', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      turnKind: 'proactive-conversation',
      intent: 'Generate a warm check-in.',
      label: 'Greeting',
    })

    expect(prompt).toContain('GREETING:')
    expect(prompt).toContain('Intent: Generate a warm check-in.')
    expect(prompt).toContain('This turn was initiated by the app')
    expect(prompt).toContain('not by a fresh inbound message')
  })

  it('includes guidelines when provided', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      intent: 'Brief the CEO.',
      guidelines: 'Keep it under 3 sentences.',
    })

    expect(prompt).toContain('Keep it under 3 sentences.')
  })

  it('does not duplicate the app-initiated frame in prompted-turn review prompts', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      label: 'Greeting',
      turnKind: 'proactive-conversation',
      intent: 'Generate a warm check-in.',
      guidelines: 'Keep it grounded.',
    })

    expect(prompt.match(/GREETING:/g)?.length ?? 0).toBe(1)
    expect(prompt.match(/Keep it grounded\./g)?.length ?? 0).toBe(1)
  })

  it('includes recent history for continuity', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      turnKind: 'proactive-conversation',
      intent: 'Follow up on the last exchange.',
      history: [
        { role: 'user', content: 'That was a tough meeting.' },
        { role: 'assistant', content: 'What made it tough?' },
      ],
    })

    expect(prompt).toContain('RECENT CONVERSATION:')
    expect(prompt).toContain('USER: That was a tough meeting.')
    expect(prompt).toContain('ASSISTANT: What made it tough?')
  })

  it('does not include greeting hint (suppressed by lastMessageAt)', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'America/New_York' },
      intent: 'Daily brief.',
    })

    // Greeting hint should be suppressed — prompted turns have explicit intent
    expect(prompt).not.toContain('fresh session')
    expect(prompt).not.toContain('resumed session')
  })

  it('defaults prompted turns to operational mode', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      intent: 'Run a silent operating turn.',
    })

    expect(prompt).toContain('Operational reality:')
    expect(prompt).toContain('ACTION RESPONSE CONTRACT')
    expect(prompt).not.toContain('Operational continuity:')
    expect(prompt).not.toContain('real person in front of you')
    expect(prompt).not.toContain('desktop side panel')
    expect(prompt).not.toContain('come back and think with me')
    expect(prompt).not.toContain('"followUps"')
    expect(prompt).not.toContain('Your client trusts your judgment')
    expect(prompt).not.toContain('fresh user message')
    expect(prompt).not.toContain('the user just sent')
    expect(prompt).not.toContain('confirm first')
    expect(prompt).not.toContain('fresh session')
    expect(prompt).not.toContain('App-initiated turn:')
    expect(prompt).toContain('Return exactly one raw JSON object and nothing else.')
    expect(prompt).toContain('Do not wrap the response in markdown code fences.')
  })

  it('emits a single canonical action contract block in prompted turns', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      intent: 'Run a silent operating turn.',
    })

    expect(prompt.match(/--- ACTION RESPONSE CONTRACT ---/g)?.length ?? 0).toBe(1)
    expect(prompt).toContain('valid action names:')
    expect(prompt).toContain('params may only contain keys declared in that action\'s params signature')
  })

  it('still supports explicit conversation mode for prompted turns', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC', promptMode: 'conversation' },
      intent: 'Send a warm reflection.',
    })

    expect(prompt).toContain('real person in front of you')
    expect(prompt).toContain('desktop side panel')
    expect(prompt).toContain('"followUps"')
    expect(prompt).toContain('come back and think with me')
    expect(prompt).not.toContain('Operational reality:')
  })

  it('uses conversational scaffold for proactive conversational prompted turns', () => {
    const prompt = buildPromptedTurnPrompt({
      config: coachConfig,
      input: { timezone: 'UTC' },
      turnKind: 'proactive-conversation',
      intent: 'Send a warm reflection.',
    })

    expect(prompt).toContain('real person in front of you')
    expect(prompt).toContain('desktop side panel')
    expect(prompt).toContain('"followUps"')
    expect(prompt).toContain('come back and think with me')
    expect(prompt).not.toContain('Operational reality:')
    expect(prompt).toContain('App-initiated turn:')
    expect(prompt).not.toContain('they\'re waiting for your response')
    expect(prompt).not.toContain('TRANSPORT CONTRACT:')
  })

  it('renders the voice block only once in conversation prompts', () => {
    const prompt = buildSystemPrompt({
      config: coachConfig,
      input: { message: 'hello there' },
    })

    expect(prompt.match(/desktop side panel/g)?.length ?? 0).toBe(1)
  })

  it('omits action sections when no actions and no entities configured', () => {
    const minimalConfig: PersonaConfig = {
      identity: { name: 'Bot', expertise: ['testing'], relationship: 'partner', northStar: 'quality' },
      voice: { tone: 'balanced', style: 'educator' },
      provider: mockProvider,
    }
    const prompt = buildPromptedTurnPrompt({
      config: minimalConfig,
      input: { timezone: 'UTC' },
      intent: 'Say hello.',
    })

    expect(prompt).not.toContain('AVAILABLE ACTIONS')
    expect(prompt).not.toContain('Outcome notes')
    // Output format is always present (part of buildSystemPrompt)
    expect(prompt).toContain('Output contract:')
  })

  it('includes memory entity rules when memory is enabled', () => {
    const configWithMemory: PersonaConfig = {
      ...coachConfig,
      memory: { enabled: true },
    }
    const prompt = buildPromptedTurnPrompt({
      config: configWithMemory,
      input: { timezone: 'UTC' },
      intent: 'Reflect on the conversation.',
    })

    expect(prompt).toContain("Memory is what you've learned about this person")
  })

  it('includes DIAGNOSTICS_CHANNEL when diagnostics enabled', () => {
    const configWithDiagnostics: PersonaConfig = {
      ...coachConfig,
      diagnostics: { enabled: true },
    }
    const prompt = buildPromptedTurnPrompt({
      config: configWithDiagnostics,
      input: { timezone: 'UTC' },
      intent: 'Coach the CEO.',
    })

    expect(prompt).toContain('Diagnostics channel')
  })
})
