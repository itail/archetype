import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  auditPersona,
  createPmSpecPersonaConfig,
  createPmSpecWorkItem,
  createPromptTraceRecorder,
  definePersona,
  dumpPromptForReview,
  renderWorkHistoryEntries,
  runAutonomousLoop,
  type LLMProvider,
  type LLMProviderRequest,
  type LoopToolResult,
  type WorkHistoryEntry,
} from '../src/index.js'
import { executeCoderAction, executeCoderActions } from '../src/builder/index.js'

const mockProvider: LLMProvider = {
  name: 'mock',
  async chat() {
    return { text: '' }
  },
}

function sampleWorkItem() {
  return createPmSpecWorkItem({
    artifactName: 'The Last Lantern Spec Bundle',
    primaryGoal: 'Engineering can start the first playable slice and plan the remaining work without a rescue meeting.',
    constraints: [
      'Keep the game buildable as an eight-hour narrative adventure.',
      'Keep the bundle coherent across product promise, systems, narrative, UX, technical handoff, and delivery plan.',
    ],
    mandatoryOutputs: [
      'Document index or map of the bundle',
      'Product brief with player promise and scope boundary',
      'Gameplay systems spec',
      'Technical handoff for engineering',
    ],
  })
}

function sampleContext(workHistory: string[] = ['turn 0 · world: Fresh workspace.']) {
  return {
    workItem: sampleWorkItem(),
    workHistory,
    files: ['00-input/brief.md — 4 lines, 220 bytes'],
  }
}

function createSequenceProvider(responses: unknown[]): { provider: LLMProvider; requests: LLMProviderRequest[] } {
  const queue = [...responses]
  const requests: LLMProviderRequest[] = []
  return {
    requests,
    provider: {
      name: 'sequence',
      async chat(request) {
        requests.push(request)
        const next = queue.shift()
        if (next === undefined) throw new Error('No queued response')
        return { text: JSON.stringify(next) }
      },
    },
  }
}

describe('PM spec-agent sample', () => {
  it('assembles a focus prompt with a single work item and intentful continuity blocks', () => {
    const config = createPmSpecPersonaConfig({ provider: mockProvider })
    const dumped = dumpPromptForReview(config, {
      message: 'Continue the focused PM run.',
      context: sampleContext(),
      history: [],
      timezone: 'UTC',
      promptMode: 'focus',
      contractStyle: 'lean',
    })

    expect(dumped.systemPrompt).toContain('--- WORK ITEM ---')
    expect(dumped.systemPrompt).toContain('Focus reality:')
    expect(dumped.systemPrompt).toContain('Focus context contains persona-authored operating context')
    expect(dumped.systemPrompt).toContain('Intent: Persona-authored future operating context')
    expect(dumped.systemPrompt).toContain('expert judgment lens')
    expect(dumped.systemPrompt).not.toContain('--- WORK ITEM [CRITICAL] ---')
    expect(dumped.systemPrompt).toContain('--- WORK HISTORY ---')
    expect(dumped.systemPrompt).toContain('Intent: Chronological private work continuity')
    expect(dumped.systemPrompt).toContain('--- FILES ---')
    expect(dumped.systemPrompt).toContain('Intent: Factual workspace tree with size signals')
    expect(dumped.systemPrompt).not.toContain('CURRENT STATE')
    expect(dumped.systemPrompt).not.toContain('CURRENT FOCUS')
    expect(dumped.systemPrompt).not.toContain('REQUIREMENT CHANGE')
  })

  it('passes Archetype persona audit with the representative focus scenario', async () => {
    const config = createPmSpecPersonaConfig({ provider: mockProvider })
    const result = await auditPersona({
      config,
      context: sampleContext(),
      promptMode: 'focus',
      scope: 'static-plus-scenario',
    })

    expect(result.findings.filter(f => f.severity === 'error')).toEqual([])
    expect(result.auditsRun).toContain('action-contracts')
    expect(result.auditsRun).toContain('prompt-content')
  })

  it('runs through Archetype autonomous-loop with dynamic work history and prompt traces', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'archetype-pm-sample-'))
    try {
      fs.writeFileSync(path.join(root, 'brief.md'), '# Brief\nBuild a spec.\n', 'utf8')
      const traceDir = path.join(root, '.traces')
      const recorder = createPromptTraceRecorder({ outDir: traceDir, format: 'both' })
      const workHistory: WorkHistoryEntry[] = [
        { turn: 0, source: 'world', text: 'Fresh workspace. brief.md exists.' },
      ]
      const { provider, requests } = createSequenceProvider([
        {
          message: 'I will read the brief first.',
          actions: [{ name: 'readFile', params: { path: 'brief.md' } }],
        },
        {
          message: 'I will write the product brief and finish.',
          actions: [
            {
              name: 'applyPatch',
              params: {
                patch: [
                  'diff --git a/02-product-brief.md b/02-product-brief.md',
                  'new file mode 100644',
                  '--- /dev/null',
                  '+++ b/02-product-brief.md',
                  '@@ -0,0 +1,2 @@',
                  '+# Product Brief',
                  '+Concrete scope.',
                  '',
                ].join('\n'),
              },
            },
            { name: 'returnToSession', params: { state: 'ready', message: 'Spec seed created.' } },
          ],
        },
      ])
      const persona = definePersona(createPmSpecPersonaConfig({ provider }))
      const sandbox = {
        async runCommand() {
          return { ok: false, exitCode: 1, stdout: '', stderr: 'not enabled' }
        },
        async runTool() {
          return { ok: false, exitCode: 1, stdout: '', stderr: 'not enabled' }
        },
      }

      const result = await runAutonomousLoop({
        persona,
        maxTurns: 4,
        run: {},
        hooks: {
          initialMessage() {
            return 'Continue the focused PM run.'
          },
          formatToolResult(_action, toolResult) {
            return toolResult.text
          },
          async executeAction(action, ctx): Promise<LoopToolResult> {
            if (action.name === 'returnToSession') {
              const text = `returnToSession posted visible message: ${String(action.params.message)}`
              const state = action.params.state === 'blocked' || action.params.state === 'failed'
                ? action.params.state
                : 'success'
              workHistory.push({ turn: ctx.turn, source: 'action', text })
              return {
                text,
                outcomeNote: text,
                finish: {
                  outcome: state,
                  summary: String(action.params.message),
                },
              }
            }
            const executed = await executeCoderAction({
              action,
              context: {
                workspaceRoot: root,
                browser: null,
                sandbox,
              },
            })
            if (!executed) return { text: `Unknown action ${action.name}.`, outcomeNote: `Unknown action ${action.name}.` }
            workHistory.push({
              turn: ctx.turn,
              source: 'action',
              text: executed.continuity?.resultText ?? executed.historyNote,
              resultTurns: executed.continuity?.resultTurns,
              staleText: executed.continuity?.staleText,
            })
            return {
              text: executed.continuity?.resultText ?? executed.historyNote,
              outcomeNote: executed.historyNote,
            }
          },
          async executeActions(actions, ctx): Promise<Array<{ action: typeof actions[number]; result: LoopToolResult }>> {
            const executed = await executeCoderActions({
              actions,
              context: {
                workspaceRoot: root,
                browser: null,
                sandbox,
              },
            })
            const results: Array<{ action: typeof actions[number]; result: LoopToolResult }> = []
            for (const item of executed) {
              if (!item.result && item.action.name === 'returnToSession') {
                const text = `returnToSession posted visible message: ${String(item.action.params.message)}`
                const state = item.action.params.state === 'blocked' || item.action.params.state === 'failed'
                  ? item.action.params.state
                  : 'success'
                workHistory.push({ turn: ctx.turn, source: 'action', text })
                results.push({
                  action: item.action,
                  result: {
                    text,
                    outcomeNote: text,
                    finish: {
                      outcome: state,
                      summary: String(item.action.params.message),
                    },
                  },
                })
                continue
              }
              if (!item.result) {
                const text = `Unknown action ${item.action.name}.`
                results.push({ action: item.action, result: { text, outcomeNote: text } })
                continue
              }
              workHistory.push({
                turn: ctx.turn,
                source: 'action',
                text: item.result.continuity?.resultText ?? item.result.historyNote,
                resultTurns: item.result.continuity?.resultTurns,
                staleText: item.result.continuity?.staleText,
              })
              results.push({
                action: item.action,
                result: {
                  text: item.result.continuity?.resultText ?? item.result.historyNote,
                  outcomeNote: item.result.historyNote,
                  executed: item.result.skipped ? false : undefined,
                },
              })
            }
            return results
          },
          completionActionNames: ['returnToSession'],
          chatOptions(ctx) {
            return {
              promptMode: 'focus',
              contractStyle: 'lean',
              context: {
                ...sampleContext(renderWorkHistoryEntries(workHistory, { currentTurn: ctx.turn })),
                files: listFiles(root),
              },
            }
          },
          onBeforeChat: recorder.onBeforeChat,
          onTurn(record, state) {
            recorder.recordTurnResult({
              turn: record.turn,
              rawResponse: record.rawAssistantResponse,
              message: record.assistantMessage,
              trace: record.trace,
              actions: [record.action, ...(record.extraActionResults ?? []).map(item => item.action)].filter(Boolean),
              actionResults: [
                record.toolResult ? { action: record.action, result: record.toolResult } : null,
                ...(record.extraActionResults ?? []),
              ].filter(Boolean),
              historyAfterTurn: state.history,
            })
          },
        },
      })

      expect(result.finish.outcome).toBe('success')
      expect(fs.readFileSync(path.join(root, '02-product-brief.md'), 'utf8')).toContain('Concrete scope.')
      expect(requests[1]?.systemPrompt).toContain('readFile brief.md\ncontent:\n# Brief')
      expect(requests[1]?.history).toEqual([])
      expect(fs.existsSync(path.join(traceDir, 'turn-01-initial-attempt-1.json'))).toBe(true)
      const turn1 = JSON.parse(fs.readFileSync(path.join(traceDir, 'turn-01-initial-attempt-1.json'), 'utf8'))
      expect(turn1.result.actionResults[0].result.text).toContain('# Brief')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function listFiles(root: string): string[] {
  return fs.readdirSync(root)
    .filter(name => !name.startsWith('.'))
    .sort()
    .map((name) => {
      const full = path.join(root, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) return `${name}/`
      const text = fs.readFileSync(full, 'utf8')
      return `${name} — ${text.split(/\r?\n/u).length} lines, ${Buffer.byteLength(text, 'utf8')} bytes`
    })
}
