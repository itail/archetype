import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildChatLLMRequest, buildPromptedTurnLLMRequest } from '../src/core/request-builder.js'
import { auditPromptContent } from '../src/evals/prompt-content.js'
import { auditEntityVisibility } from '../src/evals/entity-visibility.js'
import { COACH_TEMPLATE } from '../src/playbook/templates.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function readFixture(name: string) {
  return readFileSync(join(__dirname, '__fixtures__', 'reference-app-prompts', `${name}.txt`), 'utf8').replace(/\s+$/, '')
}

function renderRequestArtifact(name: string, request: { promptMode: string, promptOrigin: string, systemPrompt: string, message: string }) {
  return [
    `NAME: ${name}`,
    `PROMPT MODE: ${request.promptMode}`,
    `PROMPT ORIGIN: ${request.promptOrigin}`,
    '',
    'SYSTEM PROMPT:',
    request.systemPrompt,
    '',
    'MESSAGE:',
    request.message,
    '',
  ].join('\n').replace(/\s+$/, '')
}

describe('reference coach surfaces', () => {
  const config = {
    ...COACH_TEMPLATE,
    provider: { name: 'mock', chat: async () => ({ text: '' }) },
  }
  const declaredEntities = Object.keys(COACH_TEMPLATE.entities ?? {})
  const promptNow = '2026-04-10T23:20:00-07:00'

  it('matches the reviewed coach chat prompt', () => {
    const chatContext = {
      threads: [
        { id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'VP Eng', description: 'Shipping has slowed 40% quarter-over-quarter' },
        { id: 't2', title: 'Product-market fit for enterprise', status: 'active', owner: 'CRO', description: 'Need to close 3 enterprise deals by Q3' },
      ],
      forcingFunctions: [
        { id: 'ff1', title: 'VP Eng returns with a top-3 roadmap tradeoff call', owner: 'VP Eng', due: '2026-04-14', status: 'open', threadId: 't1' },
      ],
      coachingNotes: [
        { id: 'note-1', type: 'behavioral', text: 'Alex keeps brainstorming with VP Eng instead of forcing clear ownership.' },
      ],
    }
    const { request } = buildChatLLMRequest(config, {
      message: 'I just had a tough 1:1 with my VP of Engineering. He keeps saying he needs more headcount, but I think the real issue is prioritization. How should I think about this?',
      history: [],
      context: chatContext,
      memories: [
        { id: 'm1', content: 'CEO tends to over-index on headcount discussions', category: 'coaching_approach', pinned: true },
        { id: 'm2', content: 'VP Eng responds well to data-driven framing', category: 'preference' },
      ],
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex, CEO',
    })

    const audit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(audit.issues).toEqual([])
    const visibilityAudit = auditEntityVisibility({ config, context: chatContext })
    expect(visibilityAudit.issues).toEqual([])
    expect(request.systemPrompt).toContain('The world you operate in:')
    expect(request.systemPrompt).toContain('What matters in the room:')
    expect(request.systemPrompt).toContain('forcingFunction')
    expect(request.systemPrompt).toContain('OPEN FORCING FUNCTIONS')
    // Field list now inlines describe() annotations; assert key structural pieces rather than full verbatim.
    expect(request.systemPrompt).toMatch(/fields: \{ title: string \(.*\), status: string \(.*\), owner: string \(.*\), description: string\? \(.*\) \}/)
    expect(request.systemPrompt).not.toContain("You are the CEO's personal executive coach and trusted thinking partner")

    expect(renderRequestArtifact('coach-chat', request)).toBe(readFixture('coach-chat'))
  })

  it('matches the reviewed coach proactive prompt', () => {
    const proactiveContext = {
      threads: [
        { id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'VP Eng', description: 'Shipping has slowed 40% quarter-over-quarter' },
      ],
      forcingFunctions: [
        { id: 'ff1', title: 'VP Eng returns with a top-3 roadmap tradeoff call', owner: 'VP Eng', due: '2026-04-14', status: 'open', threadId: 't1' },
      ],
      coachingNotes: [
        { id: 'note-1', type: 'behavioral', text: 'When Alex keeps brainstorming with VP Eng, ownership gets blurrier instead of sharper.' },
      ],
      profile: { name: 'Alex', role: 'CEO', company: 'Acme' },
    }
    const { request } = buildPromptedTurnLLMRequest(config, {
      intent: 'Offer one concise coaching observation before the CEO walks into the VP Eng roadmap 1:1.',
      label: 'pre_1_1 reflection',
      turnKind: 'proactive-conversation',
      context: proactiveContext,
      memories: [
        { id: 'm1', content: 'Responds well to direct pattern-naming when it is specific and earned.', category: 'coaching_approach', pinned: true },
      ],
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex, CEO',
      directives: 'Push for precision over reassurance.',
    })

    const audit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(audit.issues).toEqual([])
    const visibilityAudit = auditEntityVisibility({ config, context: proactiveContext })
    expect(visibilityAudit.issues).toEqual([])
    expect(request.systemPrompt).toContain('App-initiated turn:')
    expect(request.systemPrompt).toContain('Push for precision over reassurance.')
    expect(request.systemPrompt).toContain('forcingFunction')
    expect(request.systemPrompt).not.toContain('What matters in the room:')

    expect(renderRequestArtifact('coach-proactive', request)).toBe(readFixture('coach-proactive'))
  })
})
