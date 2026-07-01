/**
 * Coder-action executor — the dispatch layer that turns a parsed
 * `{ name, params }` action (from an archetype persona) into real
 * side-effects against a workspace, sandbox, and browser harness.
 *
 * The persona's LLM sees the contracts from `./actions.ts`; this module
 * is what happens when it fires one. Architecture:
 *
 *   ┌──────────────────────────────┐
 *   │  persona.chat → actions      │
 *   └──────────────┬───────────────┘
 *                  │
 *                  ▼
 *   ┌──────────────────────────────┐
 *   │  executeCoderAction(action)  │ ← this module
 *   │  ───────────────────────────  │
 *   │  fs ops    → workspaceRoot   │
 *   │  runTool   → CoderSandbox    │
 *   │  browser*  → BrowserHarness  │
 *   └──────────────┬───────────────┘
 *                  │
 *                  ▼
 *   ┌──────────────────────────────┐
 *   │  CoderActionResult           │
 *   │  historyNote + log + hints   │
 *   └──────────────────────────────┘
 *
 * Contract:
 *   • Return `null` when the action name is not a coder primitive — the
 *     host dispatches it on its own (benchmark-specific actions like
 *     markMilestone, createRole, sendInternalMemo, etc).
 *   • Return a `CoderActionResult` otherwise. The structured hints
 *     (`mutatedArtifact`, `capturedScreenshot`, `liveOrigin`,
 *     `sandboxToolCall`) let the host evolve its own book-keeping
 *     (metrics, evidence state, browser lifecycle) without this module
 *     knowing anything about benchmark internals.
 *
 * What belongs here:
 *   • File I/O (read/applyPatch/list/search) against workspaceRoot
 *   • Sandbox dispatch (runCommand + runTool)
 *   • Browser dispatch (open / click / type / key / screenshot / console)
 *   • Legacy write/edit/delete replay support for older traces.
 *
 * What does NOT belong here:
 *   • Benchmark metrics (toolCallsUsed, etc.)
 *   • Evidence revision tracking
 *   • Browser lifecycle (constructing BrowserHarness from a new origin
 *     — exposed via `liveOrigin` for the host to act on)
 *   • executionLog accumulation (the host builds trace output from
 *     `log` strings however it wants)
 *
 * Node-only: uses `node:fs` for file operations.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type {
  BrowserHarness,
} from './browser.js'
import type { ChatAttachment, ParsedAction, TurnLedgerActionOutcome } from '../types.js'
import type { SandboxExecResult, SandboxSpawnResult } from './sandbox.js'
import {
  listWorkspaceMountFileEntries,
  resolveWorkspaceMountPath,
  type WorkspaceMount,
} from './workspace-files.js'

// ─── Public types ────────────────────────────────────────────────────

/**
 * The minimum sandbox surface the executor needs. Hosts can implement
 * this directly over archetype's `Sandbox` (via SrtSandbox.exec) or
 * wrap it with their own preset layer (foundry's BenchmarkSandboxExecutor).
 */
export interface CoderSandbox {
  /**
   * Execute an arbitrary argv inside the sandbox. Maps to the model's
   * `runCommand` action.
   */
  runCommand(input: {
    command: string[]
    timeoutMs?: number
    /** Optional command cwd. Mounted workspaces use a canonical visible cwd. */
    cwd?: string
    /** Additional readable paths needed by the command cwd. */
    extraReadPaths?: string[]
    /** Additional writable paths needed by the command cwd. */
    extraWritePaths?: string[]
  }): Promise<SandboxExecResult>
  /**
   * Execute a named preset tool (runInstall, runBuild, runTests, runLint,
   * runStart). The host owns what each preset means; this module just
   * forwards the name it received from the model. runStart resolves with
   * `origin` so the host knows the live URL.
   */
  runTool(name: CoderSandboxToolName, input?: {
    /** Optional command cwd. Mounted workspaces use a canonical visible cwd. */
    cwd?: string
    /** Additional readable paths needed by the command cwd. */
    extraReadPaths?: string[]
    /** Additional writable paths needed by the command cwd. */
    extraWritePaths?: string[]
  }): Promise<CoderSandboxToolResult>
}

export type CoderSandboxToolName =
  | 'runInstall'
  | 'runBuild'
  | 'runTests'
  | 'runLint'
  | 'runStart'

export interface CoderSandboxToolDocumentation {
  /**
   * Human-facing command equivalent for docs/handoffs. Hosts should provide
   * this when a preset wraps hidden setup, absolute trusted binaries, or
   * sandbox-only paths that would otherwise make artifact instructions stale.
   */
  userFacingCommand?: string
  /**
   * Compact factual note about hidden preset setup that affects whether the
   * userFacingCommand is replayable outside the harness.
   */
  userFacingNote?: string
}

export type CoderSandboxToolResult =
  | (SandboxExecResult & CoderSandboxToolDocumentation)
  | (SandboxSpawnResult & { origin: string } & CoderSandboxToolDocumentation)

export interface CoderExecutorContext {
  /** Absolute path to the workspace root the persona operates in. */
  workspaceRoot: string
  /**
   * Optional virtual roots exposed to the persona, e.g.
   * [{prefix:"spec", root:"/tmp/spec", writable:false},
   *  {prefix:"artifact", root:"/tmp/artifact", writable:true}].
   * File actions understand these prefixes and report outcomes using the
   * same visible path, so hosts don't need to hand-roll spec/artifact routing.
   */
  workspaceMounts?: readonly WorkspaceMount[]
  /** Default mount for unprefixed file writes. Defaults to workspaceRoot. */
  defaultMountPrefix?: string
  /**
   * Visible mount that corresponds to the live browser document root.
   * Defaults to defaultMountPrefix when omitted. This stays separate from
   * defaultMountPrefix because a reviewer persona may write spec files by
   * default while opening a mounted artifact in the browser.
   */
  browserMountPrefix?: string
  /** Sandbox adapter the persona routes sandbox-tool calls through. */
  sandbox: CoderSandbox
  /** Live browser harness, or null if no local server is running yet. */
  browser: BrowserHarness | null
}

export interface CoderActionAttachment {
  type: 'image'
  mimeType: string
  data: string
}

export interface CoderActionContinuity {
  /**
   * Full result text shown on the immediately following turn.
   */
  resultText: string
  /**
   * How many future turns should continue seeing resultText before continuity
   * decays into staleText. Defaults to 1.
   */
  resultTurns?: number
  /**
   * What later turns should see after resultText ages out. If omitted,
   * resultText remains the durable outcome note.
   */
  staleText?: string
  /**
   * Short concrete anchors that should remain visible if the host audits or
   * trims the continuity payload.
   */
  auditAnchors?: string[]
}

const SMALL_WORKSET_RESULT_TURNS = 4

export interface CoderActionResult {
  /** Text for the next turn's user-input message. */
  historyNote: string
  /**
   * Canonical trace line for the host's run log (TURNS.md, etc). Block
   * shape already indented; host can embed directly.
   */
  log: string
  /** Hint: did the action mutate the artifact's shippable state? */
  mutatedArtifact?: boolean
  /** Hint: did the action produce a browser screenshot? */
  capturedScreenshot?: boolean
  /** Hint: runStart returned an origin. Host spins up its browser harness. */
  liveOrigin?: string
  /** Hint: this action was a sandbox-tool or runCommand call. */
  sandboxToolCall?: boolean
  /**
   * Raw exit code from sandbox-tool / runCommand calls. Set only when
   * `sandboxToolCall` is true. Hosts can use this to drive their own
   * pass/fail tracking without parsing the log string.
   */
  toolExitCode?: number
  /** Multimodal attachments (screenshot PNG). */
  attachments?: CoderActionAttachment[]
  /** First-class continuity payload for the next turn. */
  continuity?: CoderActionContinuity
  /** Mechanical outcome of the action. This is not quality judgment. */
  ok?: boolean
  /** Broad executor family for batch semantics and host telemetry. */
  kind?: CoderActionKind
  /** True when a same-turn action was not run because an earlier action failed. */
  skipped?: boolean
}

export type CoderActionKind = 'fileMutation' | 'read' | 'sandbox' | 'browser' | 'unhandled'

export interface CoderActionExecution<TAction extends { name: string; params: Record<string, unknown> } = { name: string; params: Record<string, unknown> }> {
  action: TAction
  result: CoderActionResult | null
}

/**
 * Return the text a host should carry into the immediately following
 * continuity surface for a coder action.
 *
 * Use this instead of reading `continuity.staleText` directly. `staleText`
 * is intentionally a later-turn tombstone; showing it immediately makes a
 * successful read/search look as if the result was already unavailable.
 */
export function immediateCoderActionOutcome(result: Pick<CoderActionResult, 'historyNote' | 'continuity'>): string {
  return result.continuity?.resultText ?? result.historyNote
}

/**
 * Return the compact factual note safe to share beyond the actor's private
 * workset. This preserves the important truth ("file X was written",
 * "edit failed", "console was read") without carrying large read/search
 * payloads into another participant's history.
 */
export function compactCoderActionOutcome(result: Pick<CoderActionResult, 'historyNote' | 'continuity' | 'toolExitCode'>): string {
  if (typeof result.toolExitCode === 'number' && result.toolExitCode !== 0) {
    return historyCoderActionOutcome(result, { maxBytes: 2400 })
  }
  return result.continuity?.staleText ?? immediateCoderActionOutcome(result)
}

/**
 * Return an outcome note suitable for stored chat history. Small factual
 * results stay attached to the narrative that caused them ("I will list" is
 * followed by the actual list result); large results decay to their compact
 * recovery note so history does not become a file-content cache.
 */
export function historyCoderActionOutcome(
  result: Pick<CoderActionResult, 'historyNote' | 'continuity'>,
  options: { maxBytes?: number } = {},
): string {
  const maxBytes = options.maxBytes ?? 1600
  const immediate = immediateCoderActionOutcome(result).trim()
  if (Buffer.byteLength(immediate, 'utf8') <= maxBytes) return immediate
  return result.continuity?.staleText ?? `${immediate.slice(0, maxBytes)}\n<truncated; run the action again if exact output is needed>`
}

export function coderActionOutcomeForLedger(
  action: Pick<ParsedAction, 'name' | 'params'>,
  result: Pick<CoderActionResult, 'historyNote' | 'continuity'>,
  options: { maxBytes?: number } = {},
): TurnLedgerActionOutcome {
  return {
    action,
    outcomeNote: historyCoderActionOutcome(result, options),
    resultText: result.continuity?.resultText,
    resultTurns: result.continuity?.resultTurns,
    staleText: result.continuity?.staleText,
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────

const SANDBOX_TOOL_NAMES: ReadonlySet<string> = new Set([
  'runInstall',
  'runBuild',
  'runTests',
  'runLint',
  'runStart',
])

/**
 * Execute one parsed coder action. Returns the structured result if the
 * name matches a coder primitive, or `null` if the host should dispatch
 * it (benchmark-specific actions like markMilestone).
 *
 * Never throws on user input — every failure is surfaced through the
 * `historyNote` + `log` strings so the model sees what went wrong.
 */
export async function executeCoderAction(input: {
  action: { name: string; params: Record<string, unknown> }
  context: CoderExecutorContext
}): Promise<CoderActionResult | null> {
  try {
    const result = await executeCoderActionUnchecked(input)
    return result ? normalizeCoderActionResult(input.action.name, result) : null
  } catch (error) {
    return failedCoderActionResult(input.action.name, error)
  }
}

/**
 * Execute a same-turn batch of coder actions with truthful continuity.
 *
 * The model chose every action in the batch before seeing any tool result
 * from that same batch. Successful actions remain durable facts; the model
 * chose a sequence, not one hidden turn-wide transaction. After any failure,
 * runTests and finishAttempt are skipped because their result would claim
 * verification/completion for a turn where some intended tool work failed.
 *
 * Unknown actions return `null` so hosts can dispatch them normally.
 */
export async function executeCoderActions<TAction extends { name: string; params: Record<string, unknown> }>(input: {
  actions: readonly TAction[]
  context: CoderExecutorContext
  onActionResult?(execution: CoderActionExecution<TAction>, context: CoderExecutorContext): Promise<void> | void
}): Promise<Array<CoderActionExecution<TAction>>> {
  const executions: Array<CoderActionExecution<TAction>> = []
  let failedThisTurn = false

  for (const action of input.actions) {
    if (failedThisTurn && shouldSkipAfterSameTurnFailure(action.name)) {
      executions.push({
        action,
        result: skippedAfterSameTurnFailureResult(action.name),
      })
      continue
    }

    const result = await executeCoderAction({ action, context: input.context })
    const execution = { action, result }
    executions.push(execution)

    await input.onActionResult?.(execution, input.context)

    if (!result) continue

    const failed = !coderActionSucceeded(action.name, result)
    if (failed) failedThisTurn = true
  }

  return executions
}

function normalizeCoderActionResult(actionName: string, result: CoderActionResult): CoderActionResult {
  const kind = result.kind ?? inferCoderActionKind(actionName)
  return {
    ...result,
    kind,
    ok: result.ok ?? inferCoderActionSuccess(actionName, result, kind),
  }
}

function inferCoderActionKind(actionName: string): CoderActionKind {
  if (isFileMutationAction(actionName)) return 'fileMutation'
  if (actionName === 'readFile' || actionName === 'listFiles' || actionName === 'searchInFiles') return 'read'
  if (actionName === 'runCommand' || SANDBOX_TOOL_NAMES.has(actionName)) return 'sandbox'
  if (actionName.startsWith('browser')) return 'browser'
  return 'unhandled'
}

function inferCoderActionSuccess(
  actionName: string,
  result: CoderActionResult,
  kind: CoderActionKind,
): boolean {
  if (typeof result.toolExitCode === 'number') return result.toolExitCode === 0
  if (kind === 'fileMutation') return result.mutatedArtifact === true
  if (actionName === 'browserScreenshot' && result.capturedScreenshot !== true) return false
  return true
}

function coderActionSucceeded(actionName: string, result: CoderActionResult): boolean {
  return normalizeCoderActionResult(actionName, result).ok === true
}

function isFileMutationAction(actionName: string): boolean {
  return actionName === 'applyPatch'
    || actionName === 'writeFile'
    || actionName === 'editFile'
    || actionName === 'deleteFile'
}

function shouldSkipAfterSameTurnFailure(actionName: string): boolean {
  return actionName === 'runTests' || actionName === 'finishAttempt'
}

function skippedAfterSameTurnFailureResult(actionName: string): CoderActionResult {
  const resultText = `${actionName} skipped — Error: didn't run because tools/actions failed this turn.`
  return {
    log: `- ${actionName}\n  skipped: tools/actions failed this turn`,
    historyNote: resultText,
    ok: false,
    kind: inferCoderActionKind(actionName),
    skipped: true,
    continuity: {
      resultText,
      auditAnchors: [actionName, 'skipped', 'tools/actions failed this turn'],
    },
  }
}

async function executeCoderActionUnchecked(input: {
  action: { name: string; params: Record<string, unknown> }
  context: CoderExecutorContext
}): Promise<CoderActionResult | null> {
  const { action } = input
  const { workspaceRoot, browser } = input.context
  const sandbox = input.context.sandbox

  if (action.name === 'readFile') {
    const targetPath = resolveCoderFilePath(input.context, String(action.params.path), { write: false })
    const relativePath = targetPath.visiblePath
    const target = targetPath.absolutePath
    const content = safeReadWorkspaceText(target)
    const rendered = renderReadFileContent(content)
    return {
      log: `- readFile: ${relativePath}\n  ${indent(rendered)}`,
      historyNote: `Tool result: readFile ${relativePath}\n${rendered}`,
      continuity: {
        resultText: `readFile ${relativePath}\n${rendered}`,
        resultTurns: SMALL_WORKSET_RESULT_TURNS,
        staleText: `<readFile result for ${relativePath} no longer carried in WORK HISTORY; read the file again only if exact contents are needed>`,
        auditAnchors: buildAuditAnchors(relativePath, rendered),
      },
    }
  }

  if (action.name === 'writeFile') {
    const targetPath = resolveCoderFilePath(input.context, String(action.params.path), { write: true })
    if (!targetPath.writable) return readonlyMountResult('writeFile', targetPath.visiblePath)
    const relativePath = targetPath.visiblePath
    const target = targetPath.absolutePath
    const contentString = String(action.params.content ?? '')
    const bytesWritten = Buffer.byteLength(contentString, 'utf8')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contentString, 'utf8')
    const resultText = [
      `writeFile ${relativePath}`,
      `Successfully wrote ${renderTextSize(contentString)}.`,
      'Exact file content is not carried in WORK HISTORY; use readFile if exact contents are needed.',
    ].join('\n')
    return {
      log: `- writeFile: ${relativePath} (${bytesWritten} bytes)`,
      historyNote: `Successfully wrote ${renderTextSize(contentString)} to ${relativePath}.`,
      mutatedArtifact: true,
      continuity: {
        resultText,
        resultTurns: SMALL_WORKSET_RESULT_TURNS,
        staleText: `writeFile ${relativePath}\nSuccessfully wrote ${renderTextSize(contentString)}. Exact file content is not carried in WORK HISTORY; read the file again only if exact contents are needed.`,
        auditAnchors: [relativePath],
      },
    }
  }

  if (action.name === 'applyPatch') {
    return executeApplyPatch({ action, context: input.context })
  }

  if (action.name === 'editFile') {
    const targetPath = resolveCoderFilePath(input.context, String(action.params.path), { write: true })
    if (!targetPath.writable) return readonlyMountResult('editFile', targetPath.visiblePath)
    return executeEditFile({ action, workspaceRoot: targetPath.root, visiblePath: targetPath.visiblePath, relativePath: targetPath.relativePath })
  }

  if (action.name === 'deleteFile') {
    const targetPath = resolveCoderFilePath(input.context, String(action.params.path), { write: true })
    if (!targetPath.writable) return readonlyMountResult('deleteFile', targetPath.visiblePath)
    const relativePath = targetPath.visiblePath
    const target = targetPath.absolutePath
    fs.rmSync(target, { force: true, recursive: true })
    return {
      log: `- deleteFile: ${relativePath}`,
      historyNote: `Successfully deleted ${relativePath}.`,
      mutatedArtifact: true,
      continuity: {
        resultText: `deleteFile ${relativePath}\nSuccessfully deleted the file.`,
        auditAnchors: [relativePath],
      },
    }
  }

  if (action.name === 'listFiles') {
    if (input.context.workspaceMounts?.length && (action.params.path == null || action.params.path === '.' || action.params.path === '')) {
      const mountedEntries = listWorkspaceMountFileEntries(input.context.workspaceMounts)
      const renderedMounted = mountedEntries.length > 0
        ? mountedEntries.map(entry => {
            const linePart = entry.lines == null ? 'binary/unknown lines' : `${entry.lines} lines`
            return `${entry.path} (${linePart}, ${entry.bytes} bytes)`
          }).join('\n')
        : '(empty)'
      return {
        log: `- listFiles: . (${mountedEntries.length} entries)\n  ${indent(renderedMounted)}`,
        historyNote: `Tool result: listFiles .\n${renderedMounted}`,
        continuity: {
          resultText: `listFiles .\n${renderedMounted}`,
          staleText: '<listFiles result for . removed from continuity; run listFiles again to inspect the current tree>',
          auditAnchors: buildAuditAnchors('.', renderedMounted),
        },
      }
    }
    const targetPath = resolveCoderFilePath(input.context, String(action.params.path ?? '.'), { write: false })
    const rel = targetPath.visiblePath || '.'
    const base = targetPath.absolutePath
    const entries: string[] = []
    const walk = (dir: string, prefix: string) => {
      let items: fs.Dirent[] = []
      try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      items.sort((a, b) => a.name.localeCompare(b.name))
      for (const it of items) {
        if (it.name.startsWith('.')) continue
        const full = path.join(dir, it.name)
        const relPath = prefix ? `${prefix}/${it.name}` : it.name
        if (it.isDirectory()) {
          entries.push(`${relPath}/`)
          walk(full, relPath)
        } else {
          let size = ''
          try { size = ` (${fs.statSync(full).size} bytes)` } catch { /* ignore */ }
          entries.push(`${relPath}${size}`)
        }
      }
    }
    walk(base, '')
    const rendered = entries.length > 0 ? entries.join('\n') : '(empty)'
    return {
      log: `- listFiles: ${rel} (${entries.length} entries)\n  ${indent(rendered)}`,
      historyNote: `Tool result: listFiles ${rel}\n${rendered}`,
      continuity: {
        resultText: `listFiles ${rel}\n${rendered}`,
        staleText: `<listFiles result for ${rel} removed from continuity; run listFiles again to inspect the current tree>`,
        auditAnchors: buildAuditAnchors(rel, rendered),
      },
    }
  }

  if (action.name === 'searchInFiles') {
    return executeSearchInFiles({ action, context: input.context })
  }

  if (action.name === 'runCommand') {
    const argv = Array.isArray(action.params.command)
      ? (action.params.command as string[]).map(String)
      : []
    const commandWorkspace = prepareRunCommandWorkspace(input.context)
    const beforeFiles = snapshotCoderWorkspaceFiles(input.context)
    const result = await sandbox.runCommand({
      command: argv,
      cwd: commandWorkspace.cwd,
      extraReadPaths: commandWorkspace.extraReadPaths,
      extraWritePaths: commandWorkspace.extraWritePaths,
    })
    const afterFiles = snapshotCoderWorkspaceFiles(input.context)
    const fileChanges = renderWorkspaceFileChanges(beforeFiles, afterFiles)
    const output = truncate([result.stdout, result.stderr].filter(Boolean).join('\n').trim(), 3000)
    const commandSummary = renderCommandSummary(argv)
    const resultText = [
      `runCommand ${commandSummary}`,
      `exit=${result.exitCode}`,
      output || '(no output)',
      fileChanges,
    ].filter(Boolean).join('\n')
    const staleText = fileChanges
      ? `runCommand ${commandSummary} completed with exit=${result.exitCode}.\n${fileChanges}`
      : `runCommand ${commandSummary} completed with exit=${result.exitCode}. Full output removed from continuity.`
    return {
      log: `- runCommand: ${JSON.stringify(argv)}\n  exit: ${result.exitCode}\n  output:\n${indent(output || '(no output)')}`,
      historyNote: `Tool result: ${resultText}`,
      sandboxToolCall: true,
      toolExitCode: result.exitCode,
      continuity: {
        resultText,
        staleText,
        auditAnchors: [commandSummary, `exit=${result.exitCode}`, ...(fileChanges ? ['Changed file state'] : [])],
      },
    }
  }

  if (SANDBOX_TOOL_NAMES.has(action.name)) {
    const commandWorkspace = prepareRunCommandWorkspace(input.context)
    const result = await sandbox.runTool(action.name as CoderSandboxToolName, commandWorkspace)
    const output = truncate([result.stdout, result.stderr].filter(Boolean).join('\n').trim(), 3000)
    const liveOrigin = action.name === 'runStart' && result.ok && 'origin' in result
      ? (result as { origin: string }).origin
      : undefined
    const commandDocumentation = renderSandboxToolDocumentation(result)
    const staleText = liveOrigin
      ? [
          `${action.name} completed with exit=${result.exitCode}; live origin remains ${liveOrigin}. Full output removed from continuity.`,
          commandDocumentation,
        ].filter(Boolean).join('\n')
      : [
          `${action.name} completed with exit=${result.exitCode}. Full output removed from continuity.`,
          commandDocumentation,
        ].filter(Boolean).join('\n')
    const resultText = [
      `${action.name}`,
      `exit=${result.exitCode}`,
      commandDocumentation,
      output || '(no output)',
    ].filter(Boolean).join('\n')
    return {
      log: `- ${action.name}\n  exit: ${result.exitCode}\n  output:\n${indent(output || '(no output)')}`,
      historyNote: `Tool result: ${resultText}`,
      sandboxToolCall: true,
      toolExitCode: result.exitCode,
      liveOrigin,
      continuity: {
        resultText,
        staleText,
        auditAnchors: [
          action.name,
          `exit=${result.exitCode}`,
          ...(result.userFacingCommand ? [result.userFacingCommand] : []),
        ],
      },
    }
  }

  if (action.name === 'browserOpen') {
    if (!browser) {
      const resultText = 'browserOpen failed: there is no live server yet. runStart boots a local HTTP server at the workspace and returns a URL — the browser binds to that URL when it opens.'
      return {
        log: '- browserOpen\n  blocked: local start has not succeeded yet',
        historyNote: resultText,
        ok: false,
        continuity: {
          resultText,
          auditAnchors: ['browserOpen', 'no live server'],
        },
      }
    }
    let result
    try {
      result = await browser.open(resolveBrowserOpenPath(
        action.params.path,
        input.context.browserMountPrefix ?? input.context.defaultMountPrefix,
      ))
    } catch (err) {
      const resultText = `browserOpen failed: ${err instanceof Error ? err.message : String(err)}`
      return {
        log: `- browserOpen\n  failed: ${err instanceof Error ? err.message : String(err)}`,
        historyNote: resultText,
        ok: false,
        continuity: {
          resultText,
          auditAnchors: ['browserOpen', 'failed'],
        },
      }
    }
    return {
      log: `- browserOpen\n  ok: ${result.ok}\n  url: ${result.url}\n  title: ${result.title}`,
      historyNote: `Tool result: browserOpen\nok: ${result.ok}\nurl: ${result.url}\ntitle: ${result.title}`,
      ok: result.ok,
      continuity: {
        resultText: `browserOpen\nok: ${result.ok}\nurl: ${result.url}\ntitle: ${result.title}`,
        auditAnchors: [result.url, result.title],
      },
    }
  }

  if (action.name === 'browserScreenshot') {
    if (!browser) {
      const resultText = 'browserScreenshot failed: no browser is currently open — nothing rendered to capture.'
      return {
        log: '- browserScreenshot\n  blocked: browser is not open',
        historyNote: resultText,
        continuity: {
          resultText,
          auditAnchors: ['browserScreenshot', 'browser is not open'],
        },
      }
    }
    const label = String(action.params.label ?? 'page')
    const result = await browser.screenshot(label)
    const attachments: CoderActionAttachment[] = result.base64
      ? [{ type: 'image', mimeType: 'image/png', data: result.base64 }]
      : []
    return {
      log: `- browserScreenshot\n  label: ${label}`,
      historyNote: `Tool result: browserScreenshot (label="${label}")\nThe image is attached to this turn; on later turns you'll only see this text reference.`,
      capturedScreenshot: true,
      attachments,
      continuity: {
        resultText: `browserScreenshot (label="${label}")\nThe image is attached to this turn; on later turns you'll only see this text reference.`,
        resultTurns: 1,
        staleText: `browserScreenshot (label="${label}") captured successfully. The image attachment is no longer in continuity.`,
        auditAnchors: [label],
      },
    }
  }

  if (action.name === 'browserClick') {
    if (!browser) {
      const resultText = 'browserClick failed: no browser is currently open — the live page has not been started.'
      return {
        log: '- browserClick\n  blocked: browser is not open',
        historyNote: resultText,
        ok: false,
        continuity: {
          resultText,
          auditAnchors: ['browserClick', 'browser is not open'],
        },
      }
    }
    const text = action.params.text === undefined ? undefined : String(action.params.text)
    const selector = action.params.selector === undefined ? undefined : String(action.params.selector)
    const result = await browser.click({ text, selector })
    return {
      log: `- browserClick\n  matched: ${result.matched}\n  ok: ${result.ok}\n  detail: ${result.detail}`,
      historyNote: `Tool result: browserClick\nmatched: ${result.matched}\nok: ${result.ok}\ndetail: ${result.detail}`,
      ok: result.ok,
      mutatedArtifact: true,
      continuity: {
        resultText: `browserClick\nmatched: ${result.matched}\nok: ${result.ok}\ndetail: ${result.detail}`,
        auditAnchors: [`matched: ${result.matched}`, `ok: ${result.ok}`],
      },
    }
  }

  if (action.name === 'browserType') {
    if (!browser) {
      const resultText = 'browserType failed: no browser is currently open — the live page has not been started.'
      return {
        log: '- browserType\n  blocked: browser is not open',
        historyNote: resultText,
        ok: false,
        continuity: {
          resultText,
          auditAnchors: ['browserType', 'browser is not open'],
        },
      }
    }
    const text = String(action.params.text ?? '')
    const selector = action.params.selector === undefined ? undefined : String(action.params.selector)
    const result = await browser.type({ text, selector })
    return {
      log: `- browserType\n  ok: ${result.ok}\n  detail: ${result.detail}`,
      historyNote: `Tool result: browserType\nok: ${result.ok}\ndetail: ${result.detail}`,
      ok: result.ok,
      mutatedArtifact: true,
      continuity: {
        resultText: `browserType\nok: ${result.ok}\ndetail: ${result.detail}`,
        auditAnchors: [`ok: ${result.ok}`],
      },
    }
  }

  if (action.name === 'browserKey') {
    if (!browser) {
      const resultText = 'browserKey failed: no browser is currently open — the live page has not been started.'
      return {
        log: '- browserKey\n  blocked: browser is not open',
        historyNote: resultText,
        ok: false,
        continuity: {
          resultText,
          auditAnchors: ['browserKey', 'browser is not open'],
        },
      }
    }
    const key = String(action.params.key ?? '')
    const selector = action.params.selector === undefined ? undefined : String(action.params.selector)
    const result = await browser.key({ key, selector })
    return {
      log: `- browserKey\n  ok: ${result.ok}\n  detail: ${result.detail}`,
      historyNote: `Tool result: browserKey\nok: ${result.ok}\ndetail: ${result.detail}`,
      ok: result.ok,
      mutatedArtifact: true,
      continuity: {
        resultText: `browserKey\nok: ${result.ok}\ndetail: ${result.detail}`,
        auditAnchors: [`ok: ${result.ok}`],
      },
    }
  }

  if (action.name === 'browserConsole') {
    if (!browser) {
      const resultText = 'browserConsole failed: no browser is currently open — no console entries to return.'
      return {
        log: '- browserConsole\n  blocked: browser is not open',
        historyNote: resultText,
        ok: false,
        continuity: {
          resultText,
          auditAnchors: ['browserConsole', 'browser is not open'],
        },
      }
    }
    const entries = browser.getConsoleEntries()
    const rendered = entries.length === 0
      ? '(no console messages)'
      : entries.map(renderBrowserConsoleEntry).join('\n')
    return {
      log: `- browserConsole\n  entries:\n${indent(rendered)}`,
      historyNote: `Tool result: browserConsole\n${rendered}`,
      continuity: {
        resultText: `browserConsole\n${rendered}`,
        staleText: '<browserConsole result removed from continuity; run browserConsole again to inspect current entries>',
        auditAnchors: buildAuditAnchors('browserConsole', rendered),
      },
    }
  }

  return null // unknown to the coder-action surface; host dispatches
}

function failedCoderActionResult(actionName: string, error: unknown): CoderActionResult {
  const message = error instanceof Error ? error.message : String(error)
  const resultText = `${actionName} failed: ${message}`
  return {
    log: `- ${actionName}\n  failed: ${message}`,
    historyNote: resultText,
    ok: false,
    kind: inferCoderActionKind(actionName),
    continuity: {
      resultText,
      auditAnchors: [actionName, 'failed', message],
    },
  }
}

function renderBrowserConsoleEntry(entry: {
  type: string
  text: string
  location?: { url?: string; lineNumber?: number; columnNumber?: number }
}) {
  const location = entry.location
  const url = location?.url?.trim()
  const line = typeof location?.lineNumber === 'number' ? location.lineNumber : undefined
  const column = typeof location?.columnNumber === 'number' ? location.columnNumber : undefined
  const renderedLocation = [
    url,
    line === undefined ? undefined : `line ${line}`,
    column === undefined ? undefined : `col ${column}`,
  ].filter(Boolean).join(' ')

  return renderedLocation
    ? `${entry.type}: ${entry.text} (${renderedLocation})`
    : `${entry.type}: ${entry.text}`
}

export function collectCoderActionAttachmentsForNextTurn(results: readonly CoderActionResult[]): ChatAttachment[] {
  const attachments = results
    .filter(result => result.continuity?.resultTurns !== 0)
    .flatMap(result => result.attachments ?? [])
  const latest = attachments.at(-1)
  return latest ? [latest] : []
}

// ─── applyPatch helpers ─────────────────────────────────────────────

function executeApplyPatch(input: {
  action: { name: string; params: Record<string, unknown> }
  context: CoderExecutorContext
}): CoderActionResult {
  const hasPatch = typeof input.action.params.patch === 'string' && input.action.params.patch.trim().length > 0
  const patch = hasPatch ? String(input.action.params.patch) : ''
  if (!patch.trim()) {
    const resultText = 'applyPatch failed — patch was empty; no files were changed.'
    return {
      log: '- applyPatch\n  blocked: empty patch',
      historyNote: resultText,
      continuity: {
        resultText,
        auditAnchors: ['applyPatch', 'empty patch'],
      },
    }
  }

  const plan = planGitPatchApplication(input.context, patch)
  if (!plan.ok) return plan.result

  const primaryApplyArgs = ['--recount', '--whitespace=nowarn']
  const inaccurateEofApplyArgs = [...primaryApplyArgs, '--inaccurate-eof']
  let applyArgs = primaryApplyArgs
  let check = runGitApply(plan.root, plan.patch, ['--check', ...primaryApplyArgs])
  if (!check.ok) {
    const inaccurateEofCheck = runGitApply(plan.root, plan.patch, ['--check', ...inaccurateEofApplyArgs])
    if (inaccurateEofCheck.ok) {
      check = inaccurateEofCheck
      applyArgs = inaccurateEofApplyArgs
    }
  }
  if (!check.ok) {
    const resultText = renderApplyPatchFailure({
      reason: 'patch context did not match the current workspace state',
      touchedFiles: plan.touchedFiles,
      gitOutput: check.output,
    })
    return {
      log: `- applyPatch\n  blocked: git apply --check failed\n  ${indent(check.output || '(no output)')}`,
      historyNote: resultText,
      continuity: {
        resultText,
        auditAnchors: ['applyPatch', 'git apply --check failed'],
      },
    }
  }

  const applied = runGitApply(plan.root, plan.patch, applyArgs)
  if (!applied.ok) {
    const resultText = renderApplyPatchFailure({
      reason: 'git accepted the patch check but failed while applying it',
      touchedFiles: plan.touchedFiles,
      gitOutput: applied.output,
    })
    return {
      log: `- applyPatch\n  failed: git apply failed after check\n  ${indent(applied.output || '(no output)')}`,
      historyNote: resultText,
      continuity: {
        resultText,
        auditAnchors: ['applyPatch', 'git apply failed'],
      },
    }
  }

  const touched = plan.touchedFiles
  const summary = `Successfully applied patch to ${touched.length} file${touched.length === 1 ? '' : 's'}: ${touched.join(', ')}.`
  const resultText = [
    'applyPatch',
    summary,
    renderPatchCurrentFilesSummary(plan.root, plan.pathMappings),
  ].filter(Boolean).join('\n')
  return {
    log: `- applyPatch: ${touched.join(', ')}`,
    historyNote: summary,
    mutatedArtifact: true,
    continuity: {
      resultText,
      resultTurns: SMALL_WORKSET_RESULT_TURNS,
      staleText: `applyPatch\n${summary} Exact file contents are not carried in WORK HISTORY; read files again only if needed.`,
      auditAnchors: ['applyPatch', ...touched.slice(0, 8)],
    },
  }
}

function renderApplyPatchFailure(input: {
  reason: string
  touchedFiles: readonly string[]
  gitOutput?: string
}) {
  const files = input.touchedFiles.length > 0
    ? input.touchedFiles.map(file => `- ${file}`).join('\n')
    : '- (no files identified)'
  return [
    'applyPatch failed; no files were changed.',
    `Reason: ${input.reason}.`,
    'The patch expected lines or file state that are not present exactly as written.',
    'Files the patch tried to touch:',
    files,
    'Recovery: read the affected file(s) if exact current contents are not already in this prompt, then retry with a patch whose context matches that content.',
    'Git detail:',
    input.gitOutput?.trim() || '(git apply did not return details)',
  ].join('\n')
}

function renderCommandSummary(argv: readonly string[]) {
  const rendered = JSON.stringify(argv)
  if (Buffer.byteLength(rendered, 'utf8') <= 240) return rendered
  const head = argv.slice(0, 2)
  const omitted = argv.length - head.length
  return `${JSON.stringify(head)} + ${omitted} omitted arg${omitted === 1 ? '' : 's'} (argv omitted from continuity; see audit for exact command)`
}

function renderSandboxToolDocumentation(result: CoderSandboxToolDocumentation): string {
  return [
    result.userFacingCommand ? `User-facing command: ${result.userFacingCommand}` : '',
    result.userFacingNote ? `User-facing note: ${result.userFacingNote}` : '',
  ].filter(Boolean).join('\n')
}

type PatchApplicationPlan =
  | {
      ok: true
      root: string
      patch: string
      touchedFiles: string[]
      pathMappings: Array<{ visiblePath: string; relativePath: string }>
    }
  | { ok: false; result: CoderActionResult }

function planGitPatchApplication(context: CoderExecutorContext, patch: string): PatchApplicationPlan {
  const visiblePaths = extractUnifiedDiffPaths(patch)
  if (visiblePaths.length === 0) {
    return {
      ok: false,
      result: {
        log: '- applyPatch\n  blocked: no file paths found in patch',
        historyNote: 'applyPatch failed — no file paths were found in the patch; no files were changed.',
        continuity: {
          resultText: 'applyPatch failed — no file paths were found in the patch; no files were changed.',
          auditAnchors: ['applyPatch', 'no file paths'],
        },
      },
    }
  }

  if (!context.workspaceMounts?.length) {
    const paths = new Map(visiblePaths.map(visiblePath => [visiblePath, visiblePath]))
    const rewrittenPatch = rewriteUnifiedDiffPaths(patch, paths)
    return {
      ok: true,
      root: context.workspaceRoot,
      patch: normalizeUnifiedDiffForGitApply(rewrittenPatch),
      touchedFiles: visiblePaths,
      pathMappings: visiblePaths.map(visiblePath => ({ visiblePath, relativePath: visiblePath })),
    }
  }

  const resolved = visiblePaths.map(visiblePath => ({
    visiblePath,
    resolved: resolveWorkspaceMountPath({
      mounts: context.workspaceMounts ?? [],
      requestPath: visiblePath,
      defaultMountPrefix: context.defaultMountPrefix,
    }),
  }))
  const readonly = resolved.find(item => item.resolved.mount.writable === false)
  if (readonly) {
    return {
      ok: false,
      result: readonlyMountResult('applyPatch', readonly.resolved.visiblePath),
    }
  }

  const roots = [...new Set(resolved.map(item => path.resolve(item.resolved.mount.root)))]
  if (roots.length !== 1) {
    const resultText = [
      'applyPatch failed — this patch spans multiple workspace mounts, so Archetype cannot apply it atomically in one git operation.',
      `Touched files: ${resolved.map(item => item.resolved.visiblePath).join(', ')}`,
    ].join('\n')
    return {
      ok: false,
      result: {
        log: `- applyPatch\n  blocked: multiple mounts ${roots.join(', ')}`,
        historyNote: resultText,
        continuity: {
          resultText,
          auditAnchors: ['applyPatch', 'multiple workspace mounts'],
        },
      },
    }
  }

  const byVisiblePath = new Map(resolved.map(item => [item.visiblePath, item.resolved.relativePath]))
  const rewrittenPatch = rewriteUnifiedDiffPaths(patch, byVisiblePath)
  return {
    ok: true,
    root: roots[0],
    patch: normalizeUnifiedDiffForGitApply(rewrittenPatch),
    touchedFiles: resolved.map(item => item.resolved.visiblePath),
    pathMappings: resolved.map(item => ({
      visiblePath: item.resolved.visiblePath,
      relativePath: item.resolved.relativePath,
    })),
  }
}

function runGitApply(root: string, patch: string, args: string[]): { ok: boolean; output: string } {
  try {
    execFileSync('git', ['apply', ...args], {
      cwd: root,
      input: patch,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: path.dirname(root),
      },
      maxBuffer: 10 * 1024 * 1024,
    })
    return { ok: true, output: '' }
  } catch (err) {
    const childError = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    const output = [
      childError.stdout ? String(childError.stdout).trim() : '',
      childError.stderr ? String(childError.stderr).trim() : '',
    ].filter(Boolean).join('\n')
    return { ok: false, output: output || childError.message || String(err) }
  }
}

function extractUnifiedDiffPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split(/\r?\n/u)) {
    for (const value of extractPathsFromDiffLine(line)) {
      if (value !== '/dev/null') paths.add(stripGitPathPrefix(value))
    }
  }
  return [...paths]
}

function extractPathsFromDiffLine(line: string): string[] {
  if (line.startsWith('diff --git ')) {
    const match = /^diff --git\s+(\S+)\s+(\S+)/u.exec(line)
    return match ? [match[1], match[2]] : []
  }
  if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    return [line.slice(4).split(/\t/u)[0].trim()]
  }
  if (line.startsWith('rename from ')) return [line.slice('rename from '.length).trim()]
  if (line.startsWith('rename to ')) return [line.slice('rename to '.length).trim()]
  if (line.startsWith('copy from ')) return [line.slice('copy from '.length).trim()]
  if (line.startsWith('copy to ')) return [line.slice('copy to '.length).trim()]
  return []
}

function rewriteUnifiedDiffPaths(patch: string, paths: Map<string, string>): string {
  return patch.split(/\r?\n/u).map(line => rewriteUnifiedDiffLine(line, paths)).join('\n')
}

function normalizeUnifiedDiffForGitApply(patch: string): string {
  const lines = patch.split(/\r?\n/u)
  const out: string[] = []
  let currentHeaderIndex: number | null = null
  let currentHeaderHasMode = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const next = lines[index + 1]
    if (line?.startsWith('diff --git ')) {
      currentHeaderIndex = out.length
      currentHeaderHasMode = false
      out.push(line)
      continue
    }
    if (line === 'new file mode 100644' || line === 'deleted file mode 100644') {
      currentHeaderHasMode = true
      out.push(line)
      continue
    }
    if (line?.startsWith('--- ') && next?.startsWith('+++ ') && !hasCurrentDiffHeader(out)) {
      const oldToken = line.slice(4).split(/\t/u)[0].trim()
      const newToken = next.slice(4).split(/\t/u)[0].trim()
      const pathToken = oldToken === '/dev/null' ? newToken : oldToken
      const relativePath = stripGitPathPrefix(pathToken)
      out.push(`diff --git a/${relativePath} b/${relativePath}`)
      if (oldToken === '/dev/null') out.push('new file mode 100644')
      if (newToken === '/dev/null') out.push('deleted file mode 100644')
      currentHeaderIndex = null
      currentHeaderHasMode = false
    } else if (line?.startsWith('--- ') && next?.startsWith('+++ ') && currentHeaderIndex !== null && !currentHeaderHasMode) {
      const oldToken = line.slice(4).split(/\t/u)[0].trim()
      const newToken = next.slice(4).split(/\t/u)[0].trim()
      if (oldToken === '/dev/null') {
        out.splice(currentHeaderIndex + 1, 0, 'new file mode 100644')
        currentHeaderHasMode = true
      }
      if (newToken === '/dev/null') {
        out.splice(currentHeaderIndex + 1, 0, 'deleted file mode 100644')
        currentHeaderHasMode = true
      }
    }
    out.push(line)
  }
  const normalized = out.join('\n')
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

function hasCurrentDiffHeader(lines: readonly string[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || line.trim() === '') continue
    if (line.startsWith('diff --git ')) return true
    if (line.startsWith('@@ ') || line.startsWith('--- ') || line.startsWith('+++ ')) return false
  }
  return false
}

function rewriteUnifiedDiffLine(line: string, paths: Map<string, string>): string {
  if (line.startsWith('diff --git ')) {
    const match = /^diff --git\s+(\S+)\s+(\S+)/u.exec(line)
    if (!match) return line
    return `diff --git ${rewriteGitToken(match[1], paths)} ${rewriteGitToken(match[2], paths)}`
  }
  if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    const prefix = line.slice(0, 4)
    const rest = line.slice(4)
    const [token, ...suffix] = rest.split(/\t/u)
    const rewritten = rewritePatchFileHeaderToken(token.trim(), paths, line.startsWith('--- ') ? 'a' : 'b')
    return `${prefix}${rewritten}${suffix.length ? `\t${suffix.join('\t')}` : ''}`
  }
  for (const prefix of ['rename from ', 'rename to ', 'copy from ', 'copy to ']) {
    if (line.startsWith(prefix)) {
      return `${prefix}${rewriteVisiblePath(line.slice(prefix.length).trim(), paths)}`
    }
  }
  return line
}

function rewriteGitToken(token: string, paths: Map<string, string>): string {
  if (token === '/dev/null') return token
  const prefix = token.startsWith('a/') ? 'a/' : token.startsWith('b/') ? 'b/' : ''
  const visiblePath = stripGitPathPrefix(token)
  return `${prefix}${rewriteVisiblePath(visiblePath, paths)}`
}

function rewritePatchFileHeaderToken(token: string, paths: Map<string, string>, side: 'a' | 'b'): string {
  if (token === '/dev/null') return token
  return `${side}/${rewriteVisiblePath(token, paths)}`
}

function rewriteVisiblePath(visiblePath: string, paths: Map<string, string>): string {
  return paths.get(stripGitPathPrefix(visiblePath)) ?? visiblePath
}

function stripGitPathPrefix(value: string): string {
  return value.replace(/^"(.*)"$/u, '$1').replace(/^[ab]\//u, '')
}

function renderPatchCurrentFilesSummary(
  root: string,
  pathMappings: readonly { visiblePath: string; relativePath: string }[],
): string {
  const sections: string[] = ['Changed file state:']
  for (const mapping of pathMappings.slice(0, 8)) {
    const absolutePath = resolveWorkspacePath(root, mapping.relativePath)
    if (!fs.existsSync(absolutePath)) {
      sections.push(`- ${mapping.visiblePath} — deleted`)
      continue
    }
    const content = safeReadWorkspaceText(absolutePath)
    const bytes = Buffer.byteLength(content, 'utf8')
    sections.push(`- ${mapping.visiblePath} — ${renderTextSize(content, bytes)}`)
  }
  if (pathMappings.length > 8) sections.push(`- ${pathMappings.length - 8} additional file(s) changed; use listFiles/readFile if needed.`)
  sections.push('Exact file contents are not carried in WORK HISTORY; use readFile if exact contents are needed.')
  return sections.join('\n')
}

interface WorkspaceFileSignature {
  visiblePath: string
  absolutePath: string
  bytes: number
  mtimeMs: number
}

function snapshotWorkspaceFiles(root: string): Map<string, WorkspaceFileSignature> {
  const files = new Map<string, WorkspaceFileSignature>()
  const resolvedRoot = path.resolve(root)
  const ignoredDirectories = new Set(['.git', '.sandbox-tmp', 'node_modules'])
  const walk = (directory: string, relativeDirectory: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(absolutePath)
      } catch {
        continue
      }
      files.set(relativePath, {
        visiblePath: relativePath.replace(/\\/gu, '/'),
        absolutePath,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    }
  }
  walk(resolvedRoot, '')
  return files
}

function snapshotCoderWorkspaceFiles(context: CoderExecutorContext): Map<string, WorkspaceFileSignature> {
  if (!context.workspaceMounts?.length) {
    return snapshotWorkspaceFiles(context.workspaceRoot)
  }

  const files = new Map<string, WorkspaceFileSignature>()
  for (const mount of context.workspaceMounts) {
    const prefix = mount.prefix.replace(/^\/+|\/+$/gu, '')
    const mountFiles = snapshotWorkspaceFiles(path.resolve(mount.root))
    for (const [relativePath, signature] of mountFiles) {
      const visiblePath = prefix ? `${prefix}/${relativePath}` : relativePath
      files.set(visiblePath, {
        ...signature,
        visiblePath,
      })
    }
  }
  return files
}

function prepareRunCommandWorkspace(context: CoderExecutorContext): {
  cwd?: string
  extraReadPaths?: string[]
  extraWritePaths?: string[]
} {
  if (!context.workspaceMounts?.length) return {}

  const visibleRoot = materializeVisibleWorkspaceRoot(context)
  const mountRoots = context.workspaceMounts.map(mount => path.resolve(mount.root))
  const writableRoots = context.workspaceMounts
    .filter(mount => mount.writable !== false)
    .map(mount => path.resolve(mount.root))
  return {
    cwd: visibleRoot,
    extraReadPaths: [visibleRoot, ...mountRoots],
    // The visible root itself is intentionally not writable; commands should
    // write through canonical mounted paths such as artifact/index.html.
    extraWritePaths: writableRoots,
  }
}

function materializeVisibleWorkspaceRoot(context: CoderExecutorContext): string {
  const visibleRoot = path.join(context.workspaceRoot, '.archetype-visible-workspace')
  fs.rmSync(visibleRoot, { recursive: true, force: true })
  fs.mkdirSync(visibleRoot, { recursive: true })

  for (const mount of context.workspaceMounts ?? []) {
    const prefix = mount.prefix.replace(/^\/+|\/+$/gu, '')
    if (!prefix) continue
    const linkPath = path.join(visibleRoot, prefix)
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.symlinkSync(path.resolve(mount.root), linkPath, 'dir')
  }

  return visibleRoot
}

function renderWorkspaceFileChanges(
  before: ReadonlyMap<string, WorkspaceFileSignature>,
  after: ReadonlyMap<string, WorkspaceFileSignature>,
): string {
  const changed: string[] = []
  const paths = new Set([...before.keys(), ...after.keys()])

  for (const relativePath of [...paths].sort((a, b) => a.localeCompare(b))) {
    const previous = before.get(relativePath)
    const next = after.get(relativePath)
    if (!previous && next) {
      changed.push(`- ${next.visiblePath} — created, ${renderWorkspaceSignatureSize(next)}`)
      continue
    }
    if (previous && !next) {
      changed.push(`- ${previous.visiblePath} — deleted`)
      continue
    }
    if (previous && next && (previous.bytes !== next.bytes || previous.mtimeMs !== next.mtimeMs)) {
      changed.push(`- ${next.visiblePath} — modified, ${renderWorkspaceSignatureSize(next)}`)
    }
  }

  if (changed.length === 0) return ''
  const lines = ['Changed file state:', ...changed.slice(0, 8)]
  if (changed.length > 8) lines.push(`- ${changed.length - 8} additional file(s) changed; use listFiles/readFile if needed.`)
  lines.push('Exact file contents are not carried in WORK HISTORY; use readFile if exact contents are needed.')
  return lines.join('\n')
}

function renderWorkspaceSignatureSize(signature: WorkspaceFileSignature): string {
  const content = safeReadWorkspaceText(signature.absolutePath)
  return renderTextSize(content, signature.bytes)
}

function renderTextSize(content: string, bytes = Buffer.byteLength(content, 'utf8')): string {
  const lines = countTextLines(content)
  return `${lines} line${lines === 1 ? '' : 's'}, ${bytes} bytes`
}

function countTextLines(content: string): number {
  if (content.length === 0) return 0
  const lineBreaks = content.match(/\n/g)?.length ?? 0
  return content.endsWith('\n') ? lineBreaks : lineBreaks + 1
}

function resolveBrowserOpenPath(rawPath: unknown, defaultMountPrefix?: string) {
  const raw = String(rawPath ?? '/').trim() || '/'
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    try {
      const url = new URL(raw)
      url.pathname = normalizeBrowserOpenPath(url.pathname, defaultMountPrefix)
      return url.toString()
    } catch {
      return raw
    }
  }

  return normalizeBrowserOpenPath(raw, defaultMountPrefix)
}

function normalizeBrowserOpenPath(rawPath: string, defaultMountPrefix?: string) {
  const withLeadingSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  const prefix = defaultMountPrefix?.replace(/^\/+|\/+$/gu, '')
  if (!prefix) return withLeadingSlash

  const mountPrefix = `/${prefix}/`
  if (withLeadingSlash === `/${prefix}`) return '/'
  if (withLeadingSlash.startsWith(mountPrefix)) {
    return `/${withLeadingSlash.slice(mountPrefix.length)}`
  }
  return withLeadingSlash
}

// ─── editFile helpers (multi-edit) ──────────────────────────────────

function executeEditFile(input: {
  action: { name: string; params: Record<string, unknown> }
  workspaceRoot: string
  relativePath?: string
  visiblePath?: string
}): CoderActionResult {
  const { action, workspaceRoot } = input
  const relativePath = input.visiblePath ?? String(action.params.path)
  const diskRelativePath = input.relativePath ?? relativePath
  const target = resolveWorkspacePath(workspaceRoot, diskRelativePath)

  // Accept either the multi-edit shape `edits: [{oldText, newText}, ...]`
  // or the legacy single-edit shape `{oldText, newText}` (older traces,
  // pre-rename models).
  const rawEdits = Array.isArray(action.params.edits)
    ? action.params.edits as Array<{ oldText?: unknown; newText?: unknown; occurrence?: unknown }>
    : (action.params.oldText !== undefined
      ? [{ oldText: action.params.oldText, newText: action.params.newText ?? '' }]
      : [])
  const edits = rawEdits.map(e => ({
    oldText: String(e?.oldText ?? ''),
    newText: String(e?.newText ?? ''),
    occurrence: parseEditOccurrence(e?.occurrence),
  })).filter(e => e.oldText.length > 0)

  if (!fs.existsSync(target)) {
    return {
      log: `- editFile\n  blocked: missing ${relativePath}`,
      historyNote: `editFile on ${relativePath} failed: the file does not exist at that path yet.`,
      continuity: {
        resultText: `editFile ${relativePath}\nfailed — the file does not exist at that path yet; no edits applied.`,
        auditAnchors: [relativePath, 'file does not exist'],
      },
    }
  }
  if (edits.length === 0) {
    return {
      log: `- editFile\n  blocked: no edits provided`,
      historyNote: `editFile on ${relativePath} failed: the edits[] array was empty — no edits were applied.`,
      continuity: {
        resultText: `editFile ${relativePath}\nfailed — edits[] was empty; no edits applied.`,
        auditAnchors: [relativePath, 'edits[] was empty'],
      },
    }
  }

  const original = fs.readFileSync(target, 'utf8')
  type Position = { index: number; start: number; end: number; newText: string; oldText: string }
  const positions: Position[] = []
  const failures: Array<{ index: number; reason: string }> = []
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText, occurrence } = edits[i]
    const matches = findMatchIndexes(original, oldText)
    if (matches.length === 0) {
      // Show the model a snippet of what IS in the file near the best
      // heuristic match point, so it can see why its oldText didn't hit
      // without needing a follow-up readFile. Saves a round-trip.
      const nearest = nearestContextForMissedEdit(original, oldText)
      failures.push({
        index: i,
        reason: nearest
          ? `oldText did not match the original file content. ${nearest}`
          : 'oldText did not match the original file content',
      })
      continue
    }
    if (occurrence !== undefined) {
      if (occurrence > matches.length) {
        failures.push({
          index: i,
          reason: `oldText matched ${matches.length} time(s), but occurrence ${occurrence} is out of range. Match lines: ${formatMatchLines(original, matches)}`,
        })
        continue
      }
      const start = matches[occurrence - 1]
      positions.push({ index: i, start, end: start + oldText.length, newText, oldText })
      continue
    }
    if (matches.length > 1) {
      failures.push({
        index: i,
        reason: `oldText matches ${matches.length} times at ${formatMatchLines(original, matches)}; set occurrence to the 1-based match to replace, or use writeFile to replace the whole file`,
      })
      continue
    }
    const start = matches[0]
    positions.push({ index: i, start, end: start + oldText.length, newText, oldText })
  }

  // Detect overlapping edits.
  const sorted = [...positions].sort((a, b) => a.start - b.start)
  const rejected = new Set<number>()
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      const priorIdx = sorted[i - 1].index
      failures.push({
        index: sorted[i].index,
        reason: `overlaps edits[${priorIdx}] in this call (their spans cover the same region of the file)`,
      })
      rejected.add(sorted[i].index)
    }
  }
  const applicable = positions.filter(p => !rejected.has(p.index))

  if (applicable.length === 0 || failures.length > 0) {
    const detail = failures.map(f => `edits[${f.index}]: ${f.reason}`).join('; ')
    const currentFileContext = renderCurrentFileContentContext(original)
    const resultText = [
      `editFile ${relativePath}`,
      `failed — no edits applied. ${detail}.`,
      currentFileContext,
    ].filter(Boolean).join('\n')
    return {
      log: `- editFile\n  blocked: edit set did not apply atomically in ${relativePath}`,
      historyNote: `editFile on ${relativePath} failed — no edits applied. ${detail}.`,
      continuity: {
        resultText,
        resultTurns: SMALL_WORKSET_RESULT_TURNS,
        staleText: `editFile ${relativePath}\nfailed — no edits applied. ${detail}. Current file content no longer carried in WORK HISTORY; read the file again only if exact contents are needed.`,
        auditAnchors: [relativePath],
      },
    }
  }

  // Apply replacements in reverse position order so earlier positions are stable.
  const apply = [...applicable].sort((a, b) => b.start - a.start)
  let next = original
  for (const p of apply) {
    next = next.slice(0, p.start) + p.newText + next.slice(p.end)
  }
  fs.writeFileSync(target, next, 'utf8')
  const newBytes = Buffer.byteLength(next, 'utf8')
  const applied = applicable.length
  const baseNote = `Successfully replaced ${applied} block(s) in ${relativePath} (file is now ${newBytes} bytes).`
  const resultText = [
    `editFile ${relativePath}`,
    baseNote,
    renderCurrentFileContentContext(next),
  ].join('\n')
  return {
    log: `- editFile: ${relativePath} (${applied}/${edits.length} edits)`,
    historyNote: baseNote,
    mutatedArtifact: true,
    continuity: {
      resultText,
      resultTurns: SMALL_WORKSET_RESULT_TURNS,
      staleText: `editFile ${relativePath}\n${baseNote} Current file content no longer carried in WORK HISTORY; read the file again only if exact contents are needed.`,
      auditAnchors: [relativePath],
    },
  }
}

// ─── searchInFiles ──────────────────────────────────────────────────

function executeSearchInFiles(input: {
  action: { name: string; params: Record<string, unknown> }
  context: CoderExecutorContext
}): CoderActionResult {
  const { action, context } = input
  const pattern = String(action.params.pattern)
  const pathGlob = String(action.params.pathGlob ?? '')

  let re: RegExp
  try {
    re = new RegExp(pattern, 'gm')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      log: `- searchInFiles\n  blocked: invalid regex — ${msg}`,
      historyNote: `searchInFiles failed: the regex "${pattern}" did not parse (${msg}).`,
      ok: false,
      continuity: {
        resultText: `searchInFiles "${pattern}" failed: ${msg}`,
        auditAnchors: [pattern],
      },
    }
  }

  const globRe = pathGlob
    ? new RegExp('^' + pathGlob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    : null

  const matches: Array<{ file: string; line: number; text: string }> = []
  let filesScanned = 0

  const walk = (dir: string, prefix: string) => {
    let items: fs.Dirent[] = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (it.name.startsWith('.') || it.name === 'node_modules' || it.name === 'dist') continue
      const full = path.join(dir, it.name)
      const relPath = prefix ? `${prefix}/${it.name}` : it.name
      if (it.isDirectory()) {
        walk(full, relPath)
        continue
      }
      if (globRe && !globRe.test(relPath)) continue
      let content = ''
      try { content = fs.readFileSync(full, 'utf8') } catch { continue }
      filesScanned += 1
      const lines = content.split('\n')
      for (let i = 0; i < lines.length && matches.length < 200; i += 1) {
        if (re.test(lines[i])) {
          matches.push({ file: relPath, line: i + 1, text: lines[i].slice(0, 240) })
        }
        re.lastIndex = 0
      }
      if (matches.length >= 200) break
    }
  }
  if (context.workspaceMounts?.length) {
    for (const mount of context.workspaceMounts) {
      const prefix = mount.prefix.replace(/^\/+|\/+$/gu, '')
      walk(path.resolve(mount.root), prefix)
    }
  } else {
    walk(context.workspaceRoot, '')
  }

  const rendered = matches.length > 0
    ? matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')
    : '(no matches)'
  return {
    log: `- searchInFiles: "${pattern}" (${matches.length} matches in ${filesScanned} files)\n  ${indent(rendered)}`,
    historyNote: `Tool result: searchInFiles "${pattern}" → ${matches.length} literal matches in ${filesScanned} files\n${rendered}`,
    continuity: {
      resultText: `searchInFiles "${pattern}" → ${matches.length} literal matches in ${filesScanned} files\n${rendered}`,
      staleText: `<searchInFiles result for "${pattern}" removed from continuity; run searchInFiles again to inspect current matches>`,
      auditAnchors: buildAuditAnchors(pattern, rendered),
    },
  }
}

function resolveCoderFilePath(
  context: CoderExecutorContext,
  requestPath: string,
  _options: { write: boolean },
): {
  root: string
  absolutePath: string
  relativePath: string
  visiblePath: string
  writable: boolean
} {
  if (!context.workspaceMounts?.length) {
    const relativePath = requestPath === '.' ? '' : requestPath
    return {
      root: context.workspaceRoot,
      absolutePath: resolveWorkspacePath(context.workspaceRoot, relativePath),
      relativePath,
      visiblePath: relativePath,
      writable: true,
    }
  }

  const resolved = resolveWorkspaceMountPath({
    mounts: context.workspaceMounts,
    requestPath,
    defaultMountPrefix: context.defaultMountPrefix,
  })
  return {
    root: resolved.mount.root,
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    visiblePath: resolved.visiblePath,
    writable: resolved.mount.writable !== false,
  }
}

function readonlyMountResult(actionName: string, visiblePath: string): CoderActionResult {
  const resultText = `${actionName} ${visiblePath}\nfailed — ${visiblePath} is in a read-only workspace mount; no edits were applied.`
  return {
    log: `- ${actionName}\n  blocked: read-only mount ${visiblePath}`,
    historyNote: resultText,
    continuity: {
      resultText,
      auditAnchors: [visiblePath, 'read-only workspace mount'],
    },
  }
}

function buildAuditAnchors(primary: string, content: string): string[] {
  const anchors = [primary]
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line !== '(no matches)' && line !== '(empty)' && !line.startsWith('['))
  for (const line of lines.slice(0, 2)) {
    anchors.push(line.slice(0, 120))
  }
  return anchors
}

// ─── Workspace helpers ──────────────────────────────────────────────

/**
 * Resolve a model-supplied relative path against the workspace root,
 * refusing any path that escapes the workspace. Throws — the model
 * should never see a path-traversal attempt succeed.
 */
export function resolveWorkspacePath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath)
  if (!resolved.startsWith(root)) {
    throw new Error(`Refusing to access outside workspace: ${relativePath}. Use a visible path from FILES; do not use ../ to cross mounts.`)
  }
  return resolved
}

/**
 * Read a workspace file safely: returns a sentinel string for missing
 * / oversized / binary files instead of throwing. No silent truncation
 * for text files — if the model called readFile, it needs the full
 * content to form editFile.oldText correctly.
 */
export function safeReadWorkspaceText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return `(file missing: ${path.basename(filePath)})`
  }
  const stat = fs.statSync(filePath)
  if (stat.size > 64 * 1024) return `(file skipped: ${path.basename(filePath)} is ${stat.size} bytes)`
  const buffer = fs.readFileSync(filePath)
  if (buffer.subarray(0, 512).includes(0)) return `(file skipped: ${path.basename(filePath)} appears to be binary)`
  return buffer.toString('utf8')
}

function renderReadFileContent(value: string): string {
  // No silent truncation. The model called readFile for a reason; showing it
  // a fraction of its own file and telling it the rest is hidden is a silent
  // bug (surfaced 2026-04-21: model read 13KB script.js, saw only 4KB, had
  // to form editFile.oldText from the visible portion, sometimes guessed
  // wrong). History compaction is a separate concern.
  return `content:\n${value}`
}

function parseEditOccurrence(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) return undefined
  return numeric
}

function findMatchIndexes(fileContent: string, oldText: string): number[] {
  const matches: number[] = []
  let cursor = 0
  while (cursor <= fileContent.length) {
    const found = fileContent.indexOf(oldText, cursor)
    if (found === -1) break
    matches.push(found)
    cursor = found + Math.max(oldText.length, 1)
  }
  return matches
}

function formatMatchLines(fileContent: string, indexes: readonly number[]): string {
  return indexes
    .slice(0, 8)
    .map((index, matchIndex) => `#${matchIndex + 1} line ${lineNumberAtIndex(fileContent, index)}`)
    .join(', ')
}

function lineNumberAtIndex(fileContent: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (fileContent.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * When an editFile.oldText doesn't match the file, emit a short hint
 * pointing at the line in the file that shares the most prefix with the
 * attempted oldText. Saves the model a round-trip readFile when a ~40-
 * char nudge is enough to repair the call. Returns empty string when
 * no useful heuristic match exists.
 */
function nearestContextForMissedEdit(fileContent: string, oldText: string): string {
  const firstLine = oldText.split('\n')[0].trim()
  if (firstLine.length < 8) return '' // too short to be discriminating
  const prefix = firstLine.slice(0, 32)
  const lines = fileContent.split('\n')
  let bestIdx = -1
  let bestLen = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (let s = 0; s <= line.length - 4; s += 1) {
      let matched = 0
      while (matched < prefix.length && s + matched < line.length && line[s + matched] === prefix[matched]) {
        matched += 1
      }
      if (matched > bestLen) { bestLen = matched; bestIdx = i }
    }
  }
  if (bestIdx < 0 || bestLen < 6) return ''
  const lo = Math.max(0, bestIdx - 1)
  const hi = Math.min(lines.length - 1, bestIdx + 1)
  const snippet = lines.slice(lo, hi + 1).map((l, k) => `  ${lo + k + 1}: ${l.slice(0, 120)}`).join('\n')
  return `Nearest candidate in the file (line ${bestIdx + 1}):\n${snippet}`
}

function renderCurrentFileContentContext(fileContent: string): string {
  return `Current file content not carried (${renderTextSize(fileContent)}); use readFile if exact contents are needed.`
}

function indent(value: string): string {
  return value.split('\n').map(line => `    ${line}`).join('\n')
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`
}
