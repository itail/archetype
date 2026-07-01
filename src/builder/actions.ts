/**
 * Coder-persona action primitives.
 *
 * Standard action contracts (name + description + schema + confidence)
 * for building coder-style agents on top of archetype. These are the
 * actions the LLM sees; implementations live alongside a concrete
 * `Sandbox` + `BrowserHarness` (see archetype/builder/sandbox.ts and
 * archetype/builder/browser.ts — both coming in the next promotion
 * steps).
 *
 * Consumers pick which actions to compose into their persona. A Python
 * builder might use {readFile, writeFile, applyPatch, runCommand}; a
 * browser-game builder might use all of these. Object spread is the
 * composition primitive.
 *
 * ──────────────────────────────────────────────────────────────────
 * Design choices worth naming:
 *
 * 1. `rationale` is optional on every action. The model never writes
 *    anything useful there today — it repeats the `message` field.
 *    Kept for backward-compat; likely removable in a future pass.
 *
 * 2. `writeFile` and `applyPatch` are complementary file mutation
 *    primitives. `writeFile` is for creating or replacing a whole file when
 *    the model knows the desired complete content. `applyPatch` is for
 *    targeted edits to existing files whose exact current context is known.
 *    If exact current file content is not already in the prompt, `readFile`
 *    is the context-loading primitive. Both return compact factual outcomes;
 *    raw file bodies belong in audit, not future prompt history.
 *
 * 3. `applyPatch` accepts one git-style unified diff patch and applies it
 *    atomically. One `applyPatch` call is one transaction; multiple
 *    `applyPatch` actions in the same turn are sequential durable steps,
 *    not one hidden transaction.
 *
 * 4. `runCommand` is the generic argv execution primitive (pi's
 *    `bash` equivalent). It exists so consumers don't need to add
 *    special-cased run* tools for every build system / test runner.
 *    For recurring shapes (npm ci, static build, node --test, etc.)
 *    consumers can layer their own thin wrappers.
 *
 * 5. `browserClick` takes EITHER `text` OR `selector`. Text-match is
 *    primary because models think about UIs in human terms; selectors
 *    are the escape hatch when text is ambiguous. Implementations try
 *    text first and fall through to selector only if text is missing
 *    or fails — both paths must be truthful about which mode matched.
 *
 * 6. `browserType` is for literal-text input; `browserKey` is for
 *    named-key presses (ArrowUp, Enter, Escape, a-z, etc). Split
 *    because mixing them led to hallucination — a model asked for
 *    "keyboardType 'ArrowUp'" when it meant "press ArrowUp." The two
 *    verbs are mechanically different (type = key-by-key characters,
 *    key = one keydown+keyup).
 */
import { z } from 'zod'
import type { ActionDefinition } from '../types.js'
import { returnToSessionAction } from '../core/focus-mode-actions.js'
export { returnToSessionAction } from '../core/focus-mode-actions.js'

const rationale = z.string().optional()

// ─── File I/O ─────────────────────────────────────────────────────

export const readFileAction: ActionDefinition = {
  description: 'Read file contents. Use paths exactly as shown in FILES. In mounted workspaces, paths include their visible mount prefix, such as input/brief.md or artifact/index.html. FILES shows whether each mount is writable or read-only.',
  confidence: 'low',
  schema: z.object({
    path: z.string().min(1),
    rationale,
  }),
}

export const writeFileAction: ActionDefinition = {
  description:
    'Create or overwrite a whole file when you know the desired complete content. The result confirms the path and size; exact file content is not carried into future history.',
  confidence: 'low',
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
    rationale,
  }),
}

export const applyPatchAction: ActionDefinition = {
  description:
    'Apply one git-style unified diff patch inside the workspace write surface shown in FILES. Use this for targeted edits when the exact current file context is already in your prompt. If you need to change existing text and the exact current file content is not in your prompt, consider readFile first; its result is added to your next prompt. Otherwise you are guessing context and the patch may fail next turn. One applyPatch call is one atomic file transaction: if any file/hunk in that patch cannot apply, no files from that patch are changed and the outcome explains the failed contract. You may use multiple applyPatch actions in one turn for independent durable steps; an earlier successful applyPatch remains applied if a later applyPatch fails. Put edits that must stay consistent in the same patch. Split edits into separate applyPatch actions when earlier work should remain useful even if a later independent edit fails. Use paths exactly as shown in FILES; in mounted workspaces, include the visible mount prefix such as artifact/index.html. Paths outside the write surface return a factual failure outcome.',
  confidence: 'low',
  schema: z.object({
    patch: z.string().min(1).describe('Git-style unified diff patch. The patch may create, edit, or delete files. Old context lines must match current file contents.'),
    rationale,
  }).strict(),
  exampleParams: {
    patch: 'diff --git a/<path> b/<path>\n--- a/<path>\n+++ b/<path>\n@@ -1 +1 @@\n-old\n+new\n',
  },
}

export const editFileAction: ActionDefinition = {
  description:
    'Replace exact current file text. oldText must match the current file contents exactly. If the exact text you want to replace is not in your prompt, consider readFile first; its result is added to your next prompt. Otherwise you are guessing context and the edit may fail next turn. Supports one or many edits in a single atomic call: if any edit misses, no edits are applied. If oldText appears more than once, set occurrence to the 1-based match to replace.',
  confidence: 'low',
  schema: z.object({
    path: z.string().min(1),
    edits: z
      .array(
        z.object({
          oldText: z.string().min(1),
          newText: z.string(),
          occurrence: z.number().int().positive().optional(),
        }),
      )
      .min(1),
    rationale,
  }),
}

export const deleteFileAction: ActionDefinition = {
  description: 'Delete a file.',
  confidence: 'low',
  schema: z.object({
    path: z.string().min(1),
    rationale,
  }),
}

export const listFilesAction: ActionDefinition = {
  description:
    'List workspace file paths and sizes under a directory (defaults to the workspace root).',
  confidence: 'low',
  schema: z.object({
    path: z.string().optional(),
    rationale,
  }),
}

export const searchInFilesAction: ActionDefinition = {
  description:
    'Regex-search across workspace files. Returns file:line:text for each match.',
  confidence: 'low',
  schema: z.object({
    pattern: z.string().min(1),
    pathGlob: z.string().optional(),
    rationale,
  }),
}

// ─── Sandbox execution ────────────────────────────────────────────

export const runInstallAction: ActionDefinition = {
  description:
    "Runs `npm ci` against package-lock.json inside the workspace. Skipped if no package-lock.json exists — plain HTML/CSS/JS artifacts don't need it.",
  confidence: 'low',
  schema: z.object({ rationale }),
}

export const runBuildAction: ActionDefinition = {
  description: "Produce the shippable artifact in dist/ using the host's build preset.",
  confidence: 'low',
  schema: z.object({ rationale }),
}

export const runTestsAction: ActionDefinition = {
  description:
    "Runs Node's built-in test runner (`node --test`) on standard workspace test files, including test.js, test/**/*.js, tests/**/*.js, *.test.js, and *.spec.js variants for js/mjs/cjs. When the workspace has no package.json, the harness creates a temporary package boundary and infers module vs CommonJS from the discovered test files. Tests execute in a Node.js process — browser APIs (document, window, localStorage, fetch) are undefined there. Node tests can only inspect game/app state that the artifact exports, imports, or explicitly attaches to globalThis/window; top-level browser-script locals are not test-visible by magic. In ES module tests, static imports execute before test-file setup, so install globals before loading browser code by using dynamic `await import(...)` when module-load code reads document/window/localStorage. To exercise browser behavior, runStart and then use whichever browser actions this persona exposes.",
  confidence: 'low',
  schema: z.object({ rationale }),
}

export const runLintAction: ActionDefinition = {
  description:
    "Runs ESLint with the host's fixed ruleset on workspace *.js / *.mjs files. Project ESLint config files do not change this action. Flags syntactic issues; does not verify runtime behavior.",
  confidence: 'low',
  schema: z.object({ rationale }),
}

export const runStartAction: ActionDefinition = {
  description:
    'Starts a local static HTTP server rooted at the workspace. Returns the URL to pass into browserOpen. Treat the workspace directory as the live document root.',
  confidence: 'low',
  schema: z.object({ rationale }),
}

export const runCommandAction: ActionDefinition = {
  description:
    "Executes an arbitrary argv array inside the same canonical workspace path world shown in FILES. In mounted workspaces, cwd contains visible mount directories such as input/, spec/, and artifact/; use those exact paths in shell commands too. Same confinement as runBuild/runTests: workspace-only fs, no network, 120s timeout. Returns stdout, stderr, exit code, and a compact changed-file summary when the command mutates workspace files. The argv first entry `node` maps to the trusted Node binary. Use this when the fixed runBuild/runTests semantics don't fit — e.g. you wrote your own test harness with a DOM shim and want to run it.",
  confidence: 'low',
  schema: z.object({
    command: z.array(z.string()).min(1),
    rationale,
  }),
}

// ─── Browser interaction ──────────────────────────────────────────

export const browserOpenAction: ActionDefinition = {
  description:
    'Open or reload the local app in the browser. `path` may be a served URL path such as `/` or `/src/index.html`, or a visible file path from FILES when that file is in the live document root. After file changes, call browserOpen again before checking the updated page.',
  confidence: 'low',
  schema: z.object({
    path: z.string().optional(),
    rationale,
  }),
}

export const browserScreenshotAction: ActionDefinition = {
  description: 'Capture a browser screenshot.',
  confidence: 'low',
  schema: z.object({
    label: z.string().optional(),
    rationale,
  }),
}

export const browserClickAction: ActionDefinition = {
  description:
    'Click an element in the live browser. Pass `text` to match by visible text (primary), or `selector` for a CSS selector fallback.',
  confidence: 'low',
  schema: z.object({
    text: z.string().optional(),
    selector: z.string().optional(),
    rationale,
  }),
}

export const browserTypeAction: ActionDefinition = {
  description:
    'Type literal text into the currently focused element (or a selector you pass). Sends key-by-key via playwright keyboard.type so game/form handlers fire. Use for text input fields, not for named keys (see browserKey).',
  confidence: 'low',
  schema: z.object({
    text: z.string().min(1),
    selector: z.string().optional(),
    rationale,
  }),
}

export const browserKeyAction: ActionDefinition = {
  description:
    'Press a single named key (ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Escape, Tab, Space, a-z, 0-9, etc). Sends keydown+keyup once via playwright keyboard.press, so a game keyboard handler listening for "keydown" fires once.',
  confidence: 'low',
  schema: z.object({
    key: z.string().min(1),
    selector: z.string().optional(),
    rationale,
  }),
}

export const browserConsoleAction: ActionDefinition = {
  description: 'Read browser console output.',
  confidence: 'low',
  schema: z.object({ rationale }),
}

// ─── Completion ───────────────────────────────────────────────────

export const finishAttemptAction: ActionDefinition = {
  description: 'Record this persona\'s status for the active work item/session as complete, blocked, or failed with an honest summary. When finishing, include your own expert self-review against the active request, source context, and produced work; if that review says the work is not yet good enough, continue working instead of calling this. This is the persona\'s own handoff/status claim; the runtime records it and returns control to the normal turn flow.',
  confidence: 'low',
  schema: z.object({
    outcome: z.enum(['success', 'blocked', 'failed']),
    summary: z.string().min(1),
  }),
}

// ─── Grouped export for ergonomic consumption ─────────────────────

/**
 * Default coder-persona action contracts, keyed by name. Pick the subset
 * your persona needs via object spread:
 *
 *     actions: {
 *       ...({ readFile: coderActions.readFile,
 *             writeFile: coderActions.writeFile,
 *             applyPatch: coderActions.applyPatch,
 *             runCommand: coderActions.runCommand }),
 *     }
 *
 * Legacy editFile/deleteFile action definitions remain exported by name for
 * trace replay and explicit compatibility. `writeFile` remains first-class:
 * whole-file writes and targeted patches are different expert moves.
 */
export const coderActions = {
  readFile: readFileAction,
  writeFile: writeFileAction,
  applyPatch: applyPatchAction,
  listFiles: listFilesAction,
  searchInFiles: searchInFilesAction,
  runInstall: runInstallAction,
  runBuild: runBuildAction,
  runTests: runTestsAction,
  runLint: runLintAction,
  runStart: runStartAction,
  runCommand: runCommandAction,
  browserOpen: browserOpenAction,
  browserScreenshot: browserScreenshotAction,
  browserClick: browserClickAction,
  browserType: browserTypeAction,
  browserKey: browserKeyAction,
  browserConsole: browserConsoleAction,
  returnToSession: returnToSessionAction,
  finishAttempt: finishAttemptAction,
} as const satisfies Record<string, ActionDefinition>

export type CoderActionName = keyof typeof coderActions
