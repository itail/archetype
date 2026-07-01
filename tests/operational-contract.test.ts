import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { auditOperationalPromptContract, buildChatLLMRequest, definePersona } from '../src/index.js'
import type { LLMProvider, LLMProviderRequest, TurnTrace } from '../src/types.js'

function createCapturingProvider(response: unknown = { message: 'ok', actions: [] }): {
  provider: LLMProvider
  getLastRequest(): LLMProviderRequest
} {
  let lastRequest: LLMProviderRequest | null = null
  const provider: LLMProvider = {
    name: 'capture',
    chat: vi.fn().mockImplementation(async (request: LLMProviderRequest) => {
      lastRequest = request
      return { text: typeof response === 'string' ? response : JSON.stringify(response) }
    }),
  }

  return {
    provider,
    getLastRequest() {
      if (!lastRequest) throw new Error('No request captured')
      return lastRequest
    },
  }
}

function createOperationalPersona(provider: LLMProvider) {
  return definePersona({
    identity: {
      name: 'Operator',
      expertise: ['operations'],
      relationship: 'operating partner',
      northStar: 'keep the institution moving',
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
          nextStatus: z.enum(['waiting-on-counterparty', 'scheduled', 'closed']).optional(),
        }),
      },
    },
    contextInputs: {
      roleDirectory: { label: 'ROLE DIRECTORY', format: 'list' },
      externalThreads: { label: 'EXTERNAL THREADS', format: 'list' },
    },
    provider,
  })
}

describe('operational prompt contract', () => {
  it('captures a clean operational provider-boundary prompt for promptedTurn()', async () => {
    const { provider, getLastRequest } = createCapturingProvider()
    const persona = createOperationalPersona(provider)

    const result = await persona.promptedTurn({
      intent: 'Operate from your seat.',
      context: {
        roleDirectory: [
          { roleId: 'role-ceo-1', title: 'CEO' },
          { roleId: 'role-ops-1', title: 'Ops Lead' },
        ],
        externalThreads: [
          'threadId: thread-123 | counterparty: North Clinic | status: waiting-on-company | validNextStatus: waiting-on-counterparty | scheduled | closed',
        ],
      },
    })

    const request = getLastRequest()
    const audit = auditOperationalPromptContract({
      request,
      trace: result.trace,
      expectedMode: 'operational',
      ids: [
        { label: 'external thread ids', tokens: ['thread-123'] },
      ],
      enums: [
        { label: 'thread status transitions', tokens: ['waiting-on-counterparty', 'scheduled', 'closed'] },
      ],
      recipients: [
        { label: 'role directory', tokens: ['role-ceo-1', 'role-ops-1'] },
      ],
    })

    expect(request.systemPrompt).toContain('Operational reality:')
    expect(request.systemPrompt).toContain('--- ACTION RESPONSE CONTRACT ---')
    expect(request.systemPrompt).toContain('Return exactly one raw JSON object and nothing else.')
    expect(request.systemPrompt).toContain('Do not wrap the response in markdown code fences.')
    expect(request.systemPrompt.match(/--- ACTION RESPONSE CONTRACT ---/g)?.length ?? 0).toBe(1)
    expect(request.systemPrompt).not.toContain('Operational continuity:')
    expect(request.systemPrompt).not.toContain('real person in front of you')
    expect(request.systemPrompt).not.toContain('"followUps"')
    expect(request.systemPrompt).not.toContain('desktop side panel')
    expect(request.systemPrompt).not.toContain('Your client trusts your judgment')
    expect(request.systemPrompt).not.toContain('fresh user message')
    expect(request.systemPrompt).not.toContain('fresh session')
    expect(audit.pass).toBe(true)
    expect(audit.issues).toEqual([])
  })

  it('flags conversational leakage and missing operational surfaces', () => {
    const trace: TurnTrace = {
      traceId: 'trace-1',
      startedAt: Date.now(),
      parseOk: true,
      repairAttempted: false,
      actions: [],
      crudActions: [],
      executionResults: [],
      domainActions: [],
      outcomeNotes: [],
      errors: [],
    }

    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: [
          'You are an expert with a real person in front of you.',
          '"followUps": Natural next things the user might realistically tap or say next.',
          '--- ACTION RESPONSE CONTRACT ---',
        ].join('\n'),
        message: '[app-initiated turn]',
      },
      trace,
      expectedMode: 'operational',
      ids: [{ label: 'thread ids', tokens: ['thread-123'] }],
      enums: [{ label: 'thread statuses', tokens: ['scheduled'] }],
      recipients: [{ label: 'recipient directory', tokens: ['role-ceo-1'] }],
    })

    expect(audit.pass).toBe(false)
    expect(audit.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('conversational scaffold'),
      expect.stringContaining('ID surface missing'),
      expect.stringContaining('enum surface missing'),
      expect.stringContaining('recipient surface missing'),
    ]))
  })

  it('warns when the canonical action contract is duplicated', () => {
    const trace: TurnTrace = {
      traceId: 'trace-dup',
      startedAt: Date.now(),
      parseOk: true,
      repairAttempted: false,
      actions: [],
      crudActions: [],
      executionResults: [],
      domainActions: [],
      outcomeNotes: [],
      errors: [],
    }

    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: [
          'Operational reality:',
          '--- ACTION RESPONSE CONTRACT ---',
          'Do not wrap the response in markdown code fences.',
          'Return exactly one raw JSON object and nothing else.',
          '--- ACTION RESPONSE CONTRACT ---',
        ].join('\n'),
        message: 'Use the structured context and turn instructions as the live input for this app-initiated turn. Return exactly one raw JSON object that matches the output contract in the system prompt.',
      },
      trace,
      expectedMode: 'operational',
    })

    expect(audit.pass).toBe(true)
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('duplicate action API contract') }),
    ]))
  })

  it('accepts an operational prompt that exposes only entity CRUD, not domain actions', () => {
    const trace: TurnTrace = {
      traceId: 'trace-entity-only',
      startedAt: Date.now(),
      parseOk: true,
      repairAttempted: false,
      actions: [],
      crudActions: [],
      executionResults: [],
      domainActions: [],
      outcomeNotes: [],
      errors: [],
    }

    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: [
          'Operational reality:',
          '--- ENTITY CRUD RESPONSE CONTRACT ---',
          'Return exactly one raw JSON object and nothing else.',
          'Do not wrap the response in markdown code fences.',
          '(id:task-1) [open] Draft investor update',
        ].join('\n'),
        message: 'Use the structured context and turn instructions as the live input for this app-initiated turn. Return exactly one raw JSON object that matches the output contract in the system prompt.',
      },
      trace,
      expectedMode: 'operational',
      ids: [{ label: 'task ids', tokens: ['task-1'] }],
    })

    expect(audit.pass).toBe(true)
    expect(audit.issues).toEqual([])
  })

  it('accepts a clean focus prompt and catches duplicate sequential guidance', () => {
    const { provider } = createCapturingProvider()
    const persona = createOperationalPersona(provider)
    const { request } = buildChatLLMRequest(persona.config, {
      message: 'Continue the current work slice.',
      context: {
        roleDirectory: ['roleId: role-ceo-1 | title: CEO'],
        externalThreads: ['threadId: thread-123 | status: waiting-on-company'],
      },
      timezone: 'UTC',
      promptMode: 'focus',
    })

    const cleanAudit = auditOperationalPromptContract({
      request,
      expectedMode: 'focus',
    })

    expect(cleanAudit.pass).toBe(true)
    expect(cleanAudit.issues).toEqual([])
    expect(request.systemPrompt).not.toContain("editFile: each entry's oldText")

    const duplicateAudit = auditOperationalPromptContract({
      request: {
        ...request,
        systemPrompt: `${request.systemPrompt}\n"actions" is a list. Every entry runs sequentially within this turn.`,
      },
      expectedMode: 'focus',
    })

    expect(duplicateAudit.pass).toBe(true)
    expect(duplicateAudit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('duplicate sequential action guidance') }),
    ]))
  })

  it('flags focus prompts that collapse observation continuity to path-only summaries', () => {
    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: [
          'Return one raw JSON object: { "message": "...", "actions": [...] }. No markdown.',
          '--- WORLD UPDATES ---',
          '- turn 1: Read 00-input/benchmark-brief.md.',
          '--- FILES ---',
          '- 00-input/benchmark-brief.md',
        ].join('\n'),
        message: 'Continue the current slice.',
      },
      expectedMode: 'focus',
      continuity: [{
        label: 'benchmark brief read result',
        tokens: ['00-input/benchmark-brief.md'],
        requiredTokens: ['00-input/benchmark-brief.md', '# The Last Lantern'],
      }],
    })

    expect(audit.pass).toBe(false)
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('continuity surface missing') }),
    ]))
  })

  it('accepts focus prompts that carry forward observation content from prior actions', () => {
    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: [
          'Return one raw JSON object: { "message": "...", "actions": [...] }. No markdown.',
          '--- TOOL RESULTS ---',
          '- turn 1: readFile 00-input/benchmark-brief.md',
          '  # The Last Lantern',
          '  Build a playable narrative adventure.',
        ].join('\n'),
        message: 'Continue the current slice.',
      },
      expectedMode: 'focus',
      continuity: [{
        label: 'benchmark brief read result',
        tokens: ['00-input/benchmark-brief.md'],
        requiredTokens: ['00-input/benchmark-brief.md', '# The Last Lantern'],
      }],
    })

    expect(audit.pass).toBe(true)
    expect(audit.issues).toEqual([])
  })

  it('accepts focus prompts that replace expired results with a tombstone', () => {
    const audit = auditOperationalPromptContract({
      request: {
        systemPrompt: [
          'Return one raw JSON object: { "message": "...", "actions": [...] }. No markdown.',
          '--- TOOL RESULTS ---',
          '- turn 1: <readFile result for 00-input/benchmark-brief.md no longer carried in WORK HISTORY; read the file again only if exact contents are needed>',
        ].join('\n'),
        message: 'Continue the current slice.',
      },
      expectedMode: 'focus',
      continuity: [{
        label: 'benchmark brief read result',
        tokens: ['00-input/benchmark-brief.md'],
        requiredTokens: ['00-input/benchmark-brief.md'],
        retrievalTokens: ['read the file again only if exact contents are needed'],
      }],
    })

    expect(audit.pass).toBe(true)
    expect(audit.issues).toEqual([])
  })
})
