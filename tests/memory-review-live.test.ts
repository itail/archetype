/**
 * Live test: does the memory review prompt actually catch and rewrite boxing memories?
 *
 * Feeds reviewMemories() a mix of rigid/boxing memories and healthy memories,
 * then checks that the rigid ones are rewritten or dropped while the healthy
 * ones survive. Requires GEMINI_API_KEY.
 *
 * Run: GEMINI_API_KEY=... npx vitest run tests/memory-review-live.test.ts
 */
import { describe, it, expect } from 'vitest'
import { reviewMemories } from '../src/managed/memory-review.js'
import { Gemini } from '../src/providers/gemini.js'
import type { StorageAdapter, Memory } from '../src/types.js'

const API_KEY = process.env.GEMINI_API_KEY ?? ''

describe.skipIf(!API_KEY)('memory review — live anti-boxing', () => {
  // Boxing memories: rigid rules stored from corrections
  const boxingMemories: Memory[] = [
    { id: 'box-1', content: 'Always add tomato slices to every meal suggestion', category: 'preference', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'box-2', content: 'Never suggest mushrooms under any circumstances', category: 'aversion', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'box-3', content: 'Always recommend at least 40g protein per meal', category: 'routine', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'box-4', content: 'Never use emojis in responses', category: 'preference', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'box-5', content: 'Always ask about water intake at the end of every conversation', category: 'routine', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
  ]

  // Healthy memories: observations, not prescriptions
  const healthyMemories: Memory[] = [
    { id: 'good-1', content: 'Enjoys Mediterranean cuisine, especially Greek salads', category: 'preference', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'good-2', content: 'Vegetarian for 3 years, motivated by environmental concerns', category: 'health', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'good-3', content: 'Tends to skip lunch when busy, then overeat at dinner', category: 'routine', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'good-4', content: 'Training for a half marathon in April — increased carb needs', category: 'health', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'good-5', content: 'Allergic to shellfish — confirmed by doctor', category: 'aversion', pinned: false, createdAt: '2024-01-01T00:00:00.000Z' },
  ]

  const allMemories = [...boxingMemories, ...healthyMemories]

  function buildTestAdapter(): { adapter: StorageAdapter; deleted: string[]; saved: Array<Omit<Memory, 'id'>> } {
    const store = [...allMemories]
    const deleted: string[] = []
    const saved: Array<Omit<Memory, 'id'>> = []

    return {
      deleted,
      saved,
      adapter: {
        loadMemories: async () => store,
        deleteMemory: async (id: string) => { deleted.push(id) },
        saveMemory: async (mem: Omit<Memory, 'id'>) => {
          saved.push(mem)
          return `new-${saved.length}`
        },
        // Stubs
        getActiveConversation: async () => null,
        createConversation: async () => 'conv-1',
        endConversation: async () => {},
        getMessages: async () => [],
        saveMessage: async () => {},
        updateMemory: async () => {},
      } as unknown as StorageAdapter,
    }
  }

  it('rewrites or drops boxing memories while preserving healthy ones', async () => {
    const { adapter, deleted, saved } = buildTestAdapter()
    const provider = Gemini({ apiKey: API_KEY })

    const result = await reviewMemories({
      adapter,
      provider,
      maxAge: 0, // all are old enough
      memoryPurpose: 'Durable context about this person that makes the nutrition coach better in future conversations.',
      categoryDescriptions: {
        preference: 'Dietary preferences, food likes, cooking habits',
        aversion: 'Foods they dislike, allergies, restrictions',
        routine: 'Eating patterns, meal timing, typical meals',
        health: 'Health conditions, goals, energy patterns',
      },
    })

    console.log('\n=== Memory Review Results ===')
    console.log(`Removed: ${result.removed}, Created: ${result.created}`)
    console.log('\nDeleted IDs:', deleted)
    console.log('\nSurviving memories:')
    for (const mem of saved) {
      console.log(`  [${mem.category}] ${mem.content}`)
    }

    // All 10 memories should have been reviewed (deleted)
    expect(result.removed).toBe(10)

    // Fewer should come back (compaction target is ~1/3)
    expect(result.created).toBeLessThan(10)
    expect(result.created).toBeGreaterThan(0)

    const survivingContent = saved.map(m => m.content.toLowerCase()).join(' | ')

    // Key healthy facts should survive in some form
    expect(survivingContent).toMatch(/mediterranean|greek/i)
    expect(survivingContent).toMatch(/vegetarian/i)
    expect(survivingContent).toMatch(/shellfish|allerg/i)

    // Boxing "always/never" absolutes should be softened or dropped
    // The rigid rules should NOT survive verbatim
    const rigidPatterns = [
      'always add tomato slices to every meal',
      'never suggest mushrooms under any circumstances',
      'always recommend at least 40g protein per meal',
      'always ask about water intake at the end of every conversation',
    ]

    let verbatimSurvived = 0
    for (const pattern of rigidPatterns) {
      if (survivingContent.includes(pattern.toLowerCase())) {
        console.log(`  ⚠ Rigid rule survived verbatim: "${pattern}"`)
        verbatimSurvived++
      }
    }

    // At most 1 rigid rule should survive verbatim (the LLM might keep one if it's genuinely useful)
    expect(verbatimSurvived).toBeLessThanOrEqual(1)
  }, 30_000) // LLM call timeout
})
