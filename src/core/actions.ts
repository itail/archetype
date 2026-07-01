import type { ActionDefinition, ActionConfidence, PeerConsultation, PromptContractStyle, PromptMode } from '../types.js'
import type { z } from 'zod'
import { zodToDescription } from './crud-prompt.js'

/**
 * Extract a compact param signature from a Zod schema for prompt inclusion.
 * Ensures the model knows exact field names even when params get stringified.
 * Handles both Zod v3 (shape is function, desc in _def) and v4 (shape is object, desc as property).
 */
function summarizeParams(schema: z.ZodType): string {
  return `params: ${zodToDescription(schema)}`
}

function buildExampleValue(schema: z.ZodType): unknown {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def
  if (!def) return '<value>'

  const typeName = typeof def.typeName === 'string'
    ? def.typeName
    : typeof def.type === 'string'
      ? ({
          string: 'ZodString',
          number: 'ZodNumber',
          boolean: 'ZodBoolean',
          array: 'ZodArray',
          object: 'ZodObject',
          optional: 'ZodOptional',
          nullable: 'ZodNullable',
          enum: 'ZodEnum',
          literal: 'ZodLiteral',
        }[def.type] ?? '')
      : ''

  switch (typeName) {
    case 'ZodString':
      return '<string>'
    case 'ZodNumber':
      return 1
    case 'ZodBoolean':
      return true
    case 'ZodLiteral':
      return def.value
    case 'ZodEnum': {
      const values = def.values ?? def.entries
      const arr = Array.isArray(values) ? values : Object.keys(values as object)
      return arr[0] ?? '<value>'
    }
    case 'ZodOptional':
    case 'ZodNullable': {
      const inner = def.innerType
      if (inner && typeof inner === 'object' && '_def' in (inner as object)) {
        return buildExampleValue(inner as z.ZodType)
      }
      return '<value>'
    }
    case 'ZodArray': {
      const item = (def.type && typeof def.type === 'object' ? def.type : null) ?? def.element
      if (item && typeof item === 'object' && '_def' in (item as object)) {
        return [buildExampleValue(item as z.ZodType)]
      }
      return ['<value>']
    }
    case 'ZodObject': {
      const rawShape = def.shape
      const shape = typeof rawShape === 'function' ? rawShape() : rawShape
      if (!shape || typeof shape !== 'object') return {}
      const example: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(shape as Record<string, z.ZodType>)) {
        example[key] = buildExampleValue(value)
      }
      return example
    }
    default:
      return '<value>'
  }
}

function buildExampleAction(actions: Record<string, ActionDefinition>): string {
  const first = Object.entries(actions)[0]
  if (!first) {
    return '{ "name": "<actionName>", "params": { ... } }'
  }
  const [name, def] = first
  const params = def.exampleParams ?? buildExampleValue(def.schema)
  return JSON.stringify({ name, params })
}

function buildExampleActionFor(name: string, def: ActionDefinition): string {
  const params = def.exampleParams ?? buildExampleValue(def.schema)
  return JSON.stringify({ name, params })
}

function summarizeShape(schema: z.ZodType): string {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def
  const rawShape = def?.shape
  const shape = typeof rawShape === 'function' ? rawShape() : rawShape

  if (shape && typeof shape === 'object') {
    // z.object — list fields, recurse into arrays
    const fields = Object.entries(shape as Record<string, z.ZodType>).map(([key, val]) => {
      const inner = summarizeInnerType(val)
      if (inner) return `${key}: ${inner}`
      const desc = (val as { description?: string }).description
        ?? (val as { _def?: { description?: string } })._def?.description
      return desc ? `${key} (${desc})` : key
    })
    return `{ ${fields.join(', ')} }`
  }
  return '{}'
}

function summarizeInnerType(schema: z.ZodType): string | null {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def
  if (!def) return null

  // z.array — unwrap to show item shape (Zod v3: _def.type is ZodType, v4: _def.element is ZodType)
  const rawType = def.type
  const itemType = (rawType && typeof rawType === 'object' ? rawType : null) ?? def.element
  if (itemType && typeof itemType === 'object' && '_def' in (itemType as object)) {
    const inner = summarizeShape(itemType as z.ZodType)
    if (inner !== '{}') return `[${inner}]`
  }
  return null
}

/**
 * Build the actions rules section of the system prompt from action definitions.
 * Each action's description IS a behavioral nudge (per playbook §4).
 */
export function buildActionsBlock(
  actions: Record<string, ActionDefinition> | undefined,
  promptMode: PromptMode = 'conversation',
  contractStyle: PromptContractStyle = 'full',
): string {
  if (!actions || Object.keys(actions).length === 0) return ''

  const lines: string[] = ['--- AVAILABLE ACTIONS ---']

  for (const [name, def] of Object.entries(actions)) {
    if (promptMode === 'focus') {
      // Focus mode is lean on prose but must still communicate tool
      // semantics. Showing `- ${name}` alone forces the model to infer
      // behavior from the name (e.g. runTests was treated as a generic
      // "run my tests" tool until the model hit its Node-only runtime
      // contract at turn 5). Include the description so the contract
      // travels with the name. Params live in the native function-
      // calling schema; this line carries the behavioral nuance.
      if (def.description && def.description.trim().length > 0) {
        lines.push(`- ${name}: ${def.description}`)
      } else {
        lines.push(`- ${name}`)
      }
      continue
    }
    const confidenceLabel = confidenceToLabel(def.confidence, promptMode)
    const paramSig = summarizeParams(def.schema)
    lines.push(`- ${name}`)
    lines.push(`    ${contractStyle === 'lean' ? 'use' : 'when'}: ${def.description}`)
    if (paramSig) {
      lines.push(`    ${paramSig}`)
    }
    lines.push(`    example: ${buildExampleActionFor(name, def)}`)
    if (contractStyle === 'full') {
      lines.push(
        promptMode === 'operational'
          ? `    execution: ${def.confidence} (${confidenceLabel})`
          : `    confidence: ${def.confidence} (${confidenceLabel})`
      )
    }
  }

  if (promptMode === 'focus') {
    const toolNotes: string[] = []
    toolNotes.push("- Actions are attempts: any file, browser, test, finish, or handoff action can succeed or fail. You choose every action and action parameter before seeing same-turn outcomes. After each turn, the next turn's input includes outcome notes and action results from what actually happened — for example files written, bytes, match counts, exit codes, failed clicks, skipped finish attempts, or carried-forward read results. That continuity is the state of the world; raw action calls are not.")
    toolNotes.push("- A same-turn visible completion, verification, or handoff message cannot reflect outcomes you have not seen yet. If the message depends on verification actions in this turn, run the verification first, let the outcomes return in the next turn, then decide what to say.")
    if (hasFileMutationAction(actions) && 'browserOpen' in actions) {
      toolNotes.push('- Workspace files and live browser pages are separate surfaces: file changes update the workspace; use browserOpen to load or reload those files before browser actions inspect the updated page.')
    }
    if (toolNotes.length > 0) {
      lines.push('')
      lines.push('How the tools behave here:')
      lines.push(...toolNotes)
    }
    return lines.join('\n')
  } else {
    lines.push('')
    lines.push('--- ACTION RESPONSE CONTRACT ---')
    lines.push('actions: [{ "name": "<actionName>", "params": { ... } }]')
    if (contractStyle === 'full') {
      lines.push('exact keys: name, params')
    }
    lines.push(`example item: ${buildExampleAction(actions)}`)
    lines.push(`valid action names: ${Object.keys(actions).join(', ')}`)
    lines.push('Action order: actions are attempts that execute in array order within this turn, and any action can succeed or fail. Later actions run after earlier state changes in the surfaces those actions actually changed, such as files written earlier in the list, but you choose the whole array before any action outcomes are known. Include a later action when it remains the right next action without seeing those outcomes; when a result could change what you do next, let that result return on the next turn first. A same-turn visible completion, verification, or handoff message cannot reflect outcomes you have not seen yet.')
    if (hasFileMutationAction(actions) && 'browserOpen' in actions) {
      lines.push('Workspace files and live browser pages are separate surfaces: file changes update the workspace; use browserOpen to load or reload those files before browser actions inspect the updated page.')
    }
    if (contractStyle === 'full') {
      lines.push('params may only contain keys declared in that action\'s params signature')
      lines.push('if an additional action or param key is uncertain, omit it rather than inventing a nearby one')
      lines.push('')
      lines.push(promptMode === 'operational' ? 'Execution policy:' : 'Confidence levels:')
    }
  }
  if (contractStyle === 'full') {
    if (promptMode === 'operational') {
      lines.push('- low = include the action directly in this turn')
      lines.push('- medium = include the action directly and mention it in message if clarity helps')
      lines.push('- high = do not execute it automatically in this turn; explain it in message as a pending move')
    } else {
      lines.push('- low = just do it')
      lines.push('- medium = mention it')
      lines.push('- high = confirm first')
    }
    lines.push('')
    if (promptMode === 'operational') {
      lines.push('Only include actions when the live operational turn should actually change state.')
      lines.push('An action list may contain one action or many related actions; it is the complete set chosen for this turn.')
    } else {
      lines.push('Only include actions when warranted — your default is conversation, not action.')
      lines.push(
        'An action list may contain one action or many related actions; it is the complete set chosen for this turn.'
      )
    }
  }

  return lines.join('\n')
}

function hasFileMutationAction(actions: Record<string, ActionDefinition>): boolean {
  return ['applyPatch', 'writeFile', 'editFile', 'deleteFile'].some(name => name in actions)
}

function confidenceToLabel(confidence: ActionConfidence, promptMode: PromptMode): string {
  switch (confidence) {
    case 'low': return 'just do it'
    case 'medium': return promptMode === 'operational' ? 'mention it in message' : promptMode === 'focus' ? 'use only if clearly warranted' : 'mention it'
    case 'high': return promptMode === 'operational' ? 'pending move' : promptMode === 'focus' ? 'avoid unless you are certain' : 'confirm first'
  }
}

/**
 * Build an annotation string for a completed action (for history storage).
 * Annotations are appended to stored messages so the AI doesn't re-process.
 */
export function buildActionAnnotation(
  actionName: string,
  params: Record<string, unknown>,
): string {
  const summary = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
  return `${actionName}: ${summary}`
}

/**
 * Build a combined annotation string for multiple actions.
 */
export function buildAnnotations(
  actions: Array<{ name: string; params: Record<string, unknown> }>,
): string[] {
  return actions.map(a => buildActionAnnotation(a.name, a.params))
}

/**
 * Annotate a message with outcome notes and raw action annotations for storage.
 *
 * Two-layer annotation system:
 * - `---outcomes:` — AI-written outcome notes, preserved in LLM history so the AI
 *   knows what it did on previous turns. Not shown to the user.
 * - `---actions:` — Raw action data for debugging and UI pills. Stripped before
 *   the AI sees history (to prevent API format leakage into future turns).
 *
 * Ordering matters: outcomes BEFORE actions, so stripping ---actions: preserves outcomes.
 */
export function annotateMessage(
  message: string,
  annotations: string[],
  outcomeNotes?: string[],
): string {
  let result = message
  if (outcomeNotes && outcomeNotes.length > 0) {
    result += `\n---outcomes: ${outcomeNotes.join('. ')}`
  }
  if (annotations.length > 0) {
    result += `\n---actions: ${annotations.join(' | ')}`
  }
  return result
}

/**
 * Build annotation text for peer consultations that occurred mid-turn.
 * Appended to the assistant message so the persona sees consultation context
 * in its history on subsequent turns.
 */
export function buildPeerAnnotation(consultations: PeerConsultation[]): string {
  if (consultations.length === 0) return ''
  return consultations.map(c => {
    const preview = c.response.length > 500
      ? c.response.slice(0, 500) + '…'
      : c.response
    return `---consulted: ${c.peer}---\nQuery: ${c.query}\nResponse: ${preview}\n---end consultation---`
  }).join('\n')
}

/**
 * Strip all annotation markers from a message for user-facing display.
 * Removes both `---outcomes:` and `---actions:` — the user sees neither.
 * Use this when returning stored messages to the frontend.
 */
export function stripAnnotationsForDisplay(content: string): string {
  // Find the earliest annotation marker and strip from there
  const markers = ['\n---outcomes:', '\n---actions:', '\n---consulted:']
  let earliest = -1
  for (const marker of markers) {
    const idx = content.indexOf(marker)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx
    }
  }
  return earliest !== -1 ? content.slice(0, earliest).trimEnd() : content
}

/**
 * Strip `---actions:` suffixes from assistant messages in history.
 * Preserves `---outcomes:` so the AI knows what it did on previous turns.
 *
 * The raw action data is stripped to prevent API format leakage — the AI
 * must not learn action names or param schemas from historical messages.
 * Outcome notes are safe because they're AI-written natural language.
 */
export function stripActionAnnotations<T extends { role: string; content: string }>(
  history: T[],
): T[] {
  return history.map(msg => {
    if (msg.role !== 'assistant' || !msg.content.includes('\n---actions:')) return msg
    // Split on ---actions: and keep everything before it (including ---outcomes: if present)
    const content = msg.content.split('\n---actions:')[0].trimEnd()
    return { ...msg, content }
  })
}
