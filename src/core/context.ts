import type { ContextInputDefinition } from '../types.js'

/**
 * Serialize a single context block into a labeled prompt section.
 */
export function serializeContextBlock(
  key: string,
  definition: ContextInputDefinition,
  data: unknown,
): string {
  if (data == null) return ''

  const label = definition.label
  const format = definition.format ?? 'block'

  let body: string

  const includeIds = definition.includeIds ?? false

  if (Array.isArray(data)) {
    if (data.length === 0) {
      body = '(none)'
    } else {
      body = formatArray(data, format, includeIds)
    }
  } else if (typeof data === 'string') {
    body = data
  } else if (typeof data === 'object') {
    body = formatObject(data as Record<string, unknown>, format)
  } else {
    body = String(data)
  }

  // Apply budget if defined
  if (definition.budget && body.length > definition.budget) {
    body = body.slice(0, definition.budget) + '\n... (truncated to budget)'
  }

  const priority = definition.priority === 'critical' ? ' [CRITICAL]' : ''
  const intentLine = definition.intent?.trim()
    ? `Intent: ${definition.intent.trim()}\n`
    : ''
  return `--- ${label}${priority} ---\n${intentLine}${body}`
}

/**
 * Serialize all context inputs into prompt sections, respecting budgets.
 */
export function serializeAllContext(
  definitions: Record<string, ContextInputDefinition>,
  data: Record<string, unknown>,
): string {
  const blocks: string[] = []

  for (const [key, def] of Object.entries(definitions)) {
    const value = data[key]
    if (value == null) continue
    const block = serializeContextBlock(key, def, value)
    if (block) blocks.push(block)
  }

  return blocks.join('\n\n')
}

function formatArray(items: unknown[], format: string, includeIds: boolean = false): string {
  return items.map(item => {
    if (typeof item === 'string') return `- ${item}`
    if (typeof item === 'object' && item !== null) {
      return formatObjectAsListItem(item as Record<string, unknown>, format, includeIds)
    }
    return `- ${String(item)}`
  }).join('\n')
}

function formatObjectAsListItem(obj: Record<string, unknown>, format: string, includeIds: boolean = false): string {
  if (format === 'kv') {
    return Object.entries(obj)
      .filter(([k]) => !includeIds || k !== 'id') // id shown as prefix when includeIds
      .map(([k, v]) => `  ${k}: ${String(v)}`)
      .join('\n')
  }

  // Default: try to build a sensible one-liner
  const id = obj['id'] || obj['entityId']
  const title = obj['title'] || obj['name'] || obj['summary'] || obj['text'] || obj['what'] || obj['content']
  const status = obj['status']
  const extra: string[] = []

  for (const [k, v] of Object.entries(obj)) {
    if (['id', 'entityId', 'title', 'name', 'summary', 'text', 'what', 'content', 'status'].includes(k)) continue
    if (v != null && v !== '') {
      extra.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
  }

  let line = '- '
  if (includeIds && id) {
    line += `(id:${id}) `
  }
  if (status) line += `[${status}] `
  if (title) line += `${title}`
  if (!includeIds && id) line += ` [${id}]`
  if (extra.length > 0) line += ` — ${extra.join(', ')}`
  return line
}

function formatObject(obj: Record<string, unknown>, format: string): string {
  if (format === 'kv') {
    return Object.entries(obj)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n')
  }
  return Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n')
}
