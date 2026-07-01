/**
 * Nutrition Guide — full reference sample app.
 *
 * Demonstrates the recommended integration pattern:
 *   managed mode → chat → filter memory CRUD → commitCrud for domain entities
 *   exact prompt review → buildChatLLMRequest / buildPromptedTurnLLMRequest when tuning
 *   app-initiated turns → promptedTurn({ turnKind: 'proactive-conversation' | 'operational' })
 *
 * Run: npx tsx examples/nutrition-guide/server.ts
 * Requires: GEMINI_API_KEY env var
 */
import {
  definePersona,
  withStorage,
  commitCrud,
  createMarkdownKnowledgeAdapter,
  Gemini,
  type CrudEntityHandler,
  type StorageAdapter,
  type TurnTrace,
} from '../../src/index.js'
import { NUTRITION_TEMPLATE } from '../../src/playbook/templates.js'
import { fileURLToPath } from 'node:url'

// ─── In-memory storage (replace with your real database) ─────────────────────

const store = {
  conversations: new Map<string, { metadata?: Record<string, unknown> }>(),
  messages: new Map<string, Array<{ role: string; content: string; isNote?: boolean; createdAt?: string }>>(),
  memories: new Map<string, { id: string; content: string; category: string; pinned?: boolean; createdAt?: string }>(),
  meals: new Map<string, Record<string, unknown>>(),
  traces: new Map<string, TurnTrace[]>(),
}

const adapter: StorageAdapter = {
  async createConversation(metadata) {
    const id = `conv-${Date.now()}`
    store.conversations.set(id, { metadata })
    store.messages.set(id, [])
    return id
  },
  async getConversation(id) {
    const conv = store.conversations.get(id)
    return conv ? { id, createdAt: new Date().toISOString(), ...conv } : null
  },
  async saveMessage(conversationId, message) {
    const msgs = store.messages.get(conversationId) ?? []
    msgs.push({ ...message, createdAt: new Date().toISOString() })
    store.messages.set(conversationId, msgs)
  },
  async getMessages(conversationId, limit) {
    const msgs = store.messages.get(conversationId) ?? []
    return msgs.slice(-(limit ?? 30)).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      isNote: m.isNote,
      createdAt: m.createdAt,
    }))
  },
  async loadMemories() {
    return [...store.memories.values()]
  },
  async saveMemory(memory) {
    store.memories.set(memory.id, memory)
  },
  async updateMemory(id, updates) {
    const existing = store.memories.get(id)
    if (existing) store.memories.set(id, { ...existing, ...updates })
  },
  async deleteMemory(id) {
    store.memories.delete(id)
  },
  async saveTrace(conversationId, trace) {
    const existing = store.traces.get(conversationId) ?? []
    existing.push(trace)
    store.traces.set(conversationId, existing)
  },
}

// ─── Persona (managed mode) ──────────────────────────────────────────────────

const engine = definePersona({
  ...NUTRITION_TEMPLATE,
  knowledge: {
    purpose: 'grounding nutrition advice in the durable program docs and capabilities that the guide should not improvise',
    budget: 3500,
  },
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

const knowledgeDir = fileURLToPath(new URL('./knowledge', import.meta.url))

const managed = withStorage(engine, {
  adapter,
  historyLimit: 30,
  memoryBudget: 5000,
  knowledge: {
    adapter: createMarkdownKnowledgeAdapter({ rootDir: knowledgeDir }),
    budget: 3500,
  },
})

// ─── Domain CRUD handlers ────────────────────────────────────────────────────

const mealHandler: CrudEntityHandler = {
  async create(id, params) {
    store.meals.set(id, { id, ...params, loggedAt: new Date().toISOString() })
    console.log(`  [meal] created: ${params.name ?? id}`)
    return { success: true }
  },
  async update(id, params) {
    const existing = store.meals.get(id)
    if (!existing) return { success: false, error: `Meal ${id} not found` }
    store.meals.set(id, { ...existing, ...params })
    console.log(`  [meal] updated: ${id}`)
    return { success: true }
  },
  async delete(id) {
    store.meals.delete(id)
    console.log(`  [meal] deleted: ${id}`)
    return { success: true }
  },
}

// ─── Demo turn ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${engine.name} (managed mode)\n`)

  const result = await managed.chat({
    message: 'I just had grilled salmon with quinoa and roasted vegetables for lunch. Maybe 650 calories. Log it.',
    context: {
      todayStatus: {
        date: new Date().toISOString().slice(0, 10),
        consumed: '400 cal so far (oatmeal breakfast)',
        remaining: '~1400 cal, 120g protein',
      },
      profile: { name: 'Jamie', goal: 'Lose weight', dailyTargets: '1800 cal, 150g protein' },
    },
    timezone: 'America/New_York',
    userIdentity: 'Jamie',
  })

  console.log('Response:', result.message)

  // Memory CRUD is handled automatically by managed mode.
  // Filter it out and commit only domain entity CRUD.
  const memoryCrudEntities = new Set(['memory', 'craftMemory'])
  const domainCrud = (result.crudActions ?? []).filter(a => !memoryCrudEntities.has(a.entity))

  if (domainCrud.length > 0) {
    console.log('\nCommitting domain entity changes:')
    await commitCrud(domainCrud, { meal: mealHandler })
  }

  if (result.actions?.length) {
    console.log('\nNamed actions (rare):', JSON.stringify(result.actions, null, 2))
  }

  console.log('\nOutcome notes:', result.outcomeNotes)
  console.log('Meals in store:', [...store.meals.values()])
}

main().catch(console.error)
