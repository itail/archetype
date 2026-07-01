import { describe, it, expect } from 'vitest'
import { selectMemoriesForPrompt, buildMemoryBlock, inferMemoryCategory } from '../src/core/memory.js'
import type { Memory } from '../src/types.js'

const memories: Memory[] = [
  { id: '1', content: 'Prefers direct pushback when stuck', category: 'approach', pinned: true, createdAt: '2025-01-01' },
  { id: '2', content: 'Company is optimizing for speed over perfection', category: 'context', pinned: true, createdAt: '2025-01-02' },
  { id: '3', content: 'CEO committed to weekly exec reviews', category: 'commitment', pinned: false, createdAt: '2025-01-03' },
  { id: '4', content: 'Prefers text-like coaching over formal memos', category: 'preference', pinned: false, createdAt: '2025-01-04' },
  { id: '5', content: 'Pattern: decisions stall when ownership unclear', category: 'pattern', pinned: false, createdAt: '2025-01-05' },
]

describe('selectMemoriesForPrompt', () => {
  it('puts pinned memories first, sorted by createdAt desc within each group', () => {
    const selected = selectMemoriesForPrompt(memories)
    // Pinned group sorted by recency: id:2 (Jan 02) before id:1 (Jan 01)
    expect(selected[0]).toContain('[context]')
    expect(selected[1]).toContain('[approach]')
    // Unpinned group sorted by recency: id:5 (Jan 05), id:4 (Jan 04), id:3 (Jan 03)
    expect(selected[2]).toContain('[pattern]')
    expect(selected[3]).toContain('[preference]')
    expect(selected[4]).toContain('[commitment]')
    expect(selected.length).toBe(5)
  })

  it('respects character budget', () => {
    const selected = selectMemoriesForPrompt(memories, { budget: 100 })
    expect(selected.length).toBeLessThan(5)
    // Total chars should be under budget
    const total = selected.reduce((sum, s) => sum + s.length, 0)
    expect(total).toBeLessThanOrEqual(100)
  })

  it('respects max entries', () => {
    const selected = selectMemoriesForPrompt(memories, { maxEntries: 2 })
    expect(selected.length).toBe(2)
    // Should be the 2 pinned ones (sorted by recency)
    expect(selected[0]).toContain('context')
    expect(selected[1]).toContain('approach')
  })

  it('handles empty array', () => {
    const selected = selectMemoriesForPrompt([])
    expect(selected).toEqual([])
  })

  it('sorts by createdAt desc within pinned and unpinned groups', () => {
    const unordered: Memory[] = [
      { id: 'a', content: 'oldest unpinned', category: 'general', pinned: false, createdAt: '2025-01-01' },
      { id: 'b', content: 'newest pinned', category: 'general', pinned: true, createdAt: '2025-01-10' },
      { id: 'c', content: 'newest unpinned', category: 'general', pinned: false, createdAt: '2025-01-05' },
      { id: 'd', content: 'oldest pinned', category: 'general', pinned: true, createdAt: '2025-01-02' },
    ]
    const selected = selectMemoriesForPrompt(unordered)
    expect(selected[0]).toContain('newest pinned')
    expect(selected[1]).toContain('oldest pinned')
    expect(selected[2]).toContain('newest unpinned')
    expect(selected[3]).toContain('oldest unpinned')
  })

  it('recent-first ignores pinned status', () => {
    const selected = selectMemoriesForPrompt(memories, { prioritize: 'recent-first' })
    // All sorted by createdAt desc regardless of pinned
    expect(selected[0]).toContain('[pattern]')      // id:5, Jan 05
    expect(selected[1]).toContain('[preference]')          // id:4, Jan 04
    expect(selected[2]).toContain('[commitment]')          // id:3, Jan 03
    expect(selected[3]).toContain('[context]')   // id:2, Jan 02 (pinned)
    expect(selected[4]).toContain('[approach]')   // id:1, Jan 01 (pinned)
  })

  it('memories without createdAt sort last', () => {
    const mixed: Memory[] = [
      { id: 'a', content: 'no date', category: 'general', pinned: false },
      { id: 'b', content: 'has date', category: 'general', pinned: false, createdAt: '2025-01-01' },
    ]
    const selected = selectMemoriesForPrompt(mixed)
    expect(selected[0]).toContain('has date')
    expect(selected[1]).toContain('no date')
  })
})

describe('buildMemoryBlock', () => {
  it('returns labeled block with memories', () => {
    const block = buildMemoryBlock(memories)
    expect(block).toContain('--- MEMORY')
    expect(block).toContain('Prefers direct pushback')
  })

  it('returns empty for no memories', () => {
    expect(buildMemoryBlock([])).toBe('')
  })

  it('uses custom label', () => {
    const block = buildMemoryBlock(memories, { label: 'COACH MEMORY' })
    expect(block).toContain('--- COACH MEMORY')
  })

  it('includes IDs when includeIds is true', () => {
    const block = buildMemoryBlock(memories, { includeIds: true })
    expect(block).toContain('(id:1)')
    expect(block).toContain('(id:2)')
    expect(block).toContain('[approach] (id:1) Prefers direct pushback')
  })

  it('excludes IDs by default', () => {
    const block = buildMemoryBlock(memories)
    expect(block).not.toContain('(id:')
    expect(block).toContain('[approach] Prefers direct pushback')
  })
})

describe('selectMemoriesForPrompt with includeIds', () => {
  it('includes IDs in formatted lines', () => {
    const selected = selectMemoriesForPrompt(memories, { includeIds: true })
    // First pinned memory by recency is id:2
    expect(selected[0]).toContain('(id:2)')
    expect(selected[0]).toContain('[context]')
  })

  it('IDs use character budget', () => {
    // IDs make lines longer, so fewer fit in budget
    const withoutIds = selectMemoriesForPrompt(memories, { budget: 200 })
    const withIds = selectMemoriesForPrompt(memories, { budget: 200, includeIds: true })
    expect(withIds.length).toBeLessThanOrEqual(withoutIds.length)
  })
})

describe('inferMemoryCategory', () => {
  it('detects coaching approach', () => {
    expect(inferMemoryCategory('CEO responds well to direct pushback')).toBe('approach')
  })

  it('detects commitment', () => {
    expect(inferMemoryCategory("CEO said he'd confront the VP this week")).toBe('commitment')
  })

  it('detects preference', () => {
    expect(inferMemoryCategory('Prefers to think out loud before deciding')).toBe('preference')
  })

  it('detects values', () => {
    expect(inferMemoryCategory('Deeply values transparency and integrity')).toBe('values')
  })

  it('detects strategic context', () => {
    expect(inferMemoryCategory('Currently optimizing for speed, trade-off is quality')).toBe('context')
  })

  it('falls back to general', () => {
    expect(inferMemoryCategory('Had a good meeting today')).toBe('general')
  })

  it('supports custom keywords', () => {
    const custom = { fitness: ['reps', 'sets', 'workout', 'exercise'] }
    expect(inferMemoryCategory('Prefers 3 sets of 10 reps for compound exercises', custom)).toBe('fitness')
  })
})
