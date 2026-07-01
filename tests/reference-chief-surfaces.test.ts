import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildChatLLMRequest, buildPromptedTurnLLMRequest } from '../src/core/request-builder.js'
import { auditPromptContent } from '../src/evals/prompt-content.js'
import { auditEntityVisibility } from '../src/evals/entity-visibility.js'
import { auditOperationalPromptContract } from '../src/index.js'
import { CHIEF_OF_STAFF_TEMPLATE } from '../src/playbook/templates.js'

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

describe('reference chief surfaces', () => {
  const config = {
    ...CHIEF_OF_STAFF_TEMPLATE,
    provider: { name: 'mock', chat: async () => ({ text: '' }) },
  }
  const declaredEntities = Object.keys(CHIEF_OF_STAFF_TEMPLATE.entities ?? {})
  const promptNow = '2026-04-10T23:20:00-07:00'

  it('matches the reviewed chief chat prompt', () => {
    const chatContext = {
      openTasks: [
        { id: 'task-1', title: 'Draft investor update', owner: 'Alex', due: '2026-04-17', priority: 'high', status: 'open', definitionOfDone: 'A sendable draft exists with topline metrics up front.' },
        { id: 'task-2', title: 'Prep board metrics review', owner: 'Maya', due: '2026-04-16', priority: 'medium', status: 'open', notes: 'Need one clean page on burn and pipeline.' },
      ],
      constraints: [
        'Deep work blocks are protected from 09:00-11:00.',
        'Avoid Friday afternoon follow-ups if Thursday works.',
      ],
      profile: { name: 'Alex', role: 'CEO' },
    }
    const { request } = buildChatLLMRequest(config, {
      message: 'I am overloaded. Do not make me a bigger system. Given what is already on my plate, what actually matters this week?',
      history: [],
      context: chatContext,
      memories: [
        { id: 'm1', content: 'Prefers blunt drafts over diplomatic softening.', category: 'working_style', pinned: true },
      ],
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex',
    })

    const audit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(audit.issues).toEqual([])
    const visibilityAudit = auditEntityVisibility({ config, context: chatContext })
    expect(visibilityAudit.issues).toEqual([])
    expect(request.systemPrompt).toContain('What matters:')
    expect(request.systemPrompt).toContain('Create leverage, not theater')
    // Field list now inlines describe() annotations; assert key structural pieces rather than full verbatim.
    expect(request.systemPrompt).toMatch(/fields: \{ title: string \(.*\), owner: string\? \(.*\), due: string\? \(.*\)/)
    expect(request.systemPrompt).toContain('priority: "low" | "medium" | "high"?')
    expect(request.systemPrompt).toContain('status: "open" | "done" | "canceled"?')
    expect(request.systemPrompt).toContain('[working_style]')
    expect(request.systemPrompt).not.toContain('coaching_approach')
    expect(request.systemPrompt).toContain('"params":"{\\"title\\":\\"<string>\\"}"')
    expect(request.systemPrompt).not.toContain('\\"owner\\":\\"<string>\\"')
    expect(request.systemPrompt).not.toContain('You are an unusually strong chief of staff')

    expect(renderRequestArtifact('chief-chat', request)).toBe(readFixture('chief-chat'))
  })

  it('matches the reviewed chief operational prompt', () => {
    const operationalContext = {
      openTasks: [
        { id: 'task-1', title: 'Draft investor update', owner: 'Alex', due: '2026-04-17', priority: 'high', status: 'open', definitionOfDone: 'A sendable draft exists with topline metrics up front.' },
        { id: 'task-2', title: 'Prep board metrics review', owner: 'Maya', due: '2026-04-16', priority: 'medium', status: 'open', notes: 'Need one clean page on burn and pipeline.' },
      ],
      constraints: [
        'Deep work blocks are protected from 09:00-11:00.',
        'Avoid Friday afternoon follow-ups if Thursday works.',
      ],
      profile: { name: 'Alex', role: 'CEO' },
    }
    const { request } = buildPromptedTurnLLMRequest(config, {
      intent: 'Read the operating state, decide the next clean move, and change shared state only through declared entities.',
      label: 'daily operating turn',
      turnKind: 'operational',
      promptMode: 'operational',
      guidelines: 'Prefer the smallest real move that reduces load or sharpens ownership.',
      context: operationalContext,
      memories: [
        { id: 'm1', content: 'Prefers blunt drafts over diplomatic softening.', category: 'working_style', pinned: true },
      ],
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex',
    })

    const contentAudit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(contentAudit.issues).toEqual([])
    const visibilityAudit = auditEntityVisibility({ config, context: operationalContext })
    expect(visibilityAudit.issues).toEqual([])

    const contractAudit = auditOperationalPromptContract({
      request,
      trace: {
        traceId: 'chief-reference-operational',
        startedAt: Date.now(),
        parseOk: true,
        repairAttempted: false,
        actions: [],
        crudActions: [],
        executionResults: [],
        domainActions: [],
        outcomeNotes: [],
        errors: [],
      },
      expectedMode: 'operational',
      ids: [{ label: 'task ids', tokens: ['task-1', 'task-2'] }],
      enums: [{ label: 'task statuses', tokens: ['open', 'done', 'canceled'] }],
    })

    expect(contractAudit.pass).toBe(true)
    expect(contractAudit.issues).toEqual([])
    expect(request.systemPrompt).toContain('Operational reality:')
    expect(request.systemPrompt).not.toContain('App-initiated turn:')
    expect(request.systemPrompt).not.toContain('real person in front of you')

    expect(renderRequestArtifact('chief-operational', request)).toBe(readFixture('chief-operational'))
  })
})
