/**
 * Minimal live PM spec-agent sample.
 *
 * Writes a spec bundle into a local workspace using Archetype's focus-mode
 * prompt, prompt trace recorder, work-history renderer, and coder file
 * actions. Requires GEMINI_API_KEY for a live run.
 *
 * Usage:
 *   GEMINI_API_KEY=... node examples/pm-spec-agent/index.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createGeminiProvider,
  createPmSpecWorkItem,
  createPromptTraceRecorder,
  definePersona,
  Gemini,
  renderWorkHistoryEntries,
  runAutonomousLoop,
} from 'archetype'
import { executeCoderAction } from 'archetype/builder'
import { createPmPersonaConfig } from './persona.mjs'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('Set GEMINI_API_KEY to run the PM spec-agent sample.')
  process.exit(1)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archetype-pm-spec-'))
const tracesDir = path.join(root, '.prompt-traces')
fs.mkdirSync(path.join(root, '00-input'), { recursive: true })
fs.writeFileSync(
  path.join(root, '00-input', 'brief.md'),
  [
    '# The Last Lantern Spec Bundle',
    '',
    'Produce a real multi-document product-spec bundle for an eight-hour narrative adventure game.',
    'Engineering should be able to start the first playable slice without a rescue meeting.',
  ].join('\n'),
  'utf8',
)

const provider = Gemini({ apiKey })
const persona = definePersona(createPmPersonaConfig({ provider }))
const recorder = createPromptTraceRecorder({ outDir: tracesDir, format: 'both' })
const workHistory = [{ turn: 0, source: 'world', text: 'Fresh PM spec workspace. Only 00-input/brief.md exists.' }]

function contextForTurn(turn) {
  return {
    workItem: createPmSpecWorkItem({
      artifactName: 'The Last Lantern Spec Bundle',
      primaryGoal: 'Engineering can start the first playable slice and plan the remaining work without a rescue meeting.',
      constraints: [
        'Keep the game buildable as an eight-hour narrative adventure.',
        'Keep the bundle coherent across product promise, systems, narrative, UX, technical handoff, and delivery plan.',
        'Prefer concrete implementation-relevant detail over generic PM boilerplate.',
      ],
      mandatoryOutputs: [
        'Document index or map of the bundle',
        'Product brief with player promise and scope boundary',
        'Gameplay systems spec',
        'Narrative or quest structure',
        'UX flows including save or accessibility behavior',
        'Technical handoff for engineering',
        'Delivery plan with risks, assumptions, and milestones',
        'Requirement traceability showing where major promises land in the bundle',
      ],
    }),
    workHistory: renderWorkHistoryEntries(workHistory, { currentTurn: turn }),
    files: listWorkspaceFiles(root),
  }
}

const sandbox = {
  async runCommand() {
    return { ok: false, exitCode: 1, stdout: '', stderr: 'No sandbox commands are enabled for the PM sample.' }
  },
  async runTool(name) {
    return { ok: false, exitCode: 1, stdout: '', stderr: `${name} is not enabled for the PM sample.` }
  },
}

const result = await runAutonomousLoop({
  persona,
  maxTurns: 8,
  run: { workspaceRoot: root },
  hooks: {
    initialMessage(ctx) {
      return 'Continue the focused PM spec run.'
    },
    formatToolResult(_action, toolResult) {
      return toolResult.text
    },
    async executeAction(action, ctx) {
      const coderResult = await executeCoderAction({
        action,
        context: {
          workspaceRoot: root,
          sandbox,
          browser: null,
        },
      })
      if (action.name === 'finishAttempt') {
        workHistory.push({
          turn: ctx.turn,
          source: 'action',
          text: `finishAttempt requested ${String(action.params.outcome ?? 'unknown')}: ${String(action.params.summary ?? '')}`,
        })
        return {
          text: `finishAttempt ${String(action.params.outcome ?? 'unknown')}: ${String(action.params.summary ?? '')}`,
          outcomeNote: `finishAttempt requested ${String(action.params.outcome ?? 'unknown')}: ${String(action.params.summary ?? '')}`,
          finish: {
            outcome: action.params.outcome === 'success' ? 'success' : action.params.outcome === 'failed' ? 'failed' : 'blocked',
            summary: String(action.params.summary ?? 'Attempt finished.'),
          },
        }
      }
      if (!coderResult) {
        return {
          text: `Unknown action ${action.name}.`,
          outcomeNote: `Unknown action ${action.name}.`,
        }
      }
      workHistory.push({
        turn: ctx.turn,
        source: 'action',
        text: coderResult.continuity?.resultText ?? coderResult.historyNote,
        staleText: coderResult.continuity?.staleText,
        resultTurns: coderResult.continuity?.resultTurns,
      })
      return {
        text: coderResult.continuity?.resultText ?? coderResult.historyNote,
        outcomeNote: coderResult.historyNote,
        attachments: coderResult.attachments,
      }
    },
    completionActionNames: ['finishAttempt'],
    chatOptions(ctx) {
      return {
        promptMode: 'focus',
        contractStyle: 'lean',
        context: contextForTurn(ctx.turn),
      }
    },
    onBeforeChat: recorder.onBeforeChat,
    onTurn(record, state) {
      workHistory.push({
        turn: record.turn,
        source: 'self',
        text: record.assistantMessage,
      })
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

console.log(`workspace: ${root}`)
console.log(`prompt traces: ${tracesDir}`)
console.log(`finish: ${result.finish.outcome} — ${result.finish.summary}`)
console.log(listWorkspaceFiles(root).join('\n'))

function listWorkspaceFiles(workspaceRoot) {
  const rows = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
      } else {
        const text = fs.readFileSync(full, 'utf8')
        rows.push(`${rel} — ${text.split(/\r?\n/u).length} lines, ${Buffer.byteLength(text, 'utf8')} bytes`)
      }
    }
  }
  walk(workspaceRoot, '')
  return rows.length > 0 ? rows : ['(empty)']
}
