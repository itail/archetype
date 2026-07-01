/**
 * Prompt-dump helpers — the "Line 2" of the audit mechanism.
 *
 * When auditPersona flags something you can't explain, or the trace looks
 * fine but the AI's behavior doesn't match expectation — dump the exact
 * prompt the LLM would receive and read it directly. Often the bug is
 * obvious in two minutes of eyeballing the packet.
 *
 * Two entry points, same artifact shape:
 *
 *   dumpPromptForReview(config, input)
 *     One-shot. Build the prompt for a single representative input,
 *     get back a DumpedPrompt with system prompt, history, message,
 *     plus an `artifact` string formatted for pasting into an AI
 *     reviewer or attaching to a bug report.
 *
 *   createPromptTraceRecorder({ outDir })
 *     Hook-compatible recorder for benchmark runs. Wires into
 *     runAutonomousLoop's onBeforeChat (or any code path that
 *     assembles a request). Writes one JSON file per turn. Replaces
 *     per-persona reinventions of this pattern (foundry had one,
 *     savor had three).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
  PersonaConfig,
  ChatInput,
  PromptedTurnInput,
  RetrospectInput,
  ChatAttachment,
  PromptMode,
  PromptOrigin,
} from '../types.js'
import {
  buildChatLLMRequest,
  buildPromptedTurnLLMRequest,
} from '../core/request-builder.js'

// ─── DumpedPrompt shape ──────────────────────────────────────────────────────

export interface DumpedPrompt {
  /** The assembled system prompt — exactly what the LLM sees as its system role. */
  systemPrompt: string
  /** The user/assistant history in order. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  /** The current user message (or the intent/guidelines for prompted turns). */
  message: string
  /** Image attachments, when present. */
  attachments?: ChatAttachment[]
  /** Response schema passed to the LLM, when relevant. */
  responseSchema?: Record<string, unknown>
  /** Which mode produced this prompt ('chat' | 'prompted-turn' | 'retrospect'). */
  mode: DumpMode
  /** Which prompt scaffold the model actually received. */
  promptMode: PromptMode
  /** Whether the current message originated with a person/user or the app/runtime. */
  promptOrigin: PromptOrigin
  /**
   * A single-string artifact ready for pasting into an AI reviewer,
   * attaching to a bug report, diffing across runs, etc. Includes
   * clearly-labeled section headers.
   */
  artifact: string
}

export type DumpMode = 'chat' | 'prompted-turn' | 'retrospect'

export interface DumpPromptOptions {
  /**
   * Which assembly path to use. Default 'chat' — matches engine.chat().
   * Use 'prompted-turn' for AI-initiated turns (greetings, proactive).
   */
  mode?: DumpMode
}

// ─── one-shot dumpPromptForReview ────────────────────────────────────────────

/**
 * Assemble the exact prompt this persona would send for one input, and
 * return it in a shape friendly for human or AI review.
 *
 * Use this during the debugging loop when auditPersona findings need
 * context, or when you want a second opinion from another AI on the
 * actual packet.
 */
export function dumpPromptForReview(
  config: PersonaConfig,
  input: ChatInput | PromptedTurnInput,
  options?: DumpPromptOptions,
): DumpedPrompt {
  const mode = options?.mode ?? 'chat'

  if (mode === 'chat') {
    const { request } = buildChatLLMRequest(config, input as ChatInput)
    return {
      systemPrompt: request.systemPrompt,
      history: request.history,
      message: request.message,
      attachments: request.attachments,
      responseSchema: request.responseSchema,
      mode,
      promptMode: request.promptMode,
      promptOrigin: request.promptOrigin,
      artifact: formatAsArtifact({
        systemPrompt: request.systemPrompt,
        history: request.history,
        message: request.message,
        mode,
        promptMode: request.promptMode,
        promptOrigin: request.promptOrigin,
        attachments: request.attachments,
      }),
    }
  }

  // prompted-turn / retrospect share the same builder
  const { request } = buildPromptedTurnLLMRequest(config, input as PromptedTurnInput)
  return {
    systemPrompt: request.systemPrompt,
    history: request.history,
    message: request.message,
    attachments: request.attachments,
    responseSchema: request.responseSchema,
    mode,
      promptMode: request.promptMode,
      promptOrigin: request.promptOrigin,
      artifact: formatAsArtifact({
        systemPrompt: request.systemPrompt,
        history: request.history,
        message: request.message,
        mode,
        promptMode: request.promptMode,
        promptOrigin: request.promptOrigin,
        attachments: request.attachments,
      }),
  }
}

// ─── hook-compatible createPromptTraceRecorder ──────────────────────────────

export interface PromptTraceRecorderOptions {
  /** Directory to write per-turn trace JSONs into. Created if missing. */
  outDir: string
  /**
   * Optional namespace/subgroup within outDir — useful when running
   * multiple harnesses against one persona in parallel. Falls under
   * `<outDir>/<traceGroup>/` when set.
   */
  traceGroup?: string
  /**
   * Optional tag written into each trace record. Pass e.g. the
   * transport/provider name so downstream review tooling can filter.
   */
  tag?: string
  /**
   * Format written per turn. Default 'json' for programmatic analysis.
   * 'artifact' writes the human-readable single-string version instead.
   * 'both' writes two files per turn (.json + .txt).
   */
  format?: 'json' | 'artifact' | 'both'
}

export interface PromptTraceRecorder {
  /**
   * Attach to `runAutonomousLoop`'s `hooks.onBeforeChat` — the recorder
   * receives the assembled request and writes a per-turn file.
   */
  onBeforeChat: (info: {
    request: {
      systemPrompt: string
      message: string
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      responseSchema?: Record<string, unknown>
      attachments?: ChatAttachment[]
      promptMode?: PromptMode
    }
    turn: number
    attempt: number
  }) => void
  /**
   * Record a standalone dump without going through autonomous-loop.
   * Useful when a benchmark harness is hand-rolled.
   */
  record: (input: {
    turn: number
    attempt?: number
    phase?: 'initial' | 'followup'
    dumped: DumpedPrompt
  }) => void
  /**
   * Append post-model/post-action evidence to the existing turn JSON.
   * This is intentionally developer-facing audit data: it records the raw
   * response, parsed actions, execution outcomes, and resulting history so a
   * failed action can be debugged from artifacts alone.
   */
  recordTurnResult: (input: PromptTraceResultInput) => void
  /** Directory where traces are being written. */
  outDir: string
}

export interface PromptTraceResultInput {
  turn: number
  attempt?: number
  phase?: 'initial' | 'followup'
  rawResponse?: string | null
  message?: string
  trace?: unknown
  actions?: unknown[]
  actionResults?: unknown[]
  historyAfterTurn?: Array<{ role: string; content: string }>
  nextMessage?: string | null
  notes?: string[]
}

const TRACE_STRING_LIMIT = 200_000

export function createPromptTraceRecorder(
  options: PromptTraceRecorderOptions,
): PromptTraceRecorder {
  const baseDir = options.traceGroup
    ? path.join(options.outDir, options.traceGroup)
    : options.outDir
  mkdirSync(baseDir, { recursive: true })

  const format = options.format ?? 'json'

  const writeTurn = (params: {
    turn: number
    attempt: number
    phase: 'initial' | 'followup'
    systemPrompt: string
    message: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
    responseSchema?: Record<string, unknown>
    attachments?: ChatAttachment[]
    mode?: DumpMode
    promptMode?: PromptMode
  }) => {
    const fileName = `turn-${String(params.turn).padStart(2, '0')}-${params.phase}-attempt-${params.attempt}`

    if (format === 'json' || format === 'both') {
      const payload = {
        turn: params.turn,
        phase: params.phase,
        attempt: params.attempt,
        tag: options.tag ?? null,
        traceGroup: options.traceGroup ?? null,
        mode: params.mode ?? 'chat',
        promptMode: params.promptMode ?? null,
        systemPrompt: params.systemPrompt,
        message: params.message,
        history: params.history,
        attachments: params.attachments ?? [],
        responseSchema: params.responseSchema ?? null,
      }
      writeFileSync(path.join(baseDir, `${fileName}.json`), JSON.stringify(payload, null, 2))
    }

    if (format === 'artifact' || format === 'both') {
      const artifact = formatAsArtifact({
        systemPrompt: params.systemPrompt,
        history: params.history,
        message: params.message,
        mode: params.mode ?? 'chat',
        promptMode: params.promptMode,
        attachments: params.attachments,
      })
      writeFileSync(path.join(baseDir, `${fileName}.txt`), artifact)
    }
  }

  const resultFileName = (input: { turn: number; attempt?: number; phase?: 'initial' | 'followup' }) =>
    `turn-${String(input.turn).padStart(2, '0')}-${input.phase ?? 'initial'}-attempt-${input.attempt ?? 1}.json`

  const appendResult = (input: PromptTraceResultInput) => {
    const filePath = path.join(baseDir, resultFileName(input))
    const existing = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
      : {
          turn: input.turn,
          phase: input.phase ?? 'initial',
          attempt: input.attempt ?? 1,
          tag: options.tag ?? null,
          traceGroup: options.traceGroup ?? null,
          mode: 'chat',
        }
    const payload = {
      ...existing,
      result: {
        rawResponse: compactTraceValue(input.rawResponse ?? null),
        message: input.message,
        trace: compactTraceValue(input.trace ?? null),
        actions: compactTraceValue(input.actions ?? []),
        actionResults: compactTraceValue(input.actionResults ?? []),
        historyAfterTurn: compactTraceValue(input.historyAfterTurn ?? null),
        nextMessage: compactTraceValue(input.nextMessage ?? null),
        notes: input.notes ?? [],
      },
    }
    writeFileSync(filePath, JSON.stringify(payload, null, 2))
  }

  return {
    outDir: baseDir,
    onBeforeChat: (info) => {
      writeTurn({
        turn: info.turn,
        attempt: info.attempt,
        phase: 'initial',
        systemPrompt: info.request.systemPrompt,
        message: info.request.message,
        history: info.request.history,
        responseSchema: info.request.responseSchema,
        attachments: info.request.attachments,
        promptMode: info.request.promptMode,
      })
    },
    record: ({ turn, attempt = 1, phase = 'initial', dumped }) => {
      writeTurn({
        turn,
        attempt,
        phase,
        systemPrompt: dumped.systemPrompt,
        message: dumped.message,
        history: dumped.history,
        responseSchema: dumped.responseSchema,
        attachments: dumped.attachments,
        mode: dumped.mode,
        promptMode: dumped.promptMode,
      })
    },
    recordTurnResult: appendResult,
  }
}

function compactTraceValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes <= TRACE_STRING_LIMIT) return value
    return {
      omitted: true,
      bytes,
      sha256: createHash('sha256').update(value).digest('hex'),
      preview: value.slice(0, 2000),
      note: `String exceeded prompt-trace limit of ${TRACE_STRING_LIMIT} bytes; preview plus hash retained.`,
    }
  }
  if (Array.isArray(value)) return value.map(item => compactTraceValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, compactTraceValue(child)]),
    )
  }
  return value
}

// ─── artifact formatter (shared) ─────────────────────────────────────────────

function formatAsArtifact(input: {
  systemPrompt: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  message: string
  mode: DumpMode
  promptMode?: PromptMode
  promptOrigin?: PromptOrigin
  attachments?: ChatAttachment[]
}): string {
  const bar = '═'.repeat(72)
  const thin = '─'.repeat(72)
  const lines: string[] = []
  lines.push(bar)
  lines.push(`  ARCHETYPE PROMPT DUMP — path: ${input.mode}; prompt mode: ${input.promptMode ?? 'unknown'}`)
  lines.push(bar)
  lines.push('')
  lines.push(thin)
  lines.push('  SYSTEM PROMPT')
  lines.push(thin)
  lines.push('')
  lines.push(input.systemPrompt)
  lines.push('')
  lines.push(thin)
  lines.push('  HISTORY')
  lines.push(thin)
  lines.push('')
  lines.push('Conversation turns sent outside the system prompt. Empty means no chat transcript was sent for this request.')
  if (input.history.length === 0) {
    lines.push('(empty)')
  } else {
    for (const m of input.history) {
      lines.push(`[${formatHistoryRole(m.role)}]`)
      lines.push(m.content)
      lines.push('')
    }
  }
  lines.push(thin)
  const currentHeader = input.promptOrigin === 'app' ? '  CURRENT APP EVENT' : '  USER MESSAGE'
  const currentDescription = input.promptOrigin === 'app'
    ? 'App/runtime-initiated current event. This is still model-visible input; read it as live continuity, not as a new external user request.'
    : 'Current user-visible message sent to the model for this turn.'
  lines.push(currentHeader)
  lines.push(thin)
  lines.push('')
  lines.push(currentDescription)
  lines.push('')
  lines.push(input.message)
  lines.push('')
  lines.push(thin)
  lines.push('  ATTACHMENTS')
  lines.push(thin)
  lines.push('')
  lines.push('Multimodal payloads sent with this request. Binary/base64 data is omitted from the dump; metadata is retained so reviewers can tell what the model saw.')
  const attachments = input.attachments ?? []
  if (attachments.length === 0) {
    lines.push('(none)')
  } else {
    attachments.forEach((attachment, index) => {
      lines.push(`${index + 1}. ${formatAttachmentSummary(attachment)}`)
    })
  }
  lines.push('')
  lines.push(bar)
  return lines.join('\n')
}

function formatHistoryRole(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'USER TURN' : 'ASSISTANT TURN'
}

function formatAttachmentSummary(attachment: ChatAttachment): string {
  const bytes = Buffer.byteLength(attachment.data, 'base64')
  return `${attachment.type}; ${attachment.mimeType}; ${bytes} byte(s) decoded`
}

export { formatAsArtifact }
