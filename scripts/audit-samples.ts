/**
 * Audit every reference persona Archetype ships.
 *
 * Runs the unified audit against the 5 persona templates that back the
 * canonical examples. Findings here are public — they shape what every
 * new persona inherits by default, so these should run clean.
 *
 * Each template gets a representative context + memory payload so
 * entity-visibility audits against the prompt the template actually
 * produces in a realistic turn — not the empty-context worst case.
 *
 * Default debugging loop (see DEBUGGING_LOOP.md):
 *   1. auditPersona         — what's structurally wrong?
 *   2. dumpPromptForReview  — what is the LLM actually reading?
 *   3. auditTraceIntegrity  — is the pipeline silently dropping anything?
 */
import { auditPersona, printAuditReport } from '../src/index.js'
import {
  COACH_TEMPLATE,
  NUTRITION_TEMPLATE,
  FITNESS_TEMPLATE,
  LANGUAGE_TUTOR_TEMPLATE,
  CHIEF_OF_STAFF_TEMPLATE,
} from '../src/playbook/templates.js'
import type { Memory } from '../src/types.js'

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }

interface SampleCase {
  title: string
  template: typeof COACH_TEMPLATE
  context: Record<string, unknown>
  memories?: Memory[]
}

const samples: SampleCase[] = [
  {
    title: 'Coach template',
    template: COACH_TEMPLATE,
    context: {
      threads: [{ id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'Alex' }],
      forcingFunctions: [{ id: 'ff1', title: 'Ship Q3 roadmap', owner: 'Alex', due: '2026-05-01', status: 'open' }],
      coachingNotes: [{ id: 'cn1', type: 'growth_edge', text: 'Over-functioning on tactical work', execName: 'Alex' }],
      profile: { name: 'Jordan', role: 'CEO' },
    },
    memories: [{ id: 'm1', content: 'Prefers direct over softened framing', category: 'preference', pinned: true }],
  },
  {
    title: 'Nutrition template',
    template: NUTRITION_TEMPLATE,
    context: {
      todayStatus: { logged: 2, target: 5, lastMeal: 'Greek yogurt + berries' },
      recentDays: [{ date: '2026-04-21', summary: 'Hit protein target, missed water' }],
      meals: [{ id: 'meal1', name: 'Chicken bowl', calories: 520, protein: 38 }],
      profile: { name: 'Sam', goal: 'maintain' },
    },
    memories: [{ id: 'm1', content: 'Allergic to peanuts', category: 'durable', pinned: true }],
  },
  {
    title: 'Fitness template',
    template: FITNESS_TEMPLATE,
    context: {
      injuries: ['Right shoulder — mild impingement, avoid overhead pressing'],
      equipment: ['Barbell', 'Dumbbells', 'Pull-up bar'],
      recentWorkouts: [{ id: 'w1', focus: 'Upper Push', date: '2026-04-20', duration: '50 min' }],
      workouts: [{ id: 'w1', focus: 'Upper Push' }],
      exercises: [{ id: 'ex1', workoutId: 'w1', name: 'Bench press', sets: 4, reps: '6-8' }],
      profile: { name: 'Alex', experience: 'Intermediate' },
    },
    memories: [{ id: 'm1', content: 'Prefers compound movements', category: 'preference', pinned: true }],
  },
  {
    title: 'Language tutor template',
    template: LANGUAGE_TUTOR_TEMPLATE,
    context: {
      currentGoal: { language: 'Spanish', focus: 'conversational fluency' },
      recentMistakes: [{ id: 'mk1', pattern: 'ser vs estar', correction: 'use estar for temporary states' }],
      mistakes: [{ id: 'mk1', pattern: 'ser vs estar' }],
      practices: [{ id: 'p1', title: 'Daily conversation drill', focus: 'past tense' }],
      phrasebook: ['Me parece que...'],
      profile: { name: 'Jamie', level: 'B1' },
    },
    memories: [{ id: 'm1', content: 'Wants to sound native in casual conversation', category: 'goal', pinned: true }],
  },
  {
    title: 'Chief-of-staff template',
    template: CHIEF_OF_STAFF_TEMPLATE,
    context: {
      openTasks: [{ id: 'tk1', title: 'Review Q2 offsite agenda', owner: 'Alex', due: '2026-04-29', status: 'open' }],
      tasks: [{ id: 'tk1', title: 'Review Q2 offsite agenda' }],
      constraints: ['No meetings Tuesday afternoons'],
      profile: { name: 'Riley', role: 'Founder' },
    },
    memories: [{ id: 'm1', content: 'Protects deep-work blocks Mon/Wed morning', category: 'working_style', pinned: true }],
  },
]

async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  const scope = apiKey ? 'full' : 'static-plus-scenario'
  const totals = { pass: 0, fail: 0, errors: 0, warns: 0 }

  for (const s of samples) {
    const result = await auditPersona({
      config: { ...s.template, provider: mockProvider },
      context: s.context,
      memories: s.memories,
      apiKey,
      scope,
    })
    printAuditReport(result, { title: s.title })
    const errs = result.findings.filter(f => f.severity === 'error').length
    const warns = result.findings.filter(f => f.severity === 'warn').length
    totals.errors += errs
    totals.warns += warns
    if (result.pass) totals.pass += 1
    else totals.fail += 1
  }

  console.log('\n' + '═'.repeat(70))
  console.log(`OVERALL — ${totals.pass} pass, ${totals.fail} fail, ${totals.errors} errors, ${totals.warns} warns across ${samples.length} reference personas`)
  console.log('═'.repeat(70))
  process.exit(totals.fail > 0 ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
