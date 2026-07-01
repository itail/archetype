const ATTACHMENT_NOTE_MESSAGE_PREFIX = '__archetype_attachment_notes__'

function normalizeNotes(notes: string[]): string[] {
  return [...new Set(notes.map(note => note.trim()).filter(Boolean))]
}

export function buildAttachmentCarryForwardMessage(notes: string[]): string {
  return `${ATTACHMENT_NOTE_MESSAGE_PREFIX}\n${JSON.stringify(normalizeNotes(notes))}`
}

export function parseAttachmentCarryForwardMessage(content: string): string[] {
  if (!content.startsWith(ATTACHMENT_NOTE_MESSAGE_PREFIX)) return []

  const json = content.slice(ATTACHMENT_NOTE_MESSAGE_PREFIX.length).trim()
  if (!json) return []

  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return normalizeNotes(parsed.map(item => String(item)))
  } catch {
    return []
  }
}

export function buildAttachmentCarryForwardSection(notes: string[]): string {
  const normalized = normalizeNotes(notes)
  if (normalized.length === 0) return ''

  return [
    'PRIOR IMAGE CONTEXT:',
    ...normalized.map(note => `- ${note}`),
    'These are compact carry-forward notes about earlier uploaded images. Use them when relevant, but do not pretend you can still inspect the raw image.',
  ].join('\n')
}

export function collectAttachmentCarryForwardNotes(
  messages: Array<{ content: string }>,
): string[] {
  const notes = messages.flatMap(message => parseAttachmentCarryForwardMessage(message.content))
  return normalizeNotes(notes)
}
