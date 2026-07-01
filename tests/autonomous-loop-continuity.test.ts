import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  definePersona,
  runAutonomousLoop,
  type LLMProvider,
  type LLMProviderRequest,
  type LoopToolResult,
} from '../src/index.js'

function createSequenceProvider(
  responses: unknown[],
  historyTransport: LLMProvider['historyTransport'] = 'text',
): { provider: LLMProvider; requests: LLMProviderRequest[] } {
  const queue = [...responses]
  const requests: LLMProviderRequest[] = []
  const provider: LLMProvider = {
    name: 'capture',
    historyTransport,
    async chat(request) {
      requests.push(request)
      const next = queue.shift()
      if (next === undefined) throw new Error('No queued provider response')
      if (next instanceof Error) throw next
      return { text: typeof next === 'string' ? next : JSON.stringify(next) }
    },
  }
  return { provider, requests }
}

function createLoopPersona(provider: LLMProvider) {
  return definePersona({
    identity: {
      name: 'Builder',
      expertise: ['tool-using workflows'],
      relationship: 'autonomous worker',
      northStar: 'finish the work cleanly',
    },
    voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
    contextInputs: {
      workHistory: {
        label: 'WORK HISTORY',
        intent: 'Chronological private continuity.',
        format: 'list',
      },
    },
    actions: {
      readFile: {
        description: 'Read a file.',
        confidence: 'low',
        schema: z.object({ path: z.string() }),
      },
      writeFile: {
        description: 'Write a file.',
        confidence: 'low',
        schema: z.object({ path: z.string(), content: z.string() }),
      },
      finishAttempt: {
        description: 'Finish the attempt.',
        confidence: 'low',
        schema: z.object({
          outcome: z.enum(['success', 'blocked', 'failed']),
          summary: z.string(),
        }),
      },
      returnToSession: {
        description: 'Return from private focus work to the visible session.',
        confidence: 'low',
        schema: z.object({
          message: z.string(),
          state: z.enum(['ready', 'blocked', 'failed']).optional(),
          to: z.string().optional(),
        }),
      },
    },
    provider,
  })
}

describe('autonomous loop continuity', () => {
  it('preserves the active work message when recovering from a provider error', async () => {
    const initialWorkMessage = [
      'Build the Clockwork Courier game.',
      'The artifact must include movement, battery, deadlines, save/resume, tests, and play instructions.',
    ].join('\n')
    const { provider, requests } = createSequenceProvider([
      new Error('Autonomous loop turn 1 timed out after 90000ms'),
      {
        message: 'Continuing after the provider error.',
        actions: [{ name: 'finishAttempt', params: { outcome: 'blocked', summary: 'stopped after recovery check' } }],
      },
    ])

    const persona = createLoopPersona(provider)
    await runAutonomousLoop({
      persona,
      maxTurns: 2,
      run: {},
      modelRetries: 0,
      hooks: {
        initialMessage() {
          return initialWorkMessage
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(): Promise<LoopToolResult> {
          return {
            text: 'finishAttempt blocked',
            outcomeNote: 'Attempt stopped after recovery check.',
            finish: { outcome: 'blocked', summary: 'stopped after recovery check' },
          }
        },
        completionActionNames: ['finishAttempt'],
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.message).toBe(initialWorkMessage)
    expect(requests[1]?.message).toContain(initialWorkMessage)
    expect(requests[1]?.message).toContain('The LLM request timed out or the provider was under heavy load. No actions ran.')
    expect(requests[1]?.message).toContain('Autonomous loop turn 1 timed out after 90000ms')
    expect(requests[1]?.message).not.toContain('Try a smaller/simpler call')
    expect(requests[1]?.message).not.toContain('very long string arguments')
  })

  it('stores concise outcome history for text providers instead of raw JSON blobs', async () => {
    const hugeBody = 'A'.repeat(5000)
    const { provider } = createSequenceProvider([
      {
        message: 'Writing the spec file now.',
        actions: [{ name: 'writeFile', params: { path: 'spec.md', content: hugeBody } }],
      },
    ])

    const persona = createLoopPersona(provider)
    const result = await runAutonomousLoop({
      persona,
      maxTurns: 1,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult() {
          return 'unused in one-turn test'
        },
        async executeAction(): Promise<LoopToolResult> {
          return {
            text: `writeFile spec.md\n${hugeBody}`,
            outcomeNote: 'spec.md written successfully (5000 bytes).',
          }
        },
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    const assistantHistory = result.state.history[1]?.content ?? ''
    expect(assistantHistory).toContain('Writing the spec file now.')
    expect(assistantHistory).toContain('---outcomes: spec.md written successfully (5000 bytes).')
    expect(assistantHistory).not.toContain(hugeBody)
    expect(assistantHistory).not.toContain('"actions"')
    expect(result.state.records[0]?.rawAssistantResponse).toContain('"writeFile"')
    expect(result.state.records[0]?.rawAssistantResponse).toContain(hugeBody)
  })

  it('sends the full result once on the next turn while keeping history compact', async () => {
    const { provider, requests } = createSequenceProvider([
      {
        message: 'Reading the project brief.',
        actions: [{ name: 'readFile', params: { path: 'brief.md' } }],
      },
      {
        message: 'Done.',
        actions: [{ name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } }],
      },
    ])

    const persona = createLoopPersona(provider)
    await runAutonomousLoop({
      persona,
      maxTurns: 2,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(action): Promise<LoopToolResult> {
          if (action.name === 'readFile') {
            return {
              text: 'readFile brief.md\nMission\nScope\nRisks',
              outcomeNote: 'Read brief.md.',
            }
          }
          return {
            text: 'finishAttempt success',
            outcomeNote: 'Attempt finished successfully.',
          }
        },
        completionActionNames: ['finishAttempt'],
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.message).toBe('readFile brief.md\nMission\nScope\nRisks')
    expect(requests[1]?.history[1]?.content).toContain('---outcomes: Read brief.md.')
    expect(requests[1]?.history[1]?.content).not.toContain('Mission\nScope\nRisks')
  })

  it('carries only the latest prior-turn attachment into the next turn', async () => {
    const { provider, requests } = createSequenceProvider([
      {
        message: 'Capturing visual state.',
        actions: [{ name: 'readFile', params: { path: 'screen' } }],
      },
      {
        message: 'Done.',
        actions: [{ name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } }],
      },
    ])

    const persona = createLoopPersona(provider)
    await runAutonomousLoop({
      persona,
      maxTurns: 2,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(): Promise<LoopToolResult> {
          return {
            text: 'browserScreenshot player_moved',
            outcomeNote: 'Captured latest browser screenshot.',
            attachments: [
              { type: 'image', mimeType: 'image/png', data: 'first-image' },
              { type: 'image', mimeType: 'image/png', data: 'latest-image' },
            ],
          }
        },
        completionActionNames: ['finishAttempt'],
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    expect(requests[1]?.attachments).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'latest-image' },
    ])
  })

  it('stores compact JSON history for function-call reconstruction providers', async () => {
    const hugeBody = 'B'.repeat(4000)
    const { provider, requests } = createSequenceProvider([
      {
        message: 'Writing the spec file now.',
        actions: [{ name: 'writeFile', params: { path: 'spec.md', content: hugeBody } }],
      },
      {
        message: 'Done.',
        actions: [{ name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } }],
      },
    ], 'compact-function-calls')

    const persona = createLoopPersona(provider)
    await runAutonomousLoop({
      persona,
      maxTurns: 2,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(action): Promise<LoopToolResult> {
          if (action.name === 'writeFile') {
            return {
              text: 'writeFile spec.md\nSuccessfully wrote 4000 bytes.',
              outcomeNote: 'spec.md written successfully (4000 bytes).',
            }
          }
          return {
            text: 'finishAttempt success',
            outcomeNote: 'Attempt finished successfully.',
          }
        },
        completionActionNames: ['finishAttempt'],
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    const assistantHistory = requests[1]?.history[1]?.content ?? ''
    const parsed = JSON.parse(assistantHistory) as {
      message?: string
      actions?: Array<{ name?: string; params?: Record<string, unknown> }>
    }

    expect(parsed.message).toContain('spec.md written successfully (4000 bytes).')
    expect(parsed.actions?.[0]?.name).toBe('writeFile')
    expect(parsed.actions?.[0]?.params?.path).toBe('spec.md')
    expect(parsed.actions?.[0]?.params?.content).toBe('<omitted 4000 bytes>')
    expect(assistantHistory).not.toContain(hugeBody)
  })

  it('does not complete from a same-turn completion action that the batch executor skipped', async () => {
    const { provider } = createSequenceProvider([
      {
        message: 'I will patch and finish.',
        actions: [
          { name: 'writeFile', params: { path: 'spec.md', content: 'draft' } },
          { name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } },
        ],
      },
    ])

    const persona = createLoopPersona(provider)
    const result = await runAutonomousLoop({
      persona,
      maxTurns: 1,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(action): Promise<LoopToolResult> {
          return {
            text: `${action.name} should be handled by executeActions`,
            outcomeNote: `${action.name} should be handled by executeActions`,
          }
        },
        async executeActions(actions): Promise<Array<{ action: typeof actions[number]; result: LoopToolResult }>> {
          return actions.map(action => {
            if (action.name === 'writeFile') {
              return {
                action,
                result: {
                  text: 'writeFile spec.md failed — no edits applied.',
                  outcomeNote: 'writeFile spec.md failed — no edits applied.',
                },
              }
            }
            return {
              action,
              result: {
                text: 'finishAttempt skipped — prior same-turn action writeFile failed.',
                outcomeNote: 'finishAttempt skipped — prior same-turn action writeFile failed.',
                executed: false,
              },
            }
          })
        },
        completionActionNames: ['finishAttempt'],
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    expect(result.finish.outcome).toBe('blocked')
    expect(result.state.turnsUsed).toBe(1)
    expect(result.state.records[0]?.extraActionResults?.[0]?.action.name).toBe('finishAttempt')
    expect(result.state.records[0]?.extraActionResults?.[0]?.result.executed).toBe(false)
  })

  it('treats returnToSession as visibility return, not a blocked finishAttempt', async () => {
    const { provider } = createSequenceProvider([
      {
        message: 'Private focus note: spec files are ready for handoff.',
        actions: [
          {
            name: 'returnToSession',
            params: {
              state: 'ready',
              to: 'builder',
              message: 'The spec files are ready in spec/.',
            },
          },
        ],
      },
    ])

    const persona = createLoopPersona(provider)
    const result = await runAutonomousLoop({
      persona,
      maxTurns: 2,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(): Promise<LoopToolResult> {
          return {
            text: 'returnToSession posted visible message to builder.',
            outcomeNote: 'returnToSession posted visible message to builder.',
          }
        },
        completionActionNames: ['returnToSession'],
        chatOptions: {
          promptMode: 'focus',
          contractStyle: 'lean',
        },
      },
    })

    expect(result.finish).toEqual({
      outcome: 'success',
      summary: 'The spec files are ready in spec/.',
    })
  })

  it('allows chatOptions to rebuild focus context from the current loop state each turn', async () => {
    const { provider, requests } = createSequenceProvider([
      {
        message: 'Reading the brief.',
        actions: [{ name: 'readFile', params: { path: 'brief.md' } }],
      },
      {
        message: 'Done.',
        actions: [{ name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } }],
      },
    ])

    const persona = createLoopPersona(provider)
    await runAutonomousLoop({
      persona,
      maxTurns: 2,
      run: {},
      hooks: {
        initialMessage() {
          return 'Start'
        },
        formatToolResult(_action, toolResult) {
          return toolResult.text
        },
        async executeAction(action): Promise<LoopToolResult> {
          if (action.name === 'readFile') {
            return {
              text: 'readFile brief.md\ncontent:\nmission',
              outcomeNote: 'Read brief.md.',
            }
          }
          return {
            text: 'finishAttempt success',
            outcomeNote: 'Attempt finished successfully.',
          }
        },
        completionActionNames: ['finishAttempt'],
        chatOptions(_ctx, state) {
          return {
            promptMode: 'focus',
            contractStyle: 'lean',
            context: {
              workHistory: [`records=${state.records.length}`],
            },
          }
        },
      },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.systemPrompt).toContain('records=0')
    expect(requests[1]?.systemPrompt).toContain('records=1')
  })
})
