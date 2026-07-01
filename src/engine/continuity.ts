import type { ChatParticipant, LLMProvider, ParsedAction, TurnLedgerActionOutcome, TurnLedgerEntry } from '../types.js'
import { annotateMessage, stripAnnotationsForDisplay } from '../core/actions.js'

export type ContinuityActionOutcome = TurnLedgerActionOutcome

export interface BuildAssistantContinuityMessageInput {
  /** The assistant's narrative message. */
  message: string
  /** AI-written outcome notes from the model response. */
  modelOutcomeNotes?: readonly string[]
  /** Executor/action outcomes. These become durable natural-language notes. */
  actionOutcomes?: readonly ContinuityActionOutcome[]
  /** Debug/UI action annotations. Stripped before future model turns. */
  actionAnnotations?: readonly string[]
  /** Provider-specific history transport. */
  historyTransport?: LLMProvider['historyTransport']
  /** Actions to preserve as compact function-call references for native FC history. */
  actionsForHistory?: readonly Pick<ParsedAction, 'name' | 'params'>[]
  /** Extra model-visible history sections, e.g. peer consultation summaries. */
  extraHistorySections?: readonly string[]
  /** Turn the message belongs to, used to age action outcomes. */
  entryTurn?: number
  /** Current turn receiving this continuity message. */
  currentTurn?: number
}

/**
 * Build the assistant message stored in history.
 *
 * This is the continuity invariant:
 * - future turns see narrative + outcome notes, not raw action payloads
 * - attempted actions are represented by compact natural-language action
 *   narration/outcome notes, not by dumping raw params back into the feed
 * - raw/debug action annotations are optional and stripped from LLM history
 * - function-calling providers receive compact action references with large
 *   params omitted
 */
export function buildAssistantContinuityMessage(
  input: BuildAssistantContinuityMessageInput,
): string {
  const outcomeNotes = collectOutcomeNotes(input)
  const narrative = [input.message, ...(input.extraHistorySections ?? [])]
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n')

  if (input.historyTransport === 'compact-function-calls') {
    return JSON.stringify({
      message: annotateMessage(narrative, [], outcomeNotes),
      actions: (input.actionsForHistory ?? []).map(action => compactActionForHistory(action)),
    })
  }

  return annotateMessage(narrative, [...(input.actionAnnotations ?? [])], outcomeNotes)
}

export interface RenderTurnLedgerOptions {
  /** Actor id/name for the persona receiving the rendered history. */
  perspectiveActorId?: string
  /** Participant labels used to make peer turns legible despite binary provider roles. */
  participants?: readonly ChatParticipant[]
  /** Whether model-facing content should include a speaker label. Defaults to true. */
  speakerLabels?: boolean
  /** Provider-specific history transport. */
  historyTransport?: LLMProvider['historyTransport']
  /**
   * When the receiving persona already has private work history for this
   * actor, omit the same actor's action outcomes from visible chat history.
   * Peer outcomes are still rendered because they are shared-world facts.
   */
  omitActionOutcomesForActorId?: string
  /** Current turn number for time-decaying action outcome continuity. */
  currentTurn?: number
}

export interface PrepareTurnLedgerChatTurnOptions extends RenderTurnLedgerOptions {
  /** Message to use when there is no fresh peer turn to receive. */
  fallbackMessage: string
}

export interface PreparedTurnLedgerChatTurn {
  /** Current model-visible message for this actor. */
  message: string
  /** Remaining ledger entries to render as chat history. */
  turnLedger: TurnLedgerEntry[]
  /** Why this message is being presented as the current turn. */
  source: 'fresh-peer-turn' | 'own-action-outcome' | 'fallback'
}

/**
 * Prepare a multi-persona chat turn from a turn ledger.
 *
 * When the latest ledger entry came from another participant, that entry is
 * the current message for this actor, not another history item plus a fake
 * "Continue." prompt. Its action outcomes stay attached so the receiving
 * persona sees the teammate's visible message and the factual world changes
 * caused by that turn in one place.
 *
 * The same rule applies when the latest entry is this actor's own turn with
 * action outcomes. The next model call is responding to those outcomes, not
 * to a fresh user request to "continue", so the result stays in the current
 * event instead of being buried in assistant history.
 */
export function prepareTurnLedgerChatTurn(
  entries: readonly TurnLedgerEntry[] | undefined,
  options: PrepareTurnLedgerChatTurnOptions,
): PreparedTurnLedgerChatTurn {
  const ledger = [...(entries ?? [])]
  const latest = ledger.at(-1)
  if (!latest) {
    return { message: options.fallbackMessage, turnLedger: ledger, source: 'fallback' }
  }

  const latestIsFreshPeerTurn = Boolean(
    latest.actorId
    && options.perspectiveActorId
    && latest.actorId !== options.perspectiveActorId,
  )
  const latestIsOwnActionOutcome = Boolean(
    latest.actorId
    && options.perspectiveActorId
    && latest.actorId === options.perspectiveActorId
    && latest.actionOutcomes?.length,
  )

  if (!latestIsFreshPeerTurn) {
    if (latestIsOwnActionOutcome) {
      return {
        message: buildOwnActionOutcomeCurrentMessage(latest, options),
        turnLedger: ledger.slice(0, -1),
        source: 'own-action-outcome',
      }
    }
    return { message: options.fallbackMessage, turnLedger: ledger, source: 'fallback' }
  }

  return {
    message: buildTurnLedgerCurrentMessage(latest, options),
    turnLedger: ledger.slice(0, -1),
    source: 'fresh-peer-turn',
  }
}

function buildOwnActionOutcomeCurrentMessage(
  entry: TurnLedgerEntry,
  options: RenderTurnLedgerOptions,
): string {
  return [
    [
      'Current work stream from your previous turn.',
      'Read the block below as one chronological event: your narration/inner voice, then compact action narration, then factual outcomes.',
      'The action narration is not a raw action dump; raw parameters are omitted because they can bloat or contaminate the feed and may describe action APIs no longer available.',
      'Successful outcomes already changed the world; failed outcomes did not. Use the stream as current world state.',
    ].join('\n'),
    buildAssistantContinuityMessage({
      message: labelTurnLedgerMessage(entry.message, entry, { ...options, speakerLabels: false }),
      modelOutcomeNotes: entry.outcomeNotes,
      actionOutcomes: entry.actionOutcomes,
      actionsForHistory: entry.actionsForHistory,
      historyTransport: options.historyTransport,
      entryTurn: entry.turn,
      currentTurn: options.currentTurn,
    }),
  ].filter(Boolean).join('\n\n')
}

/**
 * Render a turn ledger into model-facing chat history.
 *
 * This is the locked continuity path for multi-agent/custom-loop apps:
 * visible chat and action outcomes travel together, raw action payloads do
 * not, and actor ids are mapped into user/assistant roles per recipient.
 */
export function renderTurnLedgerForModel(
  entries: readonly TurnLedgerEntry[] | undefined,
  options: RenderTurnLedgerOptions = {},
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return (entries ?? [])
    .map(entry => renderTurnLedgerEntryForModel(entry, options))
    .filter((entry): entry is { role: 'user' | 'assistant'; content: string } => Boolean(entry?.content.trim()))
}

export function renderTurnLedgerEntryForModel(
  entry: TurnLedgerEntry,
  options: RenderTurnLedgerOptions = {},
): { role: 'user' | 'assistant'; content: string } | null {
  const message = entry.message.trim()
  if (!message) return null
  const role = resolveLedgerRole(entry, options.perspectiveActorId)
  const historyTransport = role === 'assistant' ? options.historyTransport : undefined
  const labeledMessage = labelTurnLedgerMessage(message, entry, options)
  const actionOutcomes = entry.actorId && entry.actorId === options.omitActionOutcomesForActorId
    ? compactOwnActionOutcomes(entry.actionOutcomes)
    : entry.actionOutcomes
  return {
    role,
    content: buildAssistantContinuityMessage({
      message: labeledMessage,
      modelOutcomeNotes: entry.outcomeNotes,
      actionOutcomes,
      actionAnnotations: entry.actionAnnotations,
      actionsForHistory: entry.actionsForHistory,
      historyTransport,
      entryTurn: entry.turn,
      currentTurn: options.currentTurn,
    }),
  }
}

function compactOwnActionOutcomes(
  outcomes: readonly ContinuityActionOutcome[] | undefined,
): ContinuityActionOutcome[] | undefined {
  if (!outcomes?.length) return undefined
  return outcomes.map(outcome => ({
    ...outcome,
    outcomeNote: outcome.resultText
      ? compactOwnActionOutcomeNote(outcome)
      : outcome.outcomeNote,
    resultText: undefined,
    resultTurns: undefined,
  }))
}

function compactOwnActionOutcomeNote(outcome: ContinuityActionOutcome): string | undefined {
  const summary = outcome.action ? compactActionSummary(outcome.action) : 'action'
  const error = outcome.error?.trim()

  if (outcome.status === 'failed' || outcome.success === false) {
    return error ? `${summary} failed: ${error}` : `${summary} failed.`
  }
  if (outcome.status === 'no_op') {
    return error ? `${summary} made no state change: ${error}` : `${summary} made no state change.`
  }
  if (outcome.status === 'proposed') {
    return `${summary} was proposed but not executed yet.`
  }
  if (outcome.status === 'executed' || outcome.success === true) {
    return `${summary} executed.`
  }
  return `${summary} completed.`
}

function buildTurnLedgerCurrentMessage(
  entry: TurnLedgerEntry,
  options: RenderTurnLedgerOptions,
): string {
  return buildAssistantContinuityMessage({
    message: labelTurnLedgerMessage(entry.message, entry, options),
    modelOutcomeNotes: entry.outcomeNotes,
    actionOutcomes: entry.actionOutcomes,
    actionsForHistory: entry.actionsForHistory,
    historyTransport: options.historyTransport,
    entryTurn: entry.turn,
    currentTurn: options.currentTurn,
  })
}

export function renderTurnLedgerForDisplay(
  entries: readonly TurnLedgerEntry[] | undefined,
  options: Pick<RenderTurnLedgerOptions, 'perspectiveActorId'> = {},
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return renderTurnLedgerForModel(entries, { ...options, speakerLabels: false })
    .map(entry => ({
      ...entry,
      content: stripAnnotationsForDisplay(entry.content),
    }))
}

function labelTurnLedgerMessage(
  message: string,
  entry: Pick<TurnLedgerEntry, 'actorId'>,
  options: Pick<RenderTurnLedgerOptions, 'participants' | 'speakerLabels'> = {},
): string {
  const trimmed = message.trim()
  if (options.speakerLabels === false) return trimmed
  if (!entry.actorId) return trimmed
  const label = resolveParticipantLabel(entry.actorId, options.participants)
  return `${label}:\n${trimmed}`
}

function resolveParticipantLabel(
  actorId: string,
  participants?: readonly ChatParticipant[],
): string {
  return participants?.find(participant => participant.id === actorId)?.label
    ?? humanizeActorId(actorId)
}

function humanizeActorId(actorId: string): string {
  return actorId
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    || actorId
}

export function collectOutcomeNotes(input: Pick<BuildAssistantContinuityMessageInput, 'modelOutcomeNotes' | 'actionOutcomes' | 'entryTurn' | 'currentTurn'>): string[] {
  const notes = [
    ...(input.modelOutcomeNotes ?? []),
    ...(input.actionOutcomes ?? []).map(outcome => buildOutcomeNoteFromActionOutcome(outcome, input)),
  ]
  return [...new Set(notes.map(note => note?.trim()).filter((note): note is string => Boolean(note)))]
}

export function buildOutcomeNoteFromActionOutcome(
  outcome: ContinuityActionOutcome,
  options: Pick<BuildAssistantContinuityMessageInput, 'entryTurn' | 'currentTurn'> = {},
): string | null {
  const liveResult = resolveLiveOutcomeResult(outcome, options)
  if (liveResult) return liveResult

  const explicit = outcome.outcomeNote?.trim()
  if (explicit) return explicit

  const summary = outcome.action ? compactActionSummary(outcome.action) : 'action'
  const error = outcome.error?.trim()
  const status = outcome.status

  if (status === 'failed' || outcome.success === false) {
    return error ? `${summary} failed: ${error}` : `${summary} failed.`
  }
  if (status === 'no_op') {
    return error ? `${summary} made no state change: ${error}` : `${summary} made no state change.`
  }
  if (status === 'proposed') {
    return `${summary} was proposed but not executed yet.`
  }
  if (typeof outcome.text === 'string') {
    const squashed = squashWhitespace(outcome.text)
    if (squashed.length > 0 && squashed.length <= 140 && !outcome.text.includes('\n')) {
      return squashed
    }
  }
  if (status === 'executed' || outcome.success === true) {
    return `${summary} executed.`
  }
  return outcome.action ? `${summary} completed.` : null
}

function resolveLiveOutcomeResult(
  outcome: ContinuityActionOutcome,
  options: Pick<BuildAssistantContinuityMessageInput, 'entryTurn' | 'currentTurn'>,
): string | null {
  const resultText = outcome.resultText?.trim()
  if (!resultText) return null

  const resultTurns = outcome.resultTurns ?? 0
  if (resultTurns <= 0) return outcome.staleText?.trim() || null
  if (typeof options.entryTurn !== 'number' || typeof options.currentTurn !== 'number') return null

  const age = options.currentTurn - options.entryTurn
  if (age >= 1 && age <= resultTurns) return resultText
  if (age > resultTurns) return outcome.staleText?.trim() || null
  return resultText
}

export function compactActionForHistory(
  action: Pick<ParsedAction, 'name' | 'params'>,
): { name: string; params: Record<string, unknown> } {
  return {
    name: action.name,
    params: compactValueForHistory(action.params) as Record<string, unknown>,
  }
}

export function compactValueForHistory(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    const looksLargeBody = bytes > 160
      || key === 'content'
      || key === 'stdout'
      || key === 'stderr'
      || key === 'text'
      || key === 'oldText'
      || key === 'newText'
      || key === 'patch'
    if (looksLargeBody) return `<omitted ${bytes} bytes>`
    return value
  }
  if (Array.isArray(value)) {
    if (key === 'command') {
      return value.slice(0, 8).map(item => compactValueForHistory(item))
    }
    if (key === 'edits') {
      return `<omitted ${value.length} edit${value.length === 1 ? '' : 's'}>`
    }
    return value.slice(0, 8).map(item => compactValueForHistory(item))
  }
  if (value && typeof value === 'object') {
    const compacted: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      compacted[childKey] = compactValueForHistory(childValue, childKey)
    }
    return compacted
  }
  return value
}

export function compactActionSummary(action: Pick<ParsedAction, 'name' | 'params'>): string {
  const keep: Record<string, unknown> = {}
  for (const refKey of ['path', 'pattern', 'pathGlob', 'id', 'entity', 'name', 'outcome', 'summary', 'label']) {
    if (refKey in action.params && action.params[refKey] !== undefined) {
      keep[refKey] = action.params[refKey]
    }
  }
  if (action.name === 'editFile') {
    const edits = action.params.edits
    keep.editCount = Array.isArray(edits) ? edits.length : (action.params.oldText !== undefined ? 1 : 0)
  }
  if (action.name === 'writeFile') {
    const content = action.params.content
    if (typeof content === 'string') keep.bytes = Buffer.byteLength(content, 'utf8')
  }
  if (action.name === 'applyPatch') {
    const patch = action.params.patch
    if (typeof patch === 'string') keep.bytes = Buffer.byteLength(patch, 'utf8')
  }
  const kvs = Object.entries(keep)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ')
  return kvs ? `${action.name} {${kvs}}` : action.name
}

function squashWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function resolveLedgerRole(
  entry: TurnLedgerEntry,
  perspectiveActorId?: string,
): 'user' | 'assistant' {
  if (perspectiveActorId && entry.actorId) {
    return entry.actorId === perspectiveActorId ? 'assistant' : 'user'
  }
  return entry.role ?? 'assistant'
}
