import type { StorageAdapter, Conversation, Message } from '../types.js'
import {
  buildAttachmentCarryForwardSection,
  collectAttachmentCarryForwardNotes,
} from '../core/attachment-notes.js'

/**
 * Resolve or create a conversation.
 * Returns the conversation ID (existing or newly created).
 */
export async function resolveConversation(
  adapter: StorageAdapter,
  conversationId?: string | null,
  trigger?: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  if (conversationId) return conversationId

  // Try to find an active conversation
  const active = await adapter.getActiveConversation()
  if (active) return active.id

  // Create a new one
  return adapter.createConversation(trigger ?? 'manual', metadata)
}

/**
 * Load conversation history for LLM input.
 * Returns non-note messages in chronological order, up to limit.
 */
export async function loadHistory(
  adapter: StorageAdapter,
  conversationId: string,
  limit: number,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const messages = await adapter.getMessages(conversationId, limit)
  return messages
    .filter(m => !m.isNote && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

export async function loadAttachmentCarryForwardSections(
  adapter: StorageAdapter,
  conversationId: string,
  limit: number,
): Promise<string[]> {
  const messages = await adapter.getMessages(conversationId, limit)
  const notes = collectAttachmentCarryForwardNotes(messages)
  if (notes.length === 0) return []

  const section = buildAttachmentCarryForwardSection(notes)
  return section ? [section] : []
}

/**
 * End a conversation by setting its endedAt timestamp.
 */
export async function endConversation(
  adapter: StorageAdapter,
  conversationId: string,
): Promise<void> {
  await adapter.endConversation(conversationId)
}
