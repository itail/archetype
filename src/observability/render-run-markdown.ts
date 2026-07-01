/**
 * Render a benchmark run as a single turn-by-turn TURNS.md-style report.
 *
 * Purpose: the bug is almost always in the prompt the model received.
 * Reading turn-by-turn should take ≤30 seconds and surface:
 *   - the system prompt (deduped — appears once if constant across turns)
 *   - per-turn input (as the model saw it)
 *   - per-turn assistant emission (message verbatim + action summary)
 *   - any errors (unknown action, schema fail) flagged inline
 *   - a fingerprint header (turn count, action mix, errors)
 *
 * This module is pure: it takes structured data and returns a string.
 * Path discovery (where traces live, where errors.jsonl sits, how to
 * read a score) belongs to the host CLI — archetype/observability ships
 * a renderer, not a file-system reader. See `parseTracePacket` if you
 * want a quick way to hydrate traces from JSON files.
 *
 * Works in browsers and Node (no fs use here).
 */

export interface HistoryEntry {
  role: string
  content: string | unknown
}

export interface TracePacket {
  traceGroup?: string
  transport?: string
  turn?: number
  phase?: string
  attempt?: number
  systemPrompt?: string
  message?: string
  history?: HistoryEntry[]
  responseSchema?: unknown
}

export interface AssistantAction {
  name?: string
  params?: Record<string, unknown>
}

export interface AssistantPayload {
  message?: string
  actions?: AssistantAction[]
  diagnostics?: string[]
}

export interface RunErrorEntry {
  turn?: number
  kind?: string
  action?: string | null
  reason?: string
}

export interface RunScoreSummary {
  score?: number
  verdict?: string
  ship?: string
}

export interface RenderRunMarkdownInput {
  /** Run identifier for the report header. */
  runId: string
  /** Optional run metadata (benchmarkId, artifactName, status). */
  metadata?: {
    benchmarkId?: string
    artifactName?: string
    status?: string
  }
  /** Prompt traces for every turn (sorted by turn number ascending). */
  traces: TracePacket[]
  /** Error entries (as persisted to errors.jsonl). */
  errors?: RunErrorEntry[]
  /** Customer score (or any scoring surface) for the header. */
  score?: RunScoreSummary | null
  /** Character budget per turn-input block. Default 1200. */
  inputCharBudget?: number
}

/**
 * Render the final markdown. Returns the full TURNS.md body as a string.
 * Host writes it wherever it wants.
 */
export function renderRunMarkdown(input: RenderRunMarkdownInput): string {
  const traces = input.traces
  if (traces.length === 0) {
    return `# Turn review — ${input.runId}\n\n(no turn traces)\n`
  }

  const inputCharBudget = input.inputCharBudget ?? 1200
  const errors = input.errors ?? []
  const score = input.score ?? null

  // System prompt dedup — if identical across all turns, show once.
  const systemPrompts = new Set(traces.map((t) => t.systemPrompt ?? ''))
  const systemPromptConstant = systemPrompts.size === 1

  // Action fingerprint from the last trace's history (has the most data).
  const lastHistory = traces[traces.length - 1].history ?? []
  const fingerprint = computeFingerprint(lastHistory)

  const out: string[] = []
  out.push(`# Turn review — ${input.runId}`)
  out.push('')
  out.push(`- benchmark: ${input.metadata?.benchmarkId ?? '?'}`)
  out.push(`- artifactName: ${input.metadata?.artifactName ?? '?'}`)
  out.push(`- status: ${input.metadata?.status ?? '?'}`)
  out.push(`- turn traces: ${traces.length}`)
  out.push(`- assistant turns (from history): ${fingerprint.assistantTurns}`)
  out.push(`- single-action turns: ${fingerprint.singleActionTurns}`)
  out.push(`- multi-action turns: ${fingerprint.multiActionTurns}`)
  out.push(`- zero-action turns: ${fingerprint.zeroActionTurns}`)
  out.push(`- editFile shape: single=${fingerprint.singleEditCalls}, multi=${fingerprint.multiEditCalls}`)
  out.push(`- action mix: ${JSON.stringify(fingerprint.actionCounts)}`)
  if (score) {
    out.push(`- customer score: **${score.score ?? '?'}** (${score.verdict ?? '?'}, ${score.ship ?? '?'})`)
  }

  const errorNotes = errors
    .filter((e): e is RunErrorEntry => !!e)
    .map((e) => `turn ${e.turn ?? '?'}: ${e.reason ?? ''}`)
  if (errorNotes.length > 0) {
    out.push('')
    out.push(`## ⚠️ Errors (${errorNotes.length})`)
    for (const n of errorNotes) out.push(`- ${n}`)
  }
  out.push('')

  if (systemPromptConstant) {
    out.push('## System prompt (constant across turns)')
  } else {
    out.push(`## System prompt — changed ${systemPrompts.size} times across turns (first shown below; see prompt-traces/ for each variant)`)
  }
  out.push('')
  out.push('```')
  out.push(traces[0].systemPrompt ?? '(empty)')
  out.push('```')
  out.push('')

  // Per-turn — walk the latest trace's history (contains the full run).
  out.push('## Turn-by-turn')
  out.push('')
  let turnNum = 0
  for (const h of lastHistory) {
    const content = typeof h.content === 'string' ? h.content : JSON.stringify(h.content)
    if (h.role === 'user') {
      turnNum += 1
      out.push(`### Turn ${turnNum} input`)
      out.push('')
      out.push('```')
      out.push(clip(content, inputCharBudget))
      out.push('```')
      out.push('')
    } else if (h.role === 'assistant') {
      renderAssistantTurn(out, turnNum, content)
    }
  }

  // Capture the latest trace's `message` as the next turn's input (not
  // yet in history) — gives visibility into whatever the loop is about
  // to send when it stopped.
  const latestInput = traces[traces.length - 1].message
  if (latestInput) {
    turnNum += 1
    out.push(`### Turn ${turnNum} input (latest — model may have responded after this was captured)`)
    out.push('')
    out.push('```')
    out.push(clip(latestInput, inputCharBudget))
    out.push('```')
    out.push('')
  }

  return out.join('\n')
}

// ─── Helpers ────────────────────────────────────────────────────────

interface Fingerprint {
  assistantTurns: number
  singleActionTurns: number
  multiActionTurns: number
  zeroActionTurns: number
  multiEditCalls: number
  singleEditCalls: number
  actionCounts: Record<string, number>
}

function computeFingerprint(history: HistoryEntry[]): Fingerprint {
  const actionCounts: Record<string, number> = {}
  let assistantTurns = 0
  let multiActionTurns = 0
  let zeroActionTurns = 0
  let multiEditCalls = 0
  let singleEditCalls = 0

  for (const h of history) {
    if (h.role !== 'assistant') continue
    const payload = tryParseAssistantPayload(typeof h.content === 'string' ? h.content : '')
    if (!payload) continue
    assistantTurns += 1
    const actions = payload.actions ?? []
    if (actions.length === 0) zeroActionTurns += 1
    else if (actions.length > 1) multiActionTurns += 1
    for (const a of actions) {
      const nm = a.name ?? '?'
      actionCounts[nm] = (actionCounts[nm] ?? 0) + 1
      if (nm === 'editFile') {
        const edits = (a.params ?? {}).edits
        if (Array.isArray(edits)) {
          if (edits.length > 1) multiEditCalls += 1
          else singleEditCalls += 1
        }
      }
    }
  }

  const singleActionTurns = assistantTurns - multiActionTurns - zeroActionTurns
  return {
    assistantTurns,
    singleActionTurns,
    multiActionTurns,
    zeroActionTurns,
    multiEditCalls,
    singleEditCalls,
    actionCounts,
  }
}

function renderAssistantTurn(out: string[], turnNum: number, content: string) {
  const payload = tryParseAssistantPayload(content)
  if (payload) {
    out.push(`**Turn ${turnNum} assistant** — ${(payload.actions ?? []).length} action(s)`)
    if (payload.message && payload.message.trim()) {
      out.push('')
      out.push('> ' + payload.message.replace(/\n/g, '\n> '))
    }
    if (payload.actions && payload.actions.length > 0) {
      out.push('')
      for (const a of payload.actions) {
        out.push(`- \`${summarizeAction(a)}\``)
      }
    }
    if (payload.diagnostics && payload.diagnostics.length > 0) {
      out.push('')
      out.push('_diagnostics:_')
      for (const d of payload.diagnostics) out.push(`- ⚠️ ${d}`)
    }
    out.push('')
  } else {
    out.push(`**Turn ${turnNum} assistant** — (unparseable)`)
    out.push('```')
    out.push(content.slice(0, 600))
    out.push('```')
    out.push('')
  }
}

/**
 * Extract an AssistantPayload from a raw assistant-message string.
 * Handles the common case of prose before a JSON object — everything
 * before the first `{` is ignored.
 */
export function tryParseAssistantPayload(content: string): AssistantPayload | null {
  if (typeof content !== 'string') return null
  const i = content.indexOf('{')
  if (i < 0) return null
  try {
    return JSON.parse(content.slice(i)) as AssistantPayload
  } catch {
    return null
  }
}

/**
 * Compact one-line summary of an action: keeps reference keys (path,
 * pattern, id, name, outcome, …) visible, drops bodies (content, stdout,
 * image payloads). Used in the per-turn action list for fast scanning.
 */
export function summarizeAction(a: AssistantAction): string {
  const name = a.name ?? '?'
  const params = a.params ?? {}
  const keep: Record<string, unknown> = {}
  for (const refKey of ['path', 'pattern', 'pathGlob', 'id', 'entity', 'name', 'outcome', 'summary', 'label']) {
    if (refKey in params && params[refKey] !== undefined) keep[refKey] = params[refKey]
  }
  if (name === 'editFile') {
    const edits = params.edits
    keep.editCount = Array.isArray(edits) ? edits.length : (params.oldText !== undefined ? 1 : 0)
  }
  if (name === 'writeFile') {
    const content = params.content
    if (typeof content === 'string') keep.bytes = Buffer.byteLength(content, 'utf8')
  }
  const kvs = Object.entries(keep)
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`)
    .join(', ')
  return kvs ? `${name}  {${kvs}}` : name
}

function clip(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit) + `\n… [+${s.length - limit} chars]` : s
}
