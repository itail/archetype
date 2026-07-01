/**
 * examples/coder-agent — reference app for building code-writing personas
 * on top of archetype.
 *
 * The goal is to read the *whole* loop in under 10 minutes:
 *
 *   1. Define a persona whose action surface is `coderActions` (a subset).
 *   2. Wrap archetype's SrtSandbox + PlaywrightBrowser with a thin host
 *      preset layer (sandbox-preset.mjs).
 *   3. Run `runAutonomousLoop`: dispatch each action through
 *      `executeCoderAction`, attach `createTurnReporter` for observability,
 *      collect per-turn traces via `onBeforeChat`.
 *   4. Render a TURNS.md report with `renderRunMarkdown` at the end.
 *
 * The persona is asked to ship a click counter and verify it in a headless
 * browser. Everything the model decides — when to build, when to start the
 * server, when to screenshot — is its call, not the harness's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  definePersona,
  Gemini,
  runAutonomousLoop,
  createTurnReporter,
  renderRunMarkdown,
} from 'archetype'
import {
  executeCoderAction,
  PlaywrightBrowser,
} from 'archetype/builder'

import { CoderAgentSandbox } from './sandbox-preset.mjs'
import { createCoderPersonaConfig } from './persona.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 25)

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required. Run with: GEMINI_API_KEY=... node examples/coder-agent/index.mjs')
  process.exit(1)
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runRoot = path.join(__dirname, '.runs', runId)
const workspaceRoot = path.join(runRoot, 'workspace')
// dist/ lives inside the workspace so runBuild's writes stay within the
// sandbox's allowWrite fence. runStart picks it up automatically when
// index.html exists there; otherwise it serves the workspace root.
const distRoot = path.join(workspaceRoot, 'dist')
const evidenceRoot = path.join(runRoot, 'evidence')
fs.mkdirSync(workspaceRoot, { recursive: true })
fs.mkdirSync(evidenceRoot, { recursive: true })

const persona = definePersona(createCoderPersonaConfig({
  provider: Gemini({
    apiKey: process.env.GEMINI_API_KEY,
    model: MODEL,
    // Coding-path default: emit {message, actions} as JSON instead of
    // Gemini's native function-calling. Native FC silently suppressed
    // multi-action emissions; see memory project_drop_gemini_function_calling.
    useFunctionCalling: false,
  }),
}))

const sandbox = new CoderAgentSandbox({
  workspaceRoot,
  distRoot,
  evidenceRoot,
  toolchainDir: path.join(__dirname, 'toolchain'),
})

let browser = null
const turnReporter = createTurnReporter({ runRoot })
const traces = []

const INITIAL_BRIEF = [
  'Context: you are writing the reference artifact for an archetype SDK example.',
  'Future developers will read this file as "what a coder-persona ships," so it needs to be the HTML/CSS/JS you would be happy to inherit — not the minimum that renders.',
  '',
  'Task: Build a click counter at index.html.',
  '- A button labeled "Increment" and a visible counter starting at 0.',
  '- Clicking the button increments the counter on the page.',
  '',
  'Verify behavior before finishing: build, start the server, open the returned URL in the browser, click the button, capture a screenshot that shows a non-zero counter, finish honestly.',
  '',
  'The workspace is empty. Begin.',
].join('\n')

try {
  const { finish } = await runAutonomousLoop({
    persona,
    maxTurns: MAX_TURNS,
    run: { runId },
    // 'focus' is the right prompt mode for a coder agent: it drops the
    // conversation-centric scaffolding (relational preamble, momentum
    // block, come-back test, "default is conversation not action"
    // contract) and uses the tight multi-action output format designed
    // for builder flows. Cuts the system prompt from ~6.8k to ~2.7k
    // chars with no contradictions.
    hooks: {
      initialMessage: () => INITIAL_BRIEF,
      formatToolResult: (_action, result) => result.text ?? '',
      completionActionNames: ['finishAttempt'],
      chatOptions: { promptMode: 'focus' },
      executeAction: async (action) => {
        const result = await executeCoderAction({
          action,
          context: { workspaceRoot, sandbox, browser },
        })
        if (!result) {
          return {
            text: `Unknown action "${action.name}" — not in this persona's tool surface.`,
          }
        }
        if (result.liveOrigin && !browser) {
          browser = new PlaywrightBrowser({ allowedOrigin: result.liveOrigin })
        }
        if (result.capturedScreenshot && result.attachments?.[0]?.data) {
          const label = String(action.params?.label ?? 'screenshot').replace(/[^\w-]/g, '_')
          const pngPath = path.join(evidenceRoot, `${Date.now()}-${label}.png`)
          fs.writeFileSync(pngPath, Buffer.from(result.attachments[0].data, 'base64'))
        }
        return {
          text: result.historyNote,
          attachments: result.attachments,
          observation: {
            mutatedArtifact: result.mutatedArtifact ?? false,
            capturedScreenshot: result.capturedScreenshot ?? false,
            sandboxToolCall: result.sandboxToolCall ?? false,
            toolExitCode: result.toolExitCode,
          },
        }
      },
      onBeforeChat: ({ request, turn }) => {
        traces.push({
          turn,
          systemPrompt: request.systemPrompt,
          message: request.message,
          history: request.history,
        })
      },
      onTurn: turnReporter.onTurn,
    },
  })

  const errors = readErrorsJsonl(path.join(runRoot, 'errors.jsonl'))
  const turnsPath = path.join(runRoot, 'TURNS.md')
  fs.writeFileSync(
    turnsPath,
    renderRunMarkdown({
      runId,
      metadata: { benchmarkId: 'examples/coder-agent', artifactName: 'click-counter', status: finish.outcome },
      traces,
      errors,
    }),
  )

  console.log('')
  console.log(`Outcome:    ${finish.outcome}`)
  console.log(`Summary:    ${finish.summary}`)
  console.log(`Run root:   ${runRoot}`)
  console.log(`TURNS.md:   ${turnsPath}`)
  console.log(`Evidence:   ${evidenceRoot}`)
} finally {
  await sandbox.cleanup()
  if (browser) await browser.close()
}

function readErrorsJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) } catch { return null }
    })
    .filter(Boolean)
}
