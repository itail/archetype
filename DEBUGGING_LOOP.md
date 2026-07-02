# The Default Debugging Loop

When a persona misbehaves, follow this loop in order. Each step answers a different question; don't skip ahead. Three tools, three roles.

```
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │   1. auditPersona         What's structurally wrong?        │
  │         ↓                 (config, prompt shape, memories)  │
  │                                                             │
  │   2. dumpPromptForReview  What is the LLM actually seeing?  │
  │         ↓                 (eyeball the exact packet)        │
  │                                                             │
  │   3. auditTraceIntegrity  Is the pipeline lying?            │
  │                           (silent drops, silent repairs)    │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

## Step 1 — `auditPersona`

**Question:** is anything structurally wrong with the config, assembled prompt, or memories?

Start every debugging session here. One call, unified report across every audit Archetype ships.

```typescript
import { auditPersona, printAuditReport } from '@itaila/archetype'
import { MY_PERSONA_CONFIG } from '../src/persona' // see "Prerequisites" below

async function main() {
  const result = await auditPersona({
    config: MY_PERSONA_CONFIG,
    // Scenario context — unlocks entity-visibility, prompt-content,
    // load-bearing-invariants. Skip these only if you genuinely don't
    // have a representative context yet.
    context: { /* what your app passes to chat() */ },
    memories: [ /* memories the persona would see */ ],
    // Optional — pass a brain.md string, or omit and auditPersona will
    // synthesize one from config.methodology / config.directives /
    // config.voice.formatting so brain-* audits still run.
    brain: readFileSync('./brains/mine.md', 'utf8'),
    // Optional — unlocks the LLM meta-judges. Worth running at least
    // once per meaningful prompt change.
    apiKey: process.env.GEMINI_API_KEY,
    scope: 'full',
  })

  // One-liner renderer + exit code. Use formatAuditReport() if you want
  // the string for logs or CI artifacts without writing to stdout.
  printAuditReport(result, { title: 'MyPersona audit', exitOnFail: true })
}

main().catch((err) => { console.error(err); process.exit(1) })
```

### Prerequisites

Two tripwires worth knowing before writing this script:

1. **Export your PersonaConfig as a named constant** (or return it from a pure, side-effect-free factory). Configs declared as local `const` inside `createPersona()` can't be reached from an audit script without booting the adapter/persistence layer. Pattern:

   ```typescript
   export const MY_PERSONA_CONFIG: PersonaConfig = { /* ... */ }

   export function createMyPersona() {
     return withStorage(definePersona(MY_PERSONA_CONFIG), { adapter: ... })
   }
   ```

   Escape hatch: `ManagedPersona.engine.config` exposes the underlying config if refactoring isn't possible — but a named constant is the cleaner contract.

2. **Archetype is an ESM-only package.** If your app's `package.json` doesn't have `"type": "module"` (common for Next.js apps), Node will reject `import 'archetype'` with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Two fixes:
   - Give the audit script an ESM scope: add `scripts/package.json` with `{ "type": "module" }`, or rename to `.mts`.
   - But **if your app's source files are also CJS** (no root `"type": "module"`), the ESM script still can't import named exports from them. In that case either (a) add `"type": "module"` to the app root, or (b) duplicate the minimal config literal in the audit script.

`scope` gates what runs:
- `'static'` — config-only. Always safe. Fast.
- `'static-plus-scenario'` (default) — adds audits that need context + memories.
- `'full'` — adds LLM meta-judges. Requires `apiKey`. Costs Gemini calls.

The report's `auditsSkipped` tells you which audits didn't run and why. Use that list to figure out what inputs you need to add for full coverage.

**Reporter helpers:** `formatAuditReport(result, { title })` returns the string shown above; `printAuditReport(result, { title, exitOnFail })` logs it and sets the exit code. Every app used to hand-roll this renderer — it now lives in the SDK.

**What it catches:**
- Prescriptive brain content, trigger-response mapping, rule-density (`brain-prescriptions`)
- Oversized brain sections (`brain-bloat`)
- Brain content duplicating entity descriptions or EQ flags (`cross-layer-duplicates`)
- Ambiguous or generic action/entity names, vague schemas (`action-contracts`)
- Entity declared updatable but no record surface in context (`entity-visibility`)
- Missing keystone phrases or section order issues in the assembled prompt (`prompt-content`)
- Load-bearing invariants dropped from the prompt (`load-bearing-invariants`)
- Signal-dilution, negative-identity, conflicting-instructions, and 8+ other keystone violations via LLM judge (`prompt-audit`) — when `scope: 'full'`
- Persona reading its own prompt and flagging what feels boxed, underspecified, or contradicted (`brain-reflection`) — when `scope: 'full'`

## Step 2 — `dumpPromptForReview`

**Question:** what is the LLM actually reading?

When Step 1 flags something you can't explain, or behavior is off and Step 1 is clean, pull the full assembled prompt and read it directly. Often the bug is visible in 30 seconds of scrolling.

```typescript
import { dumpPromptForReview } from '@itaila/archetype'

const dumped = dumpPromptForReview(myPersona.config, {
  message: "the user's message on the turn that went wrong",
  history: [ /* turns leading up to this */ ],
  context: { /* what the app passed */ },
  memories: [ /* what the app passed */ ],
  timezone: 'UTC',
})

// The `artifact` field is a single formatted string ready to paste into
// an AI reviewer, attach to a bug report, or diff across two runs.
console.log(dumped.artifact)
```

**Use cases:**
- Pasting into Claude/GPT/etc. for a second-opinion review (this is what AI coding agents do best — subtle signal dilution, contradictions, confusing framings).
- Diffing two runs to see what changed between a working and broken configuration.
- Attaching to bug reports so others don't have to reconstruct the packet.

### During long runs: `createPromptTraceRecorder`

If you're running a benchmark, the one-shot dump isn't enough — you want every turn recorded automatically. Wire the recorder into `runAutonomousLoop`'s `onBeforeChat` hook:

```typescript
import { createPromptTraceRecorder, runAutonomousLoop } from '@itaila/archetype'

const recorder = createPromptTraceRecorder({
  outDir: './run-123/prompt-traces',
  traceGroup: 'solo-builder',     // optional subfolder
  format: 'both',                  // 'json' | 'artifact' | 'both'
})

await runAutonomousLoop({
  /* ... your loop config ... */
  hooks: {
    onBeforeChat: recorder.onBeforeChat,
    /* ... other hooks ... */
  },
})

// Files written as: <outDir>/<traceGroup>/turn-01-initial-attempt-1.json
// (and .txt when format includes 'artifact')
```

For hand-rolled benchmark harnesses that don't use `runAutonomousLoop`, use `recorder.record()` after each turn.

## Step 3 — `auditTraceIntegrity`

**Question:** is the pipeline itself silently dropping, repairing, or swallowing anything?

This is the floor. When Steps 1 and 2 look clean but behavior is wrong, or when you just want to be sure the trace you're inspecting is honest, run this.

```typescript
import { auditTraceIntegrity } from '@itaila/archetype'

const result = await myPersona.chat({ /* ... */ })
const integrity = auditTraceIntegrity(result.trace)

if (!integrity.pass) {
  for (const finding of integrity.findings) {
    console.error(`[${finding.severity}] ${finding.principle}: ${finding.message}`)
  }
}
```

**Invariants checked:**
- Parse failures must be named in `errors` (no silent "failed to parse")
- Repair attempts must record their outcome (`repairSucceeded` defined)
- Failed repairs must leave a repair-related entry in `errors`
- Every invalid action, invalid crud, failed execution, failed domainAction has an error explanation
- Status enums are respected (no spurious values)

**Recommended:** wire this into your integration tests. Every trace produced by a test run should pass `auditTraceIntegrity`. That's how you guarantee the audit mechanism's own foundation stays clean as the engine evolves.

```typescript
// In your integration tests:
it('trace is honest', async () => {
  const result = await persona.chat({ /* ... */ })
  const integrity = auditTraceIntegrity(result.trace)
  expect(integrity.pass).toBe(true)
})
```

## When to use which

| Symptom | Start with |
|---|---|
| "I don't know if my persona is well-shaped" | Step 1 (`auditPersona`) |
| "The AI is confused / contradicting itself" | Step 1 + scope `'full'` |
| "The audit is clean but the AI is still misbehaving" | Step 2 (`dumpPromptForReview`) |
| "The judge scores look wrong" | Step 2 + Step 3 (maybe the trace is lying) |
| "An action the AI emitted never made it to my handler" | Step 3 (`auditTraceIntegrity`) |
| "I want per-turn review artifacts from a benchmark run" | Step 2 (`createPromptTraceRecorder`) |
| "I want CI to fail when the persona drifts" | Step 1 in CI; Step 3 in integration tests |

## The anti-pattern

Don't hand-compose audits per persona. Every project writes its own `audit-v3.ts` that runs 4 of the 10 audits, misses the newer ones, and silently lags whenever Archetype ships a new audit. That's the exact problem `auditPersona` exists to solve — one call, all audits, no drift.
