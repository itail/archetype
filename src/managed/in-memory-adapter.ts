import type { StorageAdapter, Memory, Message, Conversation, TurnTrace } from '../types.js'

/**
 * A complete in-memory StorageAdapter — the fastest way to a working managed
 * persona. Perfect for the quick start, prototypes, and tests; swap in a real
 * database adapter (same interface) when you need persistence across restarts.
 *
 * Includes craft-memory support so every managed-mode feature works out of
 * the box. Call `.dump()` to inspect state.
 */
export interface InMemoryAdapter extends StorageAdapter {
  /** Snapshot of everything stored — handy for debugging and tests. */
  dump(): {
    conversation: Conversation | null
    messages: Message[]
    memories: Memory[]
    craftMemories: Memory[]
    traces: TurnTrace[]
  }
}

export function createInMemoryAdapter(): InMemoryAdapter {
  let conversation: Conversation | null = null
  const messages: Message[] = []
  const memories: Memory[] = []
  const craftMemories: Memory[] = []
  const traces: Array<{ conversationId: string; trace: TurnTrace }> = []
  let counter = 0

  return {
    async getActiveConversation() {
      return conversation
    },
    async createConversation(trigger, metadata) {
      conversation = { id: `conv-${++counter}`, trigger, createdAt: new Date().toISOString(), metadata }
      return conversation.id
    },
    async endConversation() {
      conversation = null
    },
    async getMessages(_conversationId, limit) {
      return messages.slice(-limit).map(m => ({ ...m }))
    },
    async saveMessage(_conversationId, msg) {
      messages.push({ ...msg, createdAt: new Date().toISOString() })
    },
    async loadMemories() {
      return memories.map(m => ({ ...m }))
    },
    async saveMemory(mem) {
      const id = `mem-${++counter}`
      memories.push({ ...mem, id, createdAt: new Date().toISOString() })
      return id
    },
    async updateMemory(id, updates) {
      const m = memories.find(m => m.id === id)
      if (m) Object.assign(m, updates)
    },
    async deleteMemory(id) {
      const idx = memories.findIndex(m => m.id === id)
      if (idx >= 0) memories.splice(idx, 1)
    },
    async loadCraftMemories() {
      return craftMemories.map(m => ({ ...m }))
    },
    async saveCraftMemory(mem) {
      const id = `craft-${++counter}`
      craftMemories.push({ ...mem, id, createdAt: new Date().toISOString() })
      return id
    },
    async updateCraftMemory(id, updates) {
      const m = craftMemories.find(m => m.id === id)
      if (m) Object.assign(m, updates)
    },
    async deleteCraftMemory(id) {
      const idx = craftMemories.findIndex(m => m.id === id)
      if (idx >= 0) craftMemories.splice(idx, 1)
    },
    async saveTrace(conversationId, trace) {
      traces.push({ conversationId, trace })
    },
    async getTraces(conversationId, options) {
      return traces
        .filter(t => t.conversationId === conversationId)
        .slice(-(options?.limit ?? 50))
        .map(t => t.trace)
    },
    dump() {
      return { conversation, messages, memories, craftMemories, traces: traces.map(t => t.trace) }
    },
  }
}
