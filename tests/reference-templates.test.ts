/**
 * Reference templates eat their own dog food.
 *
 * Every persona template Archetype ships is what new users spread into
 * their config. If a template regresses on the audit, new users silently
 * inherit the regression.
 *
 * All 5 reference templates pass auditPersona cleanly against a
 * representative context payload. Any new finding — error OR warn —
 * fails CI. If you add a finding and it's intentional (a domain-
 * specific trade-off), fix the template prose/schema or update the
 * representative payload here, don't relax the assertion.
 *
 * Run locally: `npm run audit:samples`
 */
import { describe, it, expect } from 'vitest'
import { auditPersona } from '../src/audit/audit-persona.js'
import {
  COACH_TEMPLATE,
  NUTRITION_TEMPLATE,
  FITNESS_TEMPLATE,
  LANGUAGE_TUTOR_TEMPLATE,
  CHIEF_OF_STAFF_TEMPLATE,
} from '../src/playbook/templates.js'
import type { Memory } from '../src/types.js'

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }

interface Case {
  name: string
  template: typeof COACH_TEMPLATE
  context: Record<string, unknown>
  memories?: Memory[]
}

const CASES: Case[] = [
  {
    name: 'coach',
    template: COACH_TEMPLATE,
    context: {
      threads: [{ id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'Alex' }],
      forcingFunctions: [{ id: 'ff1', title: 'Ship Q3 roadmap', owner: 'Alex', due: '2026-05-01', status: 'open' }],
      coachingNotes: [{ id: 'cn1', type: 'growth_edge', text: 'Over-functioning on tactical work' }],
      profile: { name: 'Jordan', role: 'CEO' },
    },
    memories: [{ id: 'm1', content: 'Prefers direct over softened framing', category: 'preference', pinned: true }],
  },
  {
    name: 'nutrition',
    template: NUTRITION_TEMPLATE,
    context: {
      todayStatus: { logged: 2, target: 5 },
      recentDays: [{ date: '2026-04-21', summary: 'Hit protein target' }],
      meals: [{ id: 'meal1', name: 'Chicken bowl', calories: 520, protein: 38 }],
      profile: { name: 'Sam', goal: 'maintain' },
    },
    memories: [{ id: 'm1', content: 'Allergic to peanuts', category: 'durable', pinned: true }],
  },
  {
    name: 'fitness',
    template: FITNESS_TEMPLATE,
    context: {
      injuries: ['Right shoulder — mild impingement'],
      equipment: ['Barbell', 'Dumbbells'],
      recentWorkouts: [{ id: 'w1', focus: 'Upper Push' }],
      exercises: [{ id: 'ex1', workoutId: 'w1', name: 'Bench press', sets: 4, reps: '6-8' }],
      profile: { name: 'Alex', experience: 'Intermediate' },
    },
    memories: [{ id: 'm1', content: 'Prefers compound movements', category: 'preference', pinned: true }],
  },
  {
    name: 'language-tutor',
    template: LANGUAGE_TUTOR_TEMPLATE,
    context: {
      currentGoal: { language: 'Spanish', focus: 'conversational fluency' },
      recentMistakes: [{ id: 'mk1', pattern: 'ser vs estar', correction: 'estar for temporary' }],
      phrasebook: ['Me parece que...'],
      profile: { name: 'Jamie', level: 'B1' },
    },
    memories: [{ id: 'm1', content: 'Wants casual-native tone', category: 'goal', pinned: true }],
  },
  {
    name: 'chief-of-staff',
    template: CHIEF_OF_STAFF_TEMPLATE,
    context: {
      openTasks: [{ id: 'tk1', title: 'Review Q2 offsite agenda', owner: 'Alex', due: '2026-04-29', status: 'open' }],
      constraints: ['No meetings Tuesday afternoons'],
      profile: { name: 'Riley', role: 'Founder' },
    },
    memories: [{ id: 'm1', content: 'Protects deep-work blocks', category: 'working_style', pinned: true }],
  },
]

describe('reference templates — audit is clean', () => {
  for (const c of CASES) {
    it(`${c.name} template passes auditPersona with zero findings`, async () => {
      const result = await auditPersona({
        config: { ...c.template, provider: mockProvider },
        context: c.context,
        memories: c.memories,
        scope: 'static-plus-scenario',
      })
      const findings = result.findings.filter(f => f.severity !== 'info')
      expect(
        findings,
        findings.length === 0
          ? ''
          : `${c.name} template has ${findings.length} finding(s):\n${findings.map(f => `  [${f.severity}] ${f.audit}:${f.principle} — ${f.message}`).join('\n')}`,
      ).toEqual([])
    })
  }
})
