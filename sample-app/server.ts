/**
 * Archetype Sample App — Nutrition Guide
 *
 * A fully working chat app demonstrating the Archetype SDK.
 * Run: npm start (requires GEMINI_API_KEY env var)
 */
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  definePersona,
  withStorage,
  commitCrud,
  Gemini,
  NUTRITION_TEMPLATE,
} from '../src/index.js'
import type {
  StorageAdapter,
  Conversation,
  Message,
  Memory,
  TurnTrace,
  CrudAction,
} from '../src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// ─── In-memory stores ───────────────────────────────────────────────────────

interface Meal {
  id: string
  name: string
  calories?: number
  protein?: number
  date: string    // YYYY-MM-DD in user's local timezone
  loggedAt: string
}

let conversation: Conversation | null = null
const messages: (Message & { createdAt: string })[] = []
const memories: (Memory & { createdAt: string })[] = []
const traces: { conversationId: string; trace: TurnTrace }[] = []
const meals: Meal[] = []
let memoryCounter = 0

// ─── In-memory StorageAdapter ───────────────────────────────────────────────

const adapter: StorageAdapter = {
  async getActiveConversation() {
    return conversation
  },
  async createConversation(trigger, metadata) {
    conversation = { id: 'conv-1', trigger, createdAt: new Date().toISOString(), metadata }
    return 'conv-1'
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
    const id = `mem-${++memoryCounter}`
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
  async saveTrace(conversationId, trace) {
    traces.push({ conversationId, trace })
  },
  async getTraces(conversationId, options) {
    return traces
      .filter(t => t.conversationId === conversationId)
      .slice(-(options?.limit ?? 50))
      .map(t => t.trace)
  },
}

// ─── CRUD handlers for domain entities ──────────────────────────────────────

function buildHandlers(tz?: string) {
  return {
    meal: {
      create: async (id: string, params: Record<string, unknown>) => {
        meals.push({
          id,
          name: String(params.name ?? ''),
          calories: typeof params.calories === 'number' ? params.calories : undefined,
          protein: typeof params.protein === 'number' ? params.protein : undefined,
          date: todayFor(tz),
          loggedAt: new Date().toISOString(),
        })
        return { success: true }
      },
      update: async (id: string, params: Record<string, unknown>) => {
        const meal = meals.find(m => m.id === id)
        if (!meal) return { success: false, error: `Meal not found: ${id}` }
        if (typeof params.name === 'string') meal.name = params.name
        if (typeof params.calories === 'number') meal.calories = params.calories
        if (typeof params.protein === 'number') meal.protein = params.protein
        return { success: true }
      },
      delete: async (id: string) => {
        const idx = meals.findIndex(m => m.id === id)
        if (idx < 0) return { success: false, error: `Meal not found: ${id}` }
        meals.splice(idx, 1)
        return { success: true }
      },
    },
  }
}

// ─── Debug ──────────────────────────────────────────────────────────────────

function collectDebugCrud(actions: CrudAction[]): Array<Record<string, unknown>> | null {
  if (actions.length === 0) return null
  return actions.map(action => ({
    operation: action.operation,
    entity: action.entity,
    id: action.id ?? null,
    params: action.params ?? {},
  }))
}

// ─── Persona setup ──────────────────────────────────────────────────────────

const engine = definePersona({
  ...NUTRITION_TEMPLATE,
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

const managed = withStorage(engine, {
  adapter,
  historyLimit: 30,
  memoryBudget: 5000,
})

// ─── Express server ─────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '5mb' }))
app.use(express.static(path.join(__dirname, 'public')))

function todayFor(tz?: string): string {
  return new Date().toLocaleDateString('en-CA', tz ? { timeZone: tz } : undefined)
}

function todayMeals(tz?: string) {
  const today = todayFor(tz)
  return meals.filter(m => m.date === today)
}

function buildContext(tz?: string) {
  const tm = todayMeals(tz)
  const context: Record<string, unknown> = {}

  if (tm.length > 0) {
    const totalCal = tm.reduce((s, m) => s + (m.calories ?? 0), 0)
    const totalProtein = tm.reduce((s, m) => s + (m.protein ?? 0), 0)
    context.todayStatus = {
      date: todayFor(tz),
      consumed: `${totalCal} cal, ${totalProtein}g protein`,
      mealsLogged: tm.length,
    }
  }

  return context
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, image } = req.body as { message: string; image?: string }
    if (!message?.trim() && !image) return res.status(400).json({ error: 'Message or image required' })

    const timezoneHeader = req.headers['x-timezone']
    const timezone = typeof timezoneHeader === 'string' && timezoneHeader.trim() ? timezoneHeader : undefined

    const attachments = image ? [{
      type: 'image' as const,
      mimeType: image.match(/^data:(image\/\w+);/)?.[1] ?? 'image/jpeg',
      data: image.replace(/^data:image\/\w+;base64,/, ''),
    }] : undefined

    const result = await managed.chat({
      message: message || '',
      context: buildContext(timezone),
      timezone,
      attachments,
    })

    // In managed mode, memory CRUD is SDK-owned. Commit only domain entities here.
    const memoryCrudEntities = new Set(['memory', 'craftMemory'])
    const domainCrud = (result.crudActions ?? []).filter(a => !memoryCrudEntities.has(a.entity))
    const commitResults = await commitCrud(domainCrud, buildHandlers(timezone), { trace: result.trace })
    const failedCommits = commitResults.filter(r => !r.success)

    if (failedCommits.length > 0) {
      return res.status(500).json({
        error: 'Failed to commit one or more meal changes',
        details: failedCommits,
      })
    }

    const debug = collectDebugCrud(result.crudActions ?? [])
    if (debug) console.log('[debug]', JSON.stringify(debug, null, 2))

    res.json({
      message: result.message,
      followUps: result.followUps ?? [],
      meals: todayMeals(timezone),
      debug,
    })
  } catch (err) {
    console.error('Chat error:', err)
    res.status(500).json({ error: 'Something went wrong' })
  }
})

// Greeting endpoint
app.post('/api/greeting', async (req, res) => {
  try {
    const timezoneHeader = req.headers['x-timezone']
    const timezone = typeof timezoneHeader === 'string' && timezoneHeader.trim() ? timezoneHeader : undefined
    const result = await managed.greet({
      context: buildContext(timezone),
      timezone,
    })
    res.json({ greeting: result.greeting })
  } catch (err) {
    console.error('Greeting error:', err)
    res.json({ greeting: null })
  }
})

// Reset — clear all state for a fresh first meeting
app.post('/api/reset', (_req, res) => {
  conversation = null
  messages.length = 0
  memories.length = 0
  traces.length = 0
  meals.length = 0
  memoryCounter = 0
  console.log('[reset] All state cleared')
  res.json({ ok: true })
})

// Ledger endpoints
app.get('/api/ledger', (req, res) => {
  const tz = (req.headers['x-timezone'] as string) || undefined
  res.json({
    meals: todayMeals(tz),
    memories: memories.map(m => ({ id: m.id, content: m.content, category: m.category })),
  })
})

app.put('/api/meals/:id', (req, res) => {
  const meal = meals.find(m => m.id === req.params.id)
  if (!meal) return res.status(404).json({ error: 'Not found' })
  const { name, calories, protein } = req.body as Partial<Meal>
  if (name !== undefined) meal.name = name
  if (calories !== undefined) meal.calories = calories
  if (protein !== undefined) meal.protein = protein
  res.json({ meal })
})

app.delete('/api/meals/:id', (req, res) => {
  const idx = meals.findIndex(m => m.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: 'Not found' })
  meals.splice(idx, 1)
  res.json({ ok: true })
})

app.listen(PORT, () => {
  console.log(`\n  Archetype Sample App`)
  console.log(`  http://localhost:${PORT}\n`)
})
