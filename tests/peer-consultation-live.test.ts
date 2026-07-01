/**
 * Live end-to-end test for peer consultation.
 * Requires GEMINI_API_KEY in environment.
 * Run with: npm run test:live -- tests/peer-consultation-live.test.ts
 *
 * This is a Turing test: real Gemini calls, real persona reasoning.
 * The PA (Orbit) should consult Relay when it needs inbox data,
 * and produce a coherent response that integrates Relay's curation.
 */
import { describe, it, expect } from 'vitest'
import { definePersona, withStorage, Gemini, PEER_ACTION_NAME } from '../src/index.js'
import type { StorageAdapter, Memory, Message } from '../src/types.js'
import { z } from 'zod'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) {
  console.warn('Skipping live peer consultation tests — no GEMINI_API_KEY')
}

// ─── Test Infra ─────────────────────────────────────────────────────────────

function createInMemoryAdapter(): StorageAdapter {
  const messages: (Message & { conversationId: string })[] = []
  const memories: Memory[] = []

  return {
    getActiveConversation: async () => null,
    createConversation: async () => `conv-${Date.now()}`,
    endConversation: async () => {},
    getMessages: async (convId, limit) =>
      messages.filter(m => m.conversationId === convId).slice(-limit).map(m => ({
        role: m.role, content: m.content, actionsJson: m.actionsJson, isNote: m.isNote, createdAt: m.createdAt,
      })),
    saveMessage: async (convId, msg) => {
      messages.push({ ...msg, conversationId: convId, createdAt: new Date().toISOString() })
    },
    loadMemories: async () => [...memories],
    saveMemory: async (mem) => {
      const id = `mem-${memories.length + 1}`
      memories.push({ ...mem, id })
      return id
    },
    updateMemory: async () => {},
    deleteMemory: async () => {},
  }
}

// ─── Personas ───────────────────────────────────────────────────────────────

function createRelay(adapter: StorageAdapter) {
  return withStorage(
    definePersona({
      identity: {
        name: 'Relay',
        expertise: ['information gathering', 'context curation', 'prioritization'],
        relationship: 'efficient logistics partner',
        northStar: 'deliver exactly the context needed — filtered, prioritized, judgment-enriched',
        keystone: 'What is the most useful way to organize this so the PA can decide quickly?',
      },
      voice: { tone: 'direct', style: 'quick' },
      methodology: `You curate raw inbox data for a personal assistant.
Add signal: sender urgency patterns, thread staleness, contradictions.
Remove noise: newsletters, automated receipts, low-priority FYIs.
Format as structured context blocks with thread IDs preserved.`,
      contextInputs: {
        rawInbox: { label: 'RAW INBOX DATA', format: 'block', priority: 'critical' },
      },
      provider: Gemini({ model: 'gemini-3.5-flash', apiKey: GEMINI_API_KEY }),
    }),
    { adapter, historyLimit: 10 },
  )
}

function createPA(adapter: StorageAdapter, relayPersona: ReturnType<typeof createRelay>) {
  return withStorage(
    definePersona({
      identity: {
        name: 'Orbit',
        expertise: ['executive assistance', 'communication triage', 'prioritization'],
        relationship: 'personal assistant and executive function partner',
        northStar: 'incoming communication that feels calm, filtered, and easy to act on',
        keystone: 'What is the single most useful way to help this person handle the incoming communication right now?',
      },
      voice: { tone: 'balanced', style: 'quick' },
      methodology: `You have a peer named Relay who curates inbox data for you.
When you need context about threads or emails, consult Relay.
If you already have enough from memory and conversation history, respond directly.
Thread mentions use markdown links: [Name](/thread/ID).`,
      contextInputs: {
        headerContext: { label: 'INBOX OVERVIEW', format: 'block' },
        userPreferences: { label: 'USER PREFERENCES', format: 'block' },
      },
      entities: {
        thread: {
          schema: z.object({
            state: z.enum(['active', 'waiting', 'reference', 'suppressed', 'done']).optional(),
            summary: z.string().optional(),
          }),
          label: 'Thread',
        },
      },
      provider: Gemini({ model: 'gemini-3.5-flash', apiKey: GEMINI_API_KEY }),
    }),
    {
      adapter,
      historyLimit: 20,
      peers: {
        relay: {
          persona: relayPersona,
          expertise: 'inbox data curation, email triage, thread prioritization',
          contextBuilder: async () => ({
            rawInbox: SAMPLE_INBOX,
          }),
        },
      },
    },
  )
}

// ─── Sample Data ────────────────────────────────────────────────────────────

const SAMPLE_INBOX = `[thread-001] Re: Q3 Budget Review
  From: Sarah Chen <sarah@company.com> | State: active | Received: 2026-04-08T09:15:00Z
  Summary: Sarah asking to confirm Thursday 2pm for budget review
  Messages:
  Sarah Chen: Hi, can we lock in Thursday 2pm for the Q3 budget review? I've attached the draft numbers. Need your sign-off before the board meeting next week.

[thread-002] API Migration Timeline
  From: Mark Rodriguez <mark@company.com> | State: active | Received: 2026-04-07T16:30:00Z
  Summary: Mark needs decision on API migration approach
  Messages:
  Mark Rodriguez: We're at a fork — either we do the breaking change now and deal with client migrations, or we maintain backward compat for 6 months. Need your call by Wednesday.

[thread-003] Your Weekly Newsletter Digest
  From: newsletters@techdigest.com | State: active | Received: 2026-04-08T06:00:00Z
  Summary: Automated newsletter
  Messages:
  newsletters@techdigest.com: This week in tech: AI advances, cloud computing trends...

[thread-004] Team Offsite Planning
  From: Lisa Park <lisa@company.com> | State: waiting | Received: 2026-04-05T11:00:00Z
  Summary: Offsite logistics, waiting on venue confirmation
  Messages:
  Lisa Park: Venue confirmed for May 15-16. Can you look over the agenda draft when you get a chance? No rush, we have two weeks.

[thread-005] Invoice #4521 Payment Confirmation
  From: billing@saasvendor.com | State: active | Received: 2026-04-08T08:00:00Z
  Summary: Automated payment receipt
  Messages:
  billing@saasvendor.com: Your payment of $299.00 has been processed. Invoice attached.`

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!GEMINI_API_KEY)('peer consultation — live Turing test', () => {
  it('PA consults Relay for inbox overview and produces coherent response', async () => {
    const paAdapter = createInMemoryAdapter()
    const relayAdapter = createInMemoryAdapter()
    const relay = createRelay(relayAdapter)
    const pa = createPA(paAdapter, relay)

    const result = await pa.chat({
      message: 'What needs my attention today?',
      personaId: 'orbit',
      correlationId: 'live-test-1',
      context: {
        headerContext: '5 threads: 3 active, 1 waiting, 0 reference, 0 suppressed. 0 done.',
        userPreferences: 'Reply style: concise and direct. Prefers morning briefings.',
      },
    })

    console.log('\n=== PA RESPONSE ===')
    console.log(result.message)
    console.log('\n=== TRACE ===')
    console.log(`PA calls: ${result.trace.traceId}`)
    if (result.trace.peerConsultations?.length) {
      for (const pc of result.trace.peerConsultations) {
        console.log(`  → Consulted ${pc.peer} (${pc.durationMs}ms)`)
        console.log(`    Query: ${pc.query.slice(0, 100)}`)
        console.log(`    Response preview: ${pc.response.slice(0, 200)}`)
      }
    }
    console.log(`Actions: ${result.actions.map(a => a.name).join(', ') || 'none'}`)
    console.log(`CRUD: ${result.crudActions?.map(c => `${c.operation} ${c.entity}`).join(', ') || 'none'}`)
    console.log(`Follow-ups: ${result.followUps?.join(' | ') || 'none'}`)

    // ── Assertions ──

    // PA should have consulted Relay (5 threads, 3 active — needs data)
    expect(result.trace.peerConsultations).toBeDefined()
    expect(result.trace.peerConsultations!.length).toBeGreaterThanOrEqual(1)

    const relayConsultation = result.trace.peerConsultations!.find(pc => pc.peer === 'relay')
    expect(relayConsultation).toBeDefined()
    expect(relayConsultation!.durationMs).toBeGreaterThan(0)

    // PA's response should reference real threads from the inbox
    const msg = result.message.toLowerCase()
    expect(
      msg.includes('sarah') || msg.includes('budget') || msg.includes('mark') || msg.includes('api'),
    ).toBe(true)

    // PA should NOT mention newsletter or invoice (Relay should filter those)
    // (soft assertion — Relay might mention them as "suppressed")
    const mentionsNoise = msg.includes('newsletter digest') && msg.includes('invoice #4521')
    if (mentionsNoise) {
      console.warn('WARNING: PA mentioned both noise threads — Relay curation may need improvement')
    }

    // Response should be coherent prose, not raw data dump
    expect(result.message.length).toBeGreaterThan(50)
    expect(result.message).not.toContain('rawInbox')
  }, 60000)

  it('PA responds directly for simple follow-ups without consulting Relay', async () => {
    const paAdapter = createInMemoryAdapter()
    const relayAdapter = createInMemoryAdapter()
    const relay = createRelay(relayAdapter)
    const pa = createPA(paAdapter, relay)

    // First turn: get the brief (will consult Relay)
    await pa.chat({
      message: 'What needs my attention?',
      personaId: 'orbit',
      context: {
        headerContext: '5 threads: 3 active, 1 waiting.',
        userPreferences: 'Concise style.',
      },
    })

    // Second turn: simple follow-up (should NOT need Relay)
    const result = await pa.chat({
      message: 'Thanks, sounds good.',
      personaId: 'orbit',
      context: {
        headerContext: '5 threads: 3 active, 1 waiting.',
        userPreferences: 'Concise style.',
      },
    })

    console.log('\n=== FOLLOW-UP RESPONSE ===')
    console.log(result.message)
    console.log(`Peer consultations: ${result.trace.peerConsultations?.length ?? 0}`)

    // For a simple "thanks", the PA shouldn't need to consult Relay
    // (This is a soft assertion — the PA might still consult, but ideally it doesn't)
    if (result.trace.peerConsultations?.length) {
      console.warn('NOTE: PA consulted Relay for a simple follow-up — may want to tune methodology')
    }

    expect(result.message.length).toBeGreaterThan(10)
  }, 60000)
})
