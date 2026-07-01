/**
 * A/B evaluation: PA with deterministic context vs. PA with Relay curation.
 *
 * Same inbox data, same user messages, two paths:
 *   A) PA receives pre-formatted context (the old buildAssistantContext pattern)
 *   B) PA has Relay as a peer and only gets header context
 *
 * Requires GEMINI_API_KEY. Run with:
 *   npm run test:live -- tests/peer-ab-eval.test.ts
 */
import { describe, it, expect } from 'vitest'
import { definePersona, withStorage, Gemini } from '../src/index.js'
import type { StorageAdapter, Memory, Message, PersonaConfig } from '../src/types.js'
import { z } from 'zod'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) {
  console.warn('Skipping A/B eval — no GEMINI_API_KEY')
}

// ─── Shared infrastructure ──────────────────────────────────────────────────

function createAdapter(): StorageAdapter {
  const messages: (Message & { conversationId: string })[] = []
  const memories: Memory[] = []
  return {
    getActiveConversation: async () => null,
    createConversation: async () => `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    endConversation: async () => {},
    getMessages: async (convId, limit) =>
      messages.filter(m => m.conversationId === convId).slice(-limit)
        .map(m => ({ role: m.role, content: m.content, actionsJson: m.actionsJson, isNote: m.isNote, createdAt: m.createdAt })),
    saveMessage: async (convId, msg) => {
      messages.push({ ...msg, conversationId: convId, createdAt: new Date().toISOString() })
    },
    loadMemories: async () => [...memories],
    saveMemory: async (mem) => { const id = `m-${memories.length}`; memories.push({ ...mem, id }); return id },
    updateMemory: async () => {},
    deleteMemory: async () => {},
  }
}

const gemini = () => Gemini({ model: 'gemini-3.5-flash', apiKey: GEMINI_API_KEY })

const threadEntity = {
  schema: z.object({
    state: z.enum(['active', 'waiting', 'reference', 'suppressed', 'done']).optional(),
    summary: z.string().optional(),
  }),
  label: 'Thread',
}

// ─── Inbox scenarios ────────────────────────────────────────────────────────

interface Scenario {
  name: string
  /** The user's message */
  message: string
  /** Raw thread data (what Relay's contextBuilder provides) */
  rawInbox: string
  /** Pre-formatted context (what buildAssistantContext would produce — the old path) */
  formattedContext: string
  /** Header context (what the PA gets with Relay — just counts) */
  headerContext: string
  /** What we're looking for in a good response */
  qualityCriteria: string[]
}

const scenarios: Scenario[] = [
  {
    name: 'Morning triage — mixed urgency',
    message: 'What needs my attention today?',
    rawInbox: `[thread-001] Re: Q3 Budget Review
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
  billing@saasvendor.com: Your payment of $299.00 has been processed. Invoice attached.`,

    formattedContext: `HEADLINE: 5 threads need review
ACTIVE: 3
WAITING: 1
REFERENCE: 0
SUPPRESSED: 0
DONE: 0

THREADS:
- [thread-001] Re: Q3 Budget Review | state active | from Sarah Chen <sarah@company.com> | why Sarah asking to confirm Thursday 2pm for budget review | move confirm or propose alternative | received today
- [thread-002] API Migration Timeline | state active | from Mark Rodriguez <mark@company.com> | why Mark needs decision on API migration approach | move make the call | received yesterday
- [thread-003] Your Weekly Newsletter Digest | state active | from newsletters@techdigest.com | why Automated newsletter | move archive | received today
- [thread-004] Team Offsite Planning | state waiting | from Lisa Park <lisa@company.com> | why Offsite logistics, waiting on venue confirmation | move review when ready | received 3 days ago
- [thread-005] Invoice #4521 Payment Confirmation | state active | from billing@saasvendor.com | why Automated payment receipt | move archive | received today`,

    headerContext: '5 threads: 3 active, 1 waiting, 0 reference, 0 suppressed. 0 done.',
    qualityCriteria: [
      'Prioritizes Mark (deadline Wednesday) and Sarah (board meeting next week)',
      'Filters or deprioritizes newsletter and invoice',
      'Mentions Lisa\'s offsite as low-urgency / no rush',
      'Proposes clear next moves',
      'Reads as calm and organized, not as a data dump',
    ],
  },
  {
    name: 'Focused thread — needs draft',
    message: 'Draft a reply to Sarah confirming Thursday works.',
    rawInbox: `[thread-001] Re: Q3 Budget Review
  From: Sarah Chen <sarah@company.com> | State: active | Received: 2026-04-08T09:15:00Z
  Summary: Sarah asking to confirm Thursday 2pm for budget review
  Messages:
  Sarah Chen: Hi, can we lock in Thursday 2pm for the Q3 budget review? I've attached the draft numbers. Need your sign-off before the board meeting next week.`,

    formattedContext: `HEADLINE: Focused on Sarah's budget review thread
ACTIVE: 1

THREADS:
- [thread-001] Re: Q3 Budget Review | state active | from Sarah Chen <sarah@company.com> | why Confirming Thursday 2pm for budget review | move draft confirmation | received today

THREAD IN FOCUS
Thread ID: thread-001
Title: Re: Q3 Budget Review
Subject: Re: Q3 Budget Review
From: Sarah Chen <sarah@company.com>
State: active
Summary: Sarah asking to confirm Thursday 2pm for budget review
EMAIL CONTENT:
  From: Sarah Chen
  Hi, can we lock in Thursday 2pm for the Q3 budget review? I've attached the draft numbers. Need your sign-off before the board meeting next week.`,

    headerContext: '1 thread: 1 active.',
    qualityCriteria: [
      'Produces a draft reply (CRUD action with draft field)',
      'Draft is in the user\'s voice, not the PA\'s',
      'Confirms Thursday 2pm specifically',
      'Brief and natural — not over-formal',
    ],
  },
  {
    name: 'Noisy inbox — signal extraction',
    message: 'Anything urgent?',
    rawInbox: `[thread-010] URGENT: Server Down in Production
  From: alerts@monitoring.company.com | State: active | Received: 2026-04-08T11:45:00Z
  Summary: Production alert — API response times > 30s
  Messages:
  alerts@monitoring.company.com: ALERT: Production API response times have exceeded 30 seconds. P1 incident opened. On-call team has been paged.

[thread-011] Re: Your Amazon Order Has Shipped
  From: shipment-tracking@amazon.com | State: active | Received: 2026-04-08T10:00:00Z
  Summary: Package delivery notification
  Messages:
  shipment-tracking@amazon.com: Your order #402-1234567 has shipped and will arrive Tuesday.

[thread-012] Lunch tomorrow?
  From: Jamie Walsh <jamie@company.com> | State: active | Received: 2026-04-08T11:30:00Z
  Summary: Casual lunch invitation
  Messages:
  Jamie Walsh: Hey! Want to grab lunch tomorrow? That new ramen place opened up.

[thread-013] Board Presentation — Final Review
  From: CFO Diana Ross <diana@company.com> | State: active | Received: 2026-04-08T11:40:00Z
  Summary: CFO needs final review of board deck before 3pm today
  Messages:
  Diana Ross: I need your eyes on slides 12-15 before I send the deck to the board at 3pm today. Attaching the latest version.

[thread-014] Subscription Renewal Notice
  From: noreply@cloudservice.io | State: active | Received: 2026-04-08T09:00:00Z
  Summary: Annual renewal coming up
  Messages:
  noreply@cloudservice.io: Your annual subscription renews on April 15. Click here to review your plan.

[thread-015] Re: Client Demo Feedback
  From: Alex Kim <alex@client.com> | State: active | Received: 2026-04-08T08:30:00Z
  Summary: Client liked the demo, wants to move forward
  Messages:
  Alex Kim: Great demo yesterday! We'd like to move forward with the pilot. Can we schedule a kickoff call this week?`,

    formattedContext: `HEADLINE: 6 active threads
ACTIVE: 6

THREADS:
- [thread-010] URGENT: Server Down in Production | state active | from alerts@monitoring.company.com | why Production alert — API response times > 30s | move check status | received today
- [thread-011] Re: Your Amazon Order Has Shipped | state active | from shipment-tracking@amazon.com | why Package delivery notification | move archive | received today
- [thread-012] Lunch tomorrow? | state active | from Jamie Walsh <jamie@company.com> | why Casual lunch invitation | move reply when convenient | received today
- [thread-013] Board Presentation — Final Review | state active | from CFO Diana Ross <diana@company.com> | why CFO needs final review of board deck before 3pm today | move review urgently | received today
- [thread-014] Subscription Renewal Notice | state active | from noreply@cloudservice.io | why Annual renewal coming up | move archive or note | received today
- [thread-015] Re: Client Demo Feedback | state active | from Alex Kim <alex@client.com> | why Client liked the demo, wants to move forward | move schedule kickoff | received today`,

    headerContext: '6 threads: 6 active, 0 waiting.',
    qualityCriteria: [
      'Identifies the P1 server incident as #1 priority',
      'Surfaces Diana\'s board deck deadline (3pm today) as #2',
      'Mentions Alex\'s client momentum as important but not time-critical',
      'Filters Amazon shipping and subscription renewal as noise',
      'Handles Jamie\'s lunch casually — not urgent',
      'Clear urgency gradient, not a flat list',
    ],
  },
]

// ─── Path A: Deterministic context (old pattern) ────────────────────────────

function createPathA() {
  const config: PersonaConfig = {
    identity: {
      name: 'Orbit',
      expertise: ['executive assistance', 'communication triage', 'prioritization'],
      relationship: 'personal assistant and executive function partner',
      northStar: 'incoming communication that feels calm, filtered, and easy to act on',
      keystone: 'What is the single most useful way to help this person handle the incoming communication right now?',
    },
    voice: { tone: 'balanced', style: 'quick' },
    methodology: `Thread mentions use markdown links: [Name](/thread/ID).
The chat interface renders rich markdown.`,
    contextInputs: {
      inboxLandscape: { label: 'INBOX LANDSCAPE', format: 'block', priority: 'critical' },
      userPreferences: { label: 'USER PREFERENCES', format: 'block' },
    },
    entities: { thread: threadEntity },
    provider: gemini(),
  }
  return withStorage(definePersona(config), { adapter: createAdapter(), historyLimit: 10 })
}

// ─── Path B: PA + Relay (new pattern) ───────────────────────────────────────

function createRelay() {
  return withStorage(
    definePersona({
      identity: {
        name: 'Relay',
        expertise: ['information gathering', 'context curation', 'prioritization', 'signal detection'],
        relationship: 'efficient logistics partner',
        northStar: 'deliver exactly the context needed — filtered, prioritized, judgment-enriched',
        keystone: 'What is the most useful way to organize this so the PA can decide quickly?',
      },
      voice: { tone: 'direct', style: 'quick' },
      methodology: `You curate raw inbox data for a personal assistant.
Add signal: sender urgency patterns, thread staleness, contradictions, deadlines.
Remove noise: newsletters, automated receipts, shipping notifications, subscription renewals.
Format as structured context blocks with thread IDs preserved.
Prioritize by actual urgency, not just recency.`,
      contextInputs: {
        rawInbox: { label: 'RAW INBOX DATA', format: 'block', priority: 'critical' },
      },
      provider: gemini(),
    }),
    { adapter: createAdapter(), historyLimit: 10 },
  )
}

function createPathB(rawInbox: string) {
  const relay = createRelay()
  const config: PersonaConfig = {
    identity: {
      name: 'Orbit',
      expertise: ['executive assistance', 'communication triage', 'prioritization'],
      relationship: 'personal assistant and executive function partner',
      northStar: 'incoming communication that feels calm, filtered, and easy to act on',
      keystone: 'What is the single most useful way to help this person handle the incoming communication right now?',
    },
    voice: { tone: 'balanced', style: 'quick' },
    methodology: `You have a peer named Relay — a logistics partner with access to the raw inbox who curates it with signal and judgment. Your inbox overview gives you the shape of things; Relay can give you the detail.
Thread mentions use markdown links: [Name](/thread/ID).
The chat interface renders rich markdown.`,
    contextInputs: {
      headerContext: { label: 'INBOX OVERVIEW', format: 'block' },
      userPreferences: { label: 'USER PREFERENCES', format: 'block' },
    },
    entities: { thread: threadEntity },
    provider: gemini(),
  }
  return withStorage(definePersona(config), {
    adapter: createAdapter(),
    historyLimit: 10,
    peers: {
      relay: {
        persona: relay,
        expertise: 'inbox data curation, email triage, thread prioritization, signal detection',
        contextBuilder: async () => ({ rawInbox }),
      },
    },
  })
}

// ─── Judge ───────────────────────────────────────────────────────────────────

async function judge(scenario: Scenario, responseA: string, responseB: string): Promise<{
  winner: 'A' | 'B' | 'tie'
  reasoning: string
  scoresA: Record<string, number>
  scoresB: Record<string, number>
}> {
  const judgeProvider = gemini()
  const prompt = `You are evaluating two AI assistant responses to the same user request. Both assistants had access to the same inbox data, but through different mechanisms.

USER MESSAGE: "${scenario.message}"

QUALITY CRITERIA (what a great response should do):
${scenario.qualityCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

RESPONSE A (deterministic context):
${responseA}

RESPONSE B (AI-curated context):
${responseB}

Score each response 1-5 on each criterion. Then declare a winner.

Respond in JSON:
{
  "scoresA": { "criterion_1": N, "criterion_2": N, ... },
  "scoresB": { "criterion_1": N, "criterion_2": N, ... },
  "winner": "A" | "B" | "tie",
  "reasoning": "Brief explanation of the key difference"
}`

  const result = await judgeProvider.chat({
    systemPrompt: 'You are a rigorous evaluator of AI assistant quality. Be specific and fair.',
    history: [],
    message: prompt,
  })

  try {
    const cleaned = result.text.replace(/```json\n?|\n?```/g, '').trim()
    return JSON.parse(cleaned)
  } catch {
    return { winner: 'tie', reasoning: `Judge parse failed: ${result.text.slice(0, 200)}`, scoresA: {}, scoresB: {} }
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!GEMINI_API_KEY)('A/B eval: deterministic vs. Relay curation', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      console.log(`\n${'═'.repeat(60)}`)
      console.log(`SCENARIO: ${scenario.name}`)
      console.log(`USER: "${scenario.message}"`)
      console.log('═'.repeat(60))

      // ── Path A: deterministic context ──
      const pathA = createPathA()
      const resultA = await pathA.chat({
        message: scenario.message,
        personaId: 'orbit-A',
        context: {
          inboxLandscape: scenario.formattedContext,
          userPreferences: 'Reply style: concise and direct.',
        },
      })

      console.log('\n── PATH A (deterministic context) ──')
      console.log(resultA.message)
      console.log(`CRUD: ${resultA.crudActions?.map(c => `${c.operation} ${c.entity} ${c.id ?? ''}`).join(', ') || 'none'}`)

      // ── Path B: PA + Relay ──
      const pathB = createPathB(scenario.rawInbox)
      const resultB = await pathB.chat({
        message: scenario.message,
        personaId: 'orbit-B',
        context: {
          headerContext: scenario.headerContext,
          userPreferences: 'Reply style: concise and direct.',
        },
      })

      console.log('\n── PATH B (PA + Relay) ──')
      console.log(resultB.message)
      console.log(`CRUD: ${resultB.crudActions?.map(c => `${c.operation} ${c.entity} ${c.id ?? ''}`).join(', ') || 'none'}`)
      if (resultB.trace.peerConsultations?.length) {
        for (const pc of resultB.trace.peerConsultations) {
          console.log(`  → Relay (${pc.durationMs}ms): ${pc.response.slice(0, 150)}...`)
        }
      }

      // ── Judge ──
      const verdict = await judge(scenario, resultA.message, resultB.message)

      console.log(`\n── JUDGE VERDICT ──`)
      console.log(`Winner: ${verdict.winner}`)
      console.log(`Reasoning: ${verdict.reasoning}`)
      console.log(`Scores A: ${JSON.stringify(verdict.scoresA)}`)
      console.log(`Scores B: ${JSON.stringify(verdict.scoresB)}`)

      // We don't assert winner — this is an eval, not a pass/fail test.
      // But we log everything for human review.
      expect(resultA.message.length).toBeGreaterThan(20)
      expect(resultB.message.length).toBeGreaterThan(20)

      // Path B should have consulted Relay
      if (scenario.headerContext.includes('active')) {
        expect(resultB.trace.peerConsultations?.length).toBeGreaterThanOrEqual(1)
      }
    }, 120000)
  }
})
