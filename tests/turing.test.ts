import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Gemini } from '../src/providers/gemini.js'
import { auditOperationalPromptContract, definePersona } from '../src/index.js'
import {
  judgeEvalConversation,
  judgeEvalTurn,
  judgePairwiseConversations,
} from '../src/evals/judge.js'
import { runEvalConversation } from '../src/evals/runtime.js'
import {
  chiefOfStaffProject,
  coachProject,
  fitnessProject,
  languageTutorProject,
  nutritionProject,
  savorProject,
} from '../src/evals/sample-projects.js'
import type { EvalJudgeScenario, EvalProject, EvalState, EvalTurnResult } from '../src/evals/types.js'

const API_KEY = process.env.GEMINI_API_KEY ?? ''

interface LiveScenario<State extends EvalState> {
  project: EvalProject<State>
  scenario: EvalJudgeScenario
  turns: Array<{ userMessage: string }>
  assert(result: Awaited<ReturnType<typeof runEvalConversation<State>>>): void
}

const scenarios: LiveScenario<any>[] = [
  {
    project: coachProject,
    scenario: {
      name: 'Recurring VP avoidance',
      description: 'The coach should stay conversational before moving into a sharper pattern call.',
      tests: ['default-off behavior', 'pattern naming', 'human voice'],
      expectedBehavior: [
        'Avoid premature tactical prescriptions on the first turn.',
        'By the second turn, name the deeper pattern if the signal is recurring.',
      ],
    },
    turns: [
      { userMessage: 'I had the same roadmap conversation with my VP again and nothing moved.' },
      { userMessage: 'This is the third time. What am I missing?' },
    ],
    assert(result) {
      // This is a low-action coaching surface: turn 1 should stay conversational,
      // and by turn 2 the recurring pattern should be captured durably somewhere
      // in the state, not necessarily as a visible action in the transcript.
      expect(result.turns[0].actions).toHaveLength(0)
      const capturedDurably = result.finalState.coachingNotes.length > 0 || result.finalState.memories.length > 1
      expect(capturedDurably).toBe(true)
    },
  },
  {
    project: nutritionProject,
    scenario: {
      name: 'Log then correct breakfast',
      description: 'The guide should log a meal quietly, then update rather than duplicate it.',
      tests: ['invisible operations', 'update vs duplicate', 'warmth'],
      expectedBehavior: [
        'Quietly log the first meal.',
        'When corrected, update the existing meal rather than logging a second breakfast.',
      ],
    },
    turns: [
      { userMessage: 'I had Greek yogurt with berries for breakfast.' },
      { userMessage: 'Actually add granola too.' },
    ],
    assert(result) {
      expect(result.finalState.meals.length).toBe(1)
    },
  },
  {
    project: fitnessProject,
    scenario: {
      name: 'Shoulder-friendly push session',
      description: 'The coach should generate a concrete workout without feeling like a machine.',
      tests: ['structured output', 'human coaching tone', 'constraint handling'],
      expectedBehavior: [
        'Respect the shoulder constraint.',
        'Create a session that still feels like real training.',
      ],
    },
    turns: [
      { userMessage: 'Give me a push workout that will not piss off my left shoulder.' },
    ],
    assert(result) {
      expect(result.finalState.generatedWorkouts.length).toBe(1)
    },
  },
  {
    project: languageTutorProject,
    scenario: {
      name: 'Travel-focused phrasing help',
      description: 'The tutor should sound natural, correct wisely, and capture durable learner preferences.',
      tests: ['natural language', 'memory capture', 'practice design'],
      expectedBehavior: [
        'Give natural phrasing rather than textbook stiffness.',
        'Capture a durable correction preference if the user states one clearly.',
      ],
    },
    turns: [
      { userMessage: 'Correct me immediately, not politely. How do I say "I want to book a table for two" in Spain-level natural Spanish?' },
    ],
    assert(result) {
      expect(result.finalState.memories.length + result.finalState.practiceQueue.length).toBeGreaterThan(0)
    },
  },
  {
    project: {
      ...chiefOfStaffProject,
      initialState() {
        const base = chiefOfStaffProject.initialState()
        return {
          ...base,
          openTasks: [
            ...base.openTasks,
            {
              id: 'task-stale',
              title: 'Old investor update draft',
              owner: 'Alex',
              due: '2026-03-18',
              priority: 'medium',
              status: 'open',
              notes: 'Superseded draft from last week.',
            },
          ],
        }
      },
    },
    scenario: {
      name: 'Task capture and cleanup',
      description: 'The chief of staff should reduce load, quietly manage tasks, and keep the system clean when a stale duplicate really exists.',
      tests: ['CRUD invisibility', 'operational crispness', 'memory of working style'],
      expectedBehavior: [
        'Capture a clean task from an explicit request.',
        'Prefer updating or deleting stale tasks rather than duplicating them.',
      ],
    },
    turns: [
      { userMessage: 'Remind me to send the investor update Friday and keep it blunt.' },
      { userMessage: 'Actually make that Thursday and delete the older draft task.' },
    ],
    assert(result) {
      expect(result.finalState.openTasks.length).toBeLessThanOrEqual(1)
    },
  },
  {
    project: chiefOfStaffProject,
    scenario: {
      name: 'Triage without creating busywork',
      description: 'The chief of staff should help prioritize without manufacturing more task overhead when the user wants clarity, not capture.',
      tests: ['scenario dominance', 'default-off actions', 'non-bureaucratic sharpness'],
      expectedBehavior: [
        'Stay operationally crisp without sounding like workflow software.',
        'Avoid creating a new task when the user explicitly wants prioritization rather than more tracking.',
      ],
    },
    turns: [
      { userMessage: 'I am overloaded. Do not make me another task list. Given what is already on my plate, what actually matters this week?' },
    ],
    assert(result) {
      expect(result.turns[0].actions.map(action => action.name)).not.toContain('createTask')
    },
  },
  // ─── Savor: production nutrition coach failures ────────────────────────────
  {
    project: savorProject,
    scenario: {
      name: 'Breakfast from established routine',
      description: 'The user eats the same breakfast every day (visible in recent days + memories). The nutritionist should build from what it knows about this person, not suggest generic alternatives.',
      tests: ['data grounding', 'specificity', 'expert initiative', 'human voice'],
      expectedBehavior: [
        'Reference or build on the established breakfast routine visible in recent days.',
        'Not suggest a completely different breakfast when the existing one already hits targets.',
        'Sound like a nutritionist who has been coaching this client for months, not one meeting them for the first time.',
      ],
    },
    turns: [
      { userMessage: 'Morning. What should I have for breakfast?' },
      { userMessage: 'I don\'t have spinach but I have broccoli. Also switch to low-fat cottage cheese.' },
    ],
    assert(result) {
      // By turn 2, the nutritionist should have a grounded recommendation with a meal CRUD action.
      const allCrud = result.turns.flatMap(t => t.sideEffectResults?.filter(r => r.action?.name === 'crud') ?? [])
      const hasMealCrud = allCrud.length > 0 || result.finalState.meals.length > 0
      expect(hasMealCrud).toBe(true)
    },
  },
  {
    project: savorProject,
    scenario: {
      name: 'Domain expertise without encyclopedia',
      description: 'User asks a nutrition/longevity question. The nutritionist should give a sharp, specific answer grounded in the user\'s actual data — not a lecture about biochemistry.',
      tests: ['specificity', 'human voice', 'data grounding', 'judgment'],
      expectedBehavior: [
        'Answer should reference what the user actually ate (from recent days context), not generic nutrition science.',
        'Should NOT read like a Wikipedia article about sulforaphane, Nrf2 pathways, or Blue Zones.',
        'Should be concise and actionable, not encyclopedic.',
      ],
    },
    turns: [
      { userMessage: 'Look at my recent days. Am I eating well for longevity, or is something missing?' },
    ],
    assert(result) {
      const msg = result.turns[0].assistantMessage.toLowerCase()
      // A grounded response should reference specific foods from the user's actual data.
      // An encyclopedic one would be full of biochemistry jargon without specificity.
      // We check it's not excessively long (encyclopedia signal) — a grounded expert is concise.
      expect(msg.length).toBeLessThan(2500)
    },
  },
]

function buildTranscript(turns: EvalTurnResult[]): string {
  return turns.flatMap(turn => [
    `USER: ${turn.userMessage}`,
    `ASSISTANT: ${turn.assistantMessage}`,
  ]).join('\n')
}

function makeBaselineProject<State extends EvalState>(project: EvalProject<State>): EvalProject<State> {
  return {
    ...project,
    id: `${project.id}-baseline`,
    name: `${project.name} Baseline`,
    description: `${project.description} Baseline variant.`,
    persona: {
      identity: {
        name: project.persona.identity.name,
        expertise: [project.persona.identity.expertise[0] ?? 'general expertise'],
        relationship: 'helpful assistant',
        northStar: project.persona.identity.northStar,
      },
      voice: {
        tone: 'balanced',
        style: 'quick',
        medium: project.persona.voice.medium,
      },
      actions: project.persona.actions,
      contextInputs: project.persona.contextInputs,
    },
  }
}

function printVerdict(projectName: string, scenario: EvalJudgeScenario, verdict: Awaited<ReturnType<typeof judgeEvalTurn>>) {
  const divider = '═'.repeat(72)
  console.log(`\n${divider}`)
  console.log(`TURING EVAL: ${projectName} — ${scenario.name}`)
  console.log(divider)
  console.log(`Average: ${verdict.average} | Pass: ${verdict.pass ? 'yes' : 'no'}`)
  for (const score of verdict.scores) {
    console.log(`- ${score.criterion}: ${score.score}/2 — ${score.reasoning}`)
  }
  if (verdict.promptFixes.length > 0) {
    console.log('Prompt fixes:')
    for (const fix of verdict.promptFixes) console.log(`  - ${fix}`)
  }
  if (verdict.sdkGaps.length > 0) {
    console.log('SDK gaps:')
    for (const gap of verdict.sdkGaps) console.log(`  - ${gap}`)
  }
  if (verdict.conceptGaps.length > 0) {
    console.log('Concept gaps:')
    for (const gap of verdict.conceptGaps) console.log(`  - ${gap}`)
  }
}

describe.skipIf(!API_KEY)('sample persona turing evals', () => {
  const TIMEOUT_MS = 360_000

  for (const entry of scenarios) {
    it(entry.scenario.name, async () => {
      const provider = Gemini({
        apiKey: API_KEY,
        model: 'gemini-3.5-flash',
        temperature: 0.7,
      })

      const conversation = await runEvalConversation(entry.project, provider, entry.turns)
      const baselineConversation = await runEvalConversation(makeBaselineProject(entry.project), provider, entry.turns)

      // First line of defense: trace must be clean — no unknown actions, no
      // validation failures. Silent pipeline drops are schema/documentation gaps.
      for (const turn of conversation.turns) {
        const t = turn.trace
        const unknown = t.actions.filter(a => a.status === 'unknown_action')
        const invalid = t.actions.filter(a => a.status === 'invalid')
        const crudInvalid = t.crudActions.filter(c => c.status === 'invalid')

        for (const a of unknown) console.error(`TRACE: unknown action "${a.name}"`, JSON.stringify(a.params))
        for (const a of invalid) console.error(`TRACE: invalid action "${a.name}" — ${a.error}`)
        for (const c of crudInvalid) console.error(`TRACE: invalid CRUD ${c.operation} ${c.entity} — ${c.error}`)

        expect(unknown, `AI tried unknown action(s): ${unknown.map(a => a.name).join(', ')}`).toHaveLength(0)
        expect(invalid, `AI sent invalid params for: ${invalid.map(a => a.name).join(', ')}`).toHaveLength(0)
        expect(crudInvalid, `AI sent invalid CRUD: ${crudInvalid.map(c => `${c.operation} ${c.entity}`).join(', ')}`).toHaveLength(0)
      }

      entry.assert(conversation)

      const transcript = buildTranscript(conversation.turns)
      const turnVerdict = await judgeEvalTurn(
        API_KEY,
        entry.project.name,
        entry.project.failureSurface,
        entry.scenario,
        transcript,
        conversation.turns[conversation.turns.length - 1],
      )
      const conversationVerdict = await judgeEvalConversation(
        API_KEY,
        entry.project.name,
        entry.project.failureSurface,
        entry.scenario,
        transcript,
        conversation.turns[0]?.stateBefore ?? '(unknown)',
        conversation.turns[conversation.turns.length - 1]?.stateAfter ?? '(unknown)',
      )
      const pairwiseVerdict = await judgePairwiseConversations(
        API_KEY,
        entry.scenario,
        {
          label: entry.project.name,
          transcript,
          stateAfter: conversation.turns[conversation.turns.length - 1]?.stateAfter ?? '(unknown)',
        },
        {
          label: baselineConversation.project.name,
          transcript: buildTranscript(baselineConversation.turns),
          stateAfter: baselineConversation.turns[baselineConversation.turns.length - 1]?.stateAfter ?? '(unknown)',
        },
      )

      printVerdict(entry.project.name, entry.scenario, turnVerdict)
      printVerdict(`${entry.project.name} (conversation)`, entry.scenario, conversationVerdict)
      console.log(`Pairwise winner: ${pairwiseVerdict.winner}`)
      console.log(`Pairwise reasoning: ${pairwiseVerdict.reasoning}`)
      if (pairwiseVerdict.sdkGaps.length > 0) {
        console.log('Pairwise SDK gaps:')
        for (const gap of pairwiseVerdict.sdkGaps) console.log(`  - ${gap}`)
      }
      if (pairwiseVerdict.conceptGaps.length > 0) {
        console.log('Pairwise concept gaps:')
        for (const gap of pairwiseVerdict.conceptGaps) console.log(`  - ${gap}`)
      }

      expect(turnVerdict.scores).toHaveLength(8)
      expect(conversationVerdict.scores).toHaveLength(8)
      expect(turnVerdict.average).toBeGreaterThanOrEqual(1.0)
      expect(conversationVerdict.average).toBeGreaterThanOrEqual(1.0)
      expect(pairwiseVerdict.winner).not.toBe('b')
    }, TIMEOUT_MS)
  }
})

describe.skipIf(!API_KEY)('operational turn regressions', () => {
  const TIMEOUT_MS = 360_000

  it('keeps a clean operational contract in a live app-initiated turn', async () => {
    const baseProvider = Gemini({
      apiKey: API_KEY,
      model: 'gemini-3.5-flash',
      temperature: 0.2,
    })
    let lastRequest: { systemPrompt: string; message: string } | null = null
    const provider = {
      name: baseProvider.name,
      async chat(request: { systemPrompt: string; message: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; responseSchema?: Record<string, unknown>; temperature?: number }) {
        lastRequest = { systemPrompt: request.systemPrompt, message: request.message }
        return baseProvider.chat(request)
      },
    }

    const persona = definePersona({
      identity: {
        name: 'Institution Operator',
        expertise: ['operations'],
        relationship: 'operating partner',
        northStar: 'keep the institution moving honestly',
      },
      voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
      actions: {
        sendInternalMemo: {
          description: 'Send a memo to a role in the directory.',
          confidence: 'low',
          schema: z.object({
            toRoleId: z.string(),
            subject: z.string(),
            body: z.string(),
          }),
        },
        sendExternalMessage: {
          description: 'Reply on an owned external thread.',
          confidence: 'low',
          schema: z.object({
            threadId: z.string(),
            body: z.string(),
            nextStatus: z.enum(['waiting-on-counterparty', 'scheduled', 'closed']),
          }),
        },
      },
      contextInputs: {
        roleDirectory: { label: 'ROLE DIRECTORY', format: 'list' },
        externalThreads: { label: 'EXTERNAL THREADS', format: 'list' },
        artifacts: { label: 'ARTIFACTS', format: 'list' },
      },
      provider,
    })

    const result = await persona.promptedTurn({
      intent: 'Operate from your seat. Move the waiting thread and escalate only if needed.',
      context: {
        roleDirectory: [
          { roleId: 'role-ceo-1', title: 'CEO', authority: ['review'] },
          { roleId: 'role-biz-1', title: 'Business Development Lead', authority: ['sendExternalMessage'] },
        ],
        externalThreads: [
          'threadId: thread-123 | counterparty: North Clinic | status: waiting-on-company | validNextStatus: waiting-on-counterparty | scheduled | closed',
        ],
        artifacts: [
          'artifactId: artifact-enterprise-brief | kind: brief | title: Enterprise Brief',
        ],
      },
    })

    const request = lastRequest
    expect(request).toBeTruthy()

    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: request?.systemPrompt ?? '',
        message: request?.message ?? '',
      },
      trace: result.trace,
      expectedMode: 'operational',
      ids: [{ label: 'thread ids', tokens: ['thread-123'] }],
      enums: [{ label: 'thread status transitions', tokens: ['waiting-on-counterparty', 'scheduled', 'closed'] }],
      recipients: [{ label: 'role directory', tokens: ['role-ceo-1', 'role-biz-1'] }],
    })

    if (!audit.pass) {
      console.log('Operational prompt audit issues:')
      for (const issue of audit.issues) console.log(`- [${issue.severity}] ${issue.message}`)
    }

    expect(audit.pass).toBe(true)
    expect(result.trace.actions.some(action => action.status === 'unknown_action')).toBe(false)
    expect(result.trace.parseOk).toBe(true)
    expect(result.trace.repairAttempted).toBe(false)
  }, TIMEOUT_MS)
})

describe.skipIf(!API_KEY)('proactive turn regressions', () => {
  const TIMEOUT_MS = 360_000

  it('keeps a clean proactive conversational nudge in a live app-initiated turn', async () => {
    const provider = Gemini({
      apiKey: API_KEY,
      model: 'gemini-3.5-flash',
      temperature: 0.7,
    })

    const current = definePersona({
      identity: {
        name: 'Coach',
        expertise: ['executive coaching', 'organizational behavior', 'strategic thinking'],
        relationship: 'trusted thinking partner',
        northStar: "the CEO's growth and the company's forward momentum",
      },
      voice: { tone: 'balanced', style: 'educator', medium: 'desktop-panel' },
      methodology: 'Threads are live company challenges. Progress means sharper ownership, clearer decisions, and real movement.',
      directives: {
        default: 'Speak like a sharp executive coach who can also move shared state cleanly when the work calls for it.',
        editable: true,
      },
      eq: {
        frequencyRule: true,
        autonomyRespect: true,
        qualitativeFirst: true,
        coherence: true,
        expertJudgment: true,
      },
      contextInputs: {
        page: { label: 'CURRENT PAGE CONTEXT' },
        teamDir: { label: 'TEAM DIRECTORY' },
      },
      provider,
    })

    const baseline = definePersona({
      identity: {
        name: 'Coach',
        expertise: ['executive coaching'],
        relationship: 'helpful assistant',
        northStar: "the CEO's growth and the company's forward momentum",
      },
      voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
      contextInputs: {
        page: { label: 'CURRENT PAGE CONTEXT' },
        teamDir: { label: 'TEAM DIRECTORY' },
      },
      provider,
    })

    const input = {
      intent: 'Offer one concise coaching observation before the CEO opens the roadmap review.',
      label: 'pre_accept reflection',
      turnKind: 'proactive-conversation' as const,
      context: {
        page: 'Review screen. Proposed thread: VP Eng roadmap stalling (thread_vp_eng). Proposed decision: choose a single roadmap owner.',
        teamDir: '- Sarah: VP Engineering\n- Maya: Chief of Staff',
      },
      timezone: 'America/Los_Angeles',
      promptNow: '2026-04-10T23:20:00-07:00',
      userIdentity: 'Alex, CEO',
      directives: 'Push for precision over reassurance.',
    }

    const result = await current.promptedTurn(input)
    const baselineResult = await baseline.promptedTurn(input)

    expect(result.trace.parseOk).toBe(true)
    expect(result.trace.repairAttempted).toBe(false)
    expect(result.trace.actions.filter(action => action.status === 'unknown_action')).toHaveLength(0)
    expect(result.trace.actions.filter(action => action.status === 'invalid')).toHaveLength(0)
    expect(result.trace.crudActions.filter(action => action.status === 'invalid')).toHaveLength(0)

    const scenario: EvalJudgeScenario = {
      name: 'Pre-review coaching nudge',
      description: 'A proactive coaching turn should feel like a timely nudge grounded in the live context, not a fake reply or dashboard narration.',
      tests: ['proactive continuity', 'human voice', 'specificity', 'non-admin language'],
      expectedBehavior: [
        'Sound like a well-timed coaching observation, not a reply to a fresh user message.',
        'Ground the nudge in the live context without narrating the app or runtime.',
      ],
    }

    const transcript = [
      'APP-INITIATED TURN',
      `INTENT: ${input.intent}`,
      `CONTEXT: ${input.context.page}`,
      `ASSISTANT: ${result.message}`,
    ].join('\n')
    const baselineTranscript = [
      'APP-INITIATED TURN',
      `INTENT: ${input.intent}`,
      `CONTEXT: ${input.context.page}`,
      `ASSISTANT: ${baselineResult.message}`,
    ].join('\n')

    const verdict = await judgeEvalConversation(
      API_KEY,
      'Executive Coach',
      'Should feel like a timely, human coaching nudge rather than a fake reply or dashboard narration.',
      scenario,
      transcript,
      '(no structured state before)',
      '(no structured state after)',
    )
    const pairwiseVerdict = await judgePairwiseConversations(
      API_KEY,
      scenario,
      {
        label: 'Archetype proactive coach',
        transcript,
        stateAfter: '(no structured state after)',
      },
      {
        label: 'Baseline proactive coach',
        transcript: baselineTranscript,
        stateAfter: '(no structured state after)',
      },
    )

    printVerdict('Executive Coach proactive', scenario, verdict)
    console.log(`Pairwise winner: ${pairwiseVerdict.winner}`)
    console.log(`Pairwise reasoning: ${pairwiseVerdict.reasoning}`)

    expect(verdict.average).toBeGreaterThanOrEqual(1.0)
    expect(pairwiseVerdict.winner).not.toBe('b')
  }, TIMEOUT_MS)
})
