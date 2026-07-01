import { describe, expect, it } from 'vitest'
import { buildChatLLMRequest } from '../src/core/request-builder.js'
import { auditPromptContent } from '../src/evals/prompt-content.js'
import { auditEntityVisibility } from '../src/evals/entity-visibility.js'
import { CHIEF_OF_STAFF_TEMPLATE, COACH_TEMPLATE } from '../src/playbook/templates.js'

describe('reference template surfaces', () => {
  it('keeps the coach template app-specific instead of restating Archetype identity', () => {
    const coachConfig = {
      ...COACH_TEMPLATE,
      provider: { name: 'mock', chat: async () => ({ text: '' }) },
    }
    const coachContext = {
      threads: [
        { id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'VP Eng', description: 'Shipping has slowed 40% quarter-over-quarter' },
        { id: 't2', title: 'Product-market fit for enterprise', status: 'active', owner: 'CRO', description: 'Need to close 3 enterprise deals by Q3' },
      ],
      forcingFunctions: [
        { id: 'ff1', title: 'VP Eng roadmap tradeoff call', owner: 'VP Eng', due: '2026-04-14', status: 'open', threadId: 't1' },
      ],
      coachingNotes: [
        { id: 'note-1', type: 'behavioral', text: 'When Alex keeps brainstorming with VP Eng, ownership gets blurrier instead of sharper.' },
      ],
    }
    const { request } = buildChatLLMRequest(coachConfig, {
      message: 'I just had a tough 1:1 with my VP of Engineering. He keeps saying he needs more headcount, but I think the real issue is prioritization. How should I think about this?',
      history: [],
      context: coachContext,
      memories: [
        { id: 'm1', content: 'CEO tends to over-index on headcount discussions', category: 'coaching_approach', pinned: true },
        { id: 'm2', content: 'VP Eng responds well to data-driven framing', category: 'preference' },
      ],
      timezone: 'America/Los_Angeles',
      promptNow: '2026-04-10T23:20:00-07:00',
      userIdentity: 'Alex, CEO',
    })

    const audit = auditPromptContent({
      prompt: request.systemPrompt,
      declaredEntities: Object.keys(COACH_TEMPLATE.entities ?? {}),
    })
    expect(audit.issues).toEqual([])
    const visibilityAudit = auditEntityVisibility({ config: coachConfig, context: coachContext })
    expect(visibilityAudit.issues).toEqual([])
    expect(request.systemPrompt).not.toContain("You are the CEO's personal executive coach and trusted thinking partner")
    expect(request.systemPrompt.match(/trusted thinking partner/g) ?? []).toHaveLength(1)
    expect(request.systemPrompt).toContain('What matters in the room:')
    expect(request.systemPrompt).toContain('Concrete commitments that make important threads move')
    expect(request.systemPrompt).toContain('[coaching_approach]')
    expect(request.systemPrompt).not.toContain('[approach]')
  })

  it('keeps the chief-of-staff template focused on local taste instead of repeating identity', () => {
    const chiefConfig = {
      ...CHIEF_OF_STAFF_TEMPLATE,
      provider: { name: 'mock', chat: async () => ({ text: '' }) },
    }
    const chiefContext = {
      openTasks: [
        { id: 'task-1', title: 'Draft board note', owner: 'Alex', status: 'open', due: '2026-03-20', priority: 'medium', definitionOfDone: 'A sendable draft exists with the topline message in the first paragraph.' },
      ],
      constraints: [
        'Deep work blocks are protected from 09:00-11:00.',
        'Avoid Friday afternoon follow-ups if Thursday works.',
      ],
      profile: { name: 'Alex', role: 'CEO' },
    }
    const { request } = buildChatLLMRequest(chiefConfig, {
      message: 'Remind me to send the investor update Thursday morning, and keep the draft blunt.',
      history: [],
      context: chiefContext,
      memories: [
        { id: 'mem-1', content: 'Prefers blunt drafts over diplomatic softening.', category: 'working_style', pinned: true },
      ],
      timezone: 'America/Los_Angeles',
      promptNow: '2026-04-10T23:20:00-07:00',
      userIdentity: 'Alex',
    })

    const audit = auditPromptContent({
      prompt: request.systemPrompt,
      declaredEntities: Object.keys(CHIEF_OF_STAFF_TEMPLATE.entities ?? {}),
    })
    expect(audit.issues).toEqual([])
    const visibilityAudit = auditEntityVisibility({ config: chiefConfig, context: chiefContext })
    expect(visibilityAudit.issues).toEqual([])
    expect(request.systemPrompt).not.toContain('You are an unusually strong chief of staff')
    expect(request.systemPrompt).toContain('Reduce friction, sharpen choices, and add structure only when it genuinely helps.')
    // Field list now inlines describe() annotations; assert key structural pieces rather than full verbatim.
    expect(request.systemPrompt).toMatch(/fields: \{ title: string \(.*\), owner: string\? \(.*\), due: string\? \(.*\)/)
    expect(request.systemPrompt).toContain('priority: "low" | "medium" | "high"?')
    expect(request.systemPrompt).toContain('status: "open" | "done" | "canceled"?')
    expect(request.systemPrompt).toContain('[working_style]')
    expect(request.systemPrompt).not.toContain('coaching_approach')
  })
})
