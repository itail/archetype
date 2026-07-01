/**
 * Audit the coder-agent persona.
 *
 * Step 1 of archetype's default debugging loop (see DEBUGGING_LOOP.md):
 * structural checks on the persona config + assembled prompt before
 * running a single turn. Set GEMINI_API_KEY to include the LLM
 * reviewer (scope: 'full'); without it, runs static-only.
 *
 * Usage:
 *   GEMINI_API_KEY=... node audit.mjs
 */
import { auditPersona, printAuditReport } from 'archetype'
import { createCoderPersonaConfig } from './persona.mjs'

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }
const config = createCoderPersonaConfig({ provider: mockProvider })

const apiKey = process.env.GEMINI_API_KEY
const scope = apiKey ? 'full' : 'static-plus-scenario'

const result = await auditPersona({
  config,
  // Representative turn input — the initial task brief.
  context: {
    task: {
      brief: 'Build a click counter at index.html that increments on button press. Verify by clicking and screenshotting a non-zero counter.',
      workspaceRoot: '(fresh workspace)',
    },
  },
  // Match the runtime: the autonomous loop passes promptMode: 'focus' so
  // the assembled prompt the audit sees matches what the model actually reads.
  promptMode: 'focus',
  apiKey,
  scope,
})

printAuditReport(result, { title: `examples/coder-agent persona (scope=${scope})` })

const errs = result.findings.filter(f => f.severity === 'error').length
const warns = result.findings.filter(f => f.severity === 'warn').length
console.log(`\n==> errors: ${errs}, warns: ${warns}, pass: ${result.pass}`)
process.exit(errs > 0 ? 1 : 0)
