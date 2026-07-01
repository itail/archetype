export type WorkHistorySource = 'self' | 'action' | 'world'

export interface WorkHistoryEntry {
  turn: number
  source: WorkHistorySource
  text: string
  /**
   * Number of future turns that should see `text` before it decays to
   * `staleText`. Defaults to durable text.
   */
  resultTurns?: number
  /**
   * Compact recovery note shown after `resultTurns` has elapsed.
   */
  staleText?: string
}

export interface RenderWorkHistoryOptions {
  currentTurn: number
  maxEntries?: number
}

export function renderWorkHistoryEntries(
  entries: readonly WorkHistoryEntry[],
  options: RenderWorkHistoryOptions,
): string[] {
  const maxEntries = options.maxEntries ?? 24
  const visible = entries.slice(-maxEntries)
  if (visible.length === 0) return ['(empty)']

  return visible.map(entry => renderWorkHistoryEntry(entry, options.currentTurn))
}

export function renderWorkHistoryEntry(entry: WorkHistoryEntry, currentTurn: number): string {
  const source = entry.source
  const text = selectWorkHistoryText(entry, currentTurn)
  const trimmed = text.trim()
  if (trimmed.includes('\n')) {
    return `turn ${entry.turn} · ${source}:\n${trimmed}`
  }
  return `turn ${entry.turn} · ${source}: ${trimmed}`
}

export function makeWorkHistoryEntry(input: WorkHistoryEntry): WorkHistoryEntry {
  return {
    ...input,
    text: input.text.trim(),
    staleText: input.staleText?.trim(),
  }
}

function selectWorkHistoryText(entry: WorkHistoryEntry, currentTurn: number): string {
  if (!entry.staleText) return entry.text
  const resultTurns = entry.resultTurns ?? 1
  const age = Math.max(0, currentTurn - entry.turn)
  return age <= resultTurns ? entry.text : entry.staleText
}
