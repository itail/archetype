# examples/coder-agent

A minimal, runnable reference app for building **code-writing personas** on
top of archetype. Use this as the starting point when you need an agent that
reads files, writes code, runs a build, boots a local server, and verifies
its own work in a real browser.

## What it demonstrates

In ~200 lines of `index.mjs`, a single persona:

1. writes HTML/CSS/JS files into a fresh workspace (`writeFile` / `editFile`)
2. builds the artifact (`runBuild` — copies the workspace to `dist/`)
3. boots a local static server (`runStart` — returns an origin)
4. opens the live page in a headless browser (`browserOpen`)
5. interacts with it (`browserClick`)
6. captures a screenshot (`browserScreenshot`)
7. finishes with an honest outcome (`finishAttempt`)

The task: **build a click counter at `index.html` that increments on button
press, then verify the click handler by actually clicking and screenshotting.**

The persona decides the sequence. The harness does not prescribe a plan.

## What archetype gives you vs. what you still own

| Concern                                | Lives in                                     |
| -------------------------------------- | -------------------------------------------- |
| 19 action contracts (readFile, …)      | `archetype/builder` → `coderActions`         |
| Confined execution                     | `archetype/builder` → `SrtSandbox`           |
| Playwright harness                     | `archetype/builder` → `PlaywrightBrowser`    |
| Action → side-effect dispatch          | `archetype/builder` → `executeCoderAction`   |
| Per-turn error + diagnostic files      | `archetype/observability` → `createTurnReporter` |
| TURNS.md renderer                      | `archetype/observability` → `renderRunMarkdown` |
| Multi-turn loop (history, stalls, …)   | `archetype` → `runAutonomousLoop`            |
| **Preset layer** (`runBuild`/`runStart` semantics) | `sandbox-preset.mjs` (this example) |
| **Toolchain scripts** (static-build, serve) | `toolchain/*.mjs` (this example)        |
| **Task brief + persona identity**      | `index.mjs` (this example)                   |

Anything consumer-specific stays in the example. Anything generic moved
into the SDK.

## Layout

```
examples/coder-agent/
├── README.md              ← you are here
├── index.mjs              ← persona + runAutonomousLoop wiring (read first)
├── persona.mjs            ← the PersonaConfig factory (shared by index + audit)
├── audit.mjs              ← runs auditPersona against the config (no turns)
├── sandbox-preset.mjs     ← CoderAgentSandbox: runBuild + runStart over SrtSandbox
├── toolchain/
│   ├── static-build.mjs   ← copies workspace → dist
│   └── static-serve.mjs   ← static HTTP server; prints `READY <origin>`
└── .runs/<timestamp>/     ← per-run output (created on first run)
    ├── workspace/         ← the persona's fresh workspace
    ├── dist/              ← build output
    ├── evidence/          ← SRT settings snapshots + screenshots
    ├── errors.jsonl       ← written by createTurnReporter
    ├── diagnostics.md     ← written by createTurnReporter
    └── TURNS.md           ← written by renderRunMarkdown
```

## Prerequisites

Two runtime dependencies live outside archetype — hosts install them:

- `playwright` — headless chromium for the browser harness
- `@anthropic-ai/sandbox-runtime` — the `srt` binary `SrtSandbox` wraps

Install them anywhere npm will resolve them from this directory (the repo
root, the `archetype/` workspace, or here). The example uses `createRequire`
to locate `srt` via `@anthropic-ai/sandbox-runtime/package.json`, and
archetype uses a dynamic `import('playwright')` for the browser harness.

You'll also need chromium itself the first time:

```bash
npx playwright install chromium
```

## Run it

From the archetype repo root:

```bash
npm run build  # compile the SDK into dist/
GEMINI_API_KEY=... node examples/coder-agent/index.mjs
```

Environment overrides:

- `GEMINI_MODEL` — defaults to `gemini-3.5-flash`
- `MAX_TURNS` — defaults to `25`
- `SRT_BINARY` — override the resolved path to the `srt` CLI

On completion the script prints:

```
Outcome:    success | blocked | failed
Summary:    <model-provided>
Run root:   .../.runs/<timestamp>
TURNS.md:   .../.runs/<timestamp>/TURNS.md
Evidence:   .../.runs/<timestamp>/evidence
```

## Audit the persona

Before running a live turn, check the persona structurally — step 1 of
archetype's default debugging loop (see `archetype/DEBUGGING_LOOP.md`):

```bash
GEMINI_API_KEY=... node examples/coder-agent/audit.mjs    # scope: full (incl. LLM reviewer)
node examples/coder-agent/audit.mjs                       # scope: static-plus-scenario
```

Both forms currently return `pass: true, 0 errors`. `persona.mjs` is the
single source of truth — `index.mjs` and `audit.mjs` both build their
config from it, so fixing a finding updates both surfaces.

## Read these first when extending

- `index.mjs` — start here. Every line is either persona config, sandbox
  wiring, or a `runAutonomousLoop` hook. No hidden state.
- `archetype/src/builder/actions.ts` — the 19 action contracts the model
  sees. Pick the subset your persona needs via object spread.
- `archetype/src/builder/executor.ts` — what `executeCoderAction` actually
  does per action. Returns `null` for action names outside the coder
  surface so the host can dispatch its own actions alongside.
- `archetype/CLAUDE.md` (the "Builder agents" section) — the composition
  pattern in prose.

## What's intentionally NOT in this example

Keep the reference pattern readable — don't add these until the task demands
them:

- judge-based evaluation / customer scoring
- multi-agent orchestration (delegates, CEO personas, peer consultation)
- retries, gating ladders, action-filtering
- evidence revision tracking or run-record book-keeping
- `runTests` / `runLint` / `runInstall` presets (the counter task doesn't
  exercise them)

Every additional knob hides the reference pattern from new readers.
