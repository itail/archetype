/**
 * Audit the PM spec-agent sample.
 *
 * This should be the first check before a live PM run: it verifies the
 * assembled focus prompt has the work item, work history, file state, and
 * action contracts the agent will actually see.
 *
 * Usage:
 *   node examples/pm-spec-agent/audit.mjs
 *   GEMINI_API_KEY=... node examples/pm-spec-agent/audit.mjs
 */
import {
  auditPersona,
  createPmSpecWorkItem,
  dumpPromptForReview,
  printAuditReport,
} from 'archetype'
import { createPmPersonaConfig } from './persona.mjs'

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }
const config = createPmPersonaConfig({ provider: mockProvider })
const context = {
  workItem: createPmSpecWorkItem({
    artifactName: 'The Last Lantern Spec Bundle',
    primaryGoal: 'Engineering can start the first playable slice and plan the remaining work without a rescue meeting.',
    constraints: [
      'Keep the game buildable as an eight-hour narrative adventure.',
      'Keep the bundle coherent across product, systems, narrative, UX, technical handoff, and delivery plan.',
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
  workHistory: ['turn 0 · world: Fresh workspace. No spec files exist yet.'],
  files: ['00-input/benchmark-brief.md — 31 lines, 1512 bytes'],
}

const apiKey = process.env.GEMINI_API_KEY
const scope = apiKey ? 'full' : 'static-plus-scenario'
const result = await auditPersona({
  config,
  context,
  promptMode: 'focus',
  apiKey,
  scope,
})

printAuditReport(result, { title: `examples/pm-spec-agent persona (scope=${scope})` })

const dumped = dumpPromptForReview(config, {
  message: 'Continue the focused PM run.',
  context,
  history: [],
  timezone: 'UTC',
  promptMode: 'focus',
  contractStyle: 'lean',
})

console.log('\nPrompt preview:')
console.log(dumped.artifact.slice(0, 4000))

const errs = result.findings.filter(f => f.severity === 'error').length
console.log(`\n==> errors: ${errs}, pass: ${result.pass}`)
process.exit(errs > 0 ? 1 : 0)
