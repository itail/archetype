/**
 * Turn reporter — persists per-turn errors + builder diagnostics so
 * every autonomous-loop consumer gets the same observability pattern
 * without inlining the hook logic.
 *
 * What it writes (per turn, when there's something to report):
 *   runRoot/errors.jsonl       one JSON-per-line entry for each
 *                              validation error or provider error
 *   runRoot/diagnostics.md     one markdown line per diagnostic the
 *                              builder emitted through its
 *                              `diagnostics[]` response field
 *
 * What it prints (stderr, one line per event, with ANSI prefix):
 *   [ARCHETYPE ERROR] turn N: unknown_action "doesNotExist" — ...
 *   [BUILDER DIAGNOSTIC] turn N: <diagnostic>
 *
 * The "fail loudly" policy lives here: silent failures mask broken
 * prompt/contract/context bugs. Every call-site error surfaces in both
 * the durable jsonl + a visible stderr callout. Retries continue
 * regardless — this module is telemetry, not flow control.
 *
 * Node-only (writes to local filesystem).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { LoopTurnRecord } from '../managed/autonomous-loop.js'

export interface TurnReporterOptions {
  /** Directory to write errors.jsonl + diagnostics.md into. */
  runRoot: string
  /**
   * Whether to print stderr callouts alongside file writes. Default true.
   * Set false for batch jobs where stderr is not human-watched.
   */
  emitStderr?: boolean
}

export interface TurnReporterHook {
  /** Wire this into `runAutonomousLoop({ hooks: { onTurn } })`. */
  onTurn: (record: LoopTurnRecord) => void
}

type ErrorLine = {
  turn: number
  kind: string
  action: string | null
  reason: string
}

/**
 * Build an onTurn reporter hook. One instance per benchmark run; safe
 * to share across peers/delegates (writes append).
 */
export function createTurnReporter(options: TurnReporterOptions): TurnReporterHook {
  const { runRoot } = options
  const emitStderr = options.emitStderr ?? true

  const errFile = path.join(runRoot, 'errors.jsonl')
  const diagFile = path.join(runRoot, 'diagnostics.md')

  fs.mkdirSync(runRoot, { recursive: true })

  return {
    onTurn: (record: LoopTurnRecord) => {
      persistErrors(record, errFile, emitStderr)
      persistDiagnostics(record, diagFile, emitStderr)
    },
  }
}

function persistErrors(record: LoopTurnRecord, errFile: string, emitStderr: boolean) {
  const lines: ErrorLine[] = []

  for (const ve of record.validationErrors ?? []) {
    lines.push({
      turn: record.turn,
      kind: ve.status,
      action: ve.name,
      reason: ve.error ?? `action "${ve.name}" rejected by contract (${ve.status})`,
    })
  }
  if (record.providerError) {
    lines.push({
      turn: record.turn,
      kind: 'provider_error',
      action: null,
      reason: record.providerError,
    })
  }

  if (lines.length === 0) return

  try {
    fs.appendFileSync(errFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  } catch (err) {
    console.error(`[errors.jsonl] write failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (emitStderr) {
    for (const rec of lines) {
      const actionSuffix = rec.action ? ` "${rec.action}"` : ''
      console.error(
        `\x1b[31m[ARCHETYPE ERROR]\x1b[0m turn ${rec.turn}: ${rec.kind}${actionSuffix} — ${rec.reason}`,
      )
    }
  }
}

function persistDiagnostics(record: LoopTurnRecord, diagFile: string, emitStderr: boolean) {
  if (!record.rawAssistantResponse) return
  const i = record.rawAssistantResponse.indexOf('{')
  if (i < 0) return

  let parsed: { diagnostics?: unknown } | null = null
  try {
    parsed = JSON.parse(record.rawAssistantResponse.slice(i)) as { diagnostics?: unknown }
  } catch {
    return // diagnostics are optional — parse failures are not errors
  }

  const raw = Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : []
  const diags = raw.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
  if (diags.length === 0) return

  try {
    const entries = diags.map((d) => `- turn ${record.turn}: ${d}`).join('\n') + '\n'
    fs.appendFileSync(diagFile, entries)
  } catch (err) {
    console.error(`[diagnostics.md] write failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (emitStderr) {
    for (const d of diags) {
      console.error(`\x1b[33m[BUILDER DIAGNOSTIC]\x1b[0m turn ${record.turn}: ${d}`)
    }
  }
}
