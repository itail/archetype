import type { StorageAdapter, Memory, LLMProvider } from '../types.js'

export interface MemoryReviewOptions {
  adapter: StorageAdapter
  provider: LLMProvider
  /** Only review memories older than this many days (default: 7) */
  maxAge?: number
  /** Preserve pinned memories from review (default: true) */
  preservePinned?: boolean
  /** Memory budget for loading (default: 16000 — we load more than prompt budget for review) */
  loadBudget?: number
  /** Explain what these memories are for across future conversations. */
  memoryPurpose?: string
  /** Domain-specific memory categories with descriptions. */
  categoryDescriptions?: Record<string, string>
  /** Memory scope to review: 'user' (default) or 'craft'. Craft memories use a higher bar for removal. */
  scope?: 'user' | 'craft'
}

export interface MemoryReviewResult {
  /** Number of old memories removed */
  removed: number
  /** Number of reviewed memories created */
  created: number
}

function buildReviewPrompt(options: Pick<MemoryReviewOptions, 'memoryPurpose' | 'categoryDescriptions' | 'scope'>): string {
  const isCraft = options.scope === 'craft'
  const sections: string[] = isCraft
    ? [
        'You are doing a quiet cleanup pass on an AI assistant\'s craft memories — professional growth observations about its own practice.',
        'These memories are transferable across users. The bar for removal is higher than user memories: only remove genuine duplicates or observations that turned out to be situational noise, not real patterns.',
      ]
    : [
        'You are doing a quiet memory cleanup pass for an AI assistant.',
        'Your job is to turn a noisy list of extracted memories into the smaller, sharper set the assistant would actually want to carry forward into future conversations.',
      ]

  if (options.memoryPurpose?.trim()) {
    sections.push(`MEMORY PURPOSE:\n${options.memoryPurpose.trim()}`)
  }

  if (options.categoryDescriptions && Object.keys(options.categoryDescriptions).length > 0) {
    const categoryGuide = Object.entries(options.categoryDescriptions)
      .map(([name, description]) => `- ${name}: ${description}`)
      .join('\n')
    sections.push(`MEMORY CATEGORIES:\n${categoryGuide}`)
  }

  sections.push(`CLEANUP GUIDANCE:
- Merge only genuine duplicates and near-duplicates — two memories that say the same thing become the single strongest version. Two memories that say different things both stay.
- Drop only memories that are pure transcript, changelog, or a one-off situational note with no lasting signal.
- Everything else that would still help a future conversation stays. There is no target count and shrinking the list is not the goal — keep the set as large as the real, distinct, useful facts require. Sharpen, don't shrink.
- A stated user fact is ground truth. A preference, routine, recipe (with its amounts), or aversion the user told you — especially source=user, stability=durable — may be tightened in wording but must NEVER be negated, inverted, weakened into something vaguer, merged into a different fact, or dropped. When unsure whether something is a firm preference or a rigid rule, treat it as a fact and keep it exactly.
- Soften only genuine BEHAVIORAL boxing: a memory that hard-codes how the assistant must act in a situation regardless of context ("always suggest X when Y"). Rewrite those toward the underlying preference. Never confuse "the user always eats X" (a fact — keep it verbatim in meaning) with "always do X" (a rule — soften it). Getting this wrong inverts the person's real preferences, which is the worst thing this pass can do.
- Respect memory metadata when present:
  - source=user carries more authority than source=suggested
  - stability=temporary should rarely survive unless the situation is still active
  - contextHint should stay compact — keep only what is needed for future interpretation
- Preserve the best-fit category, and preserve or improve source/stability/contextHint when useful.
- Return valid JSON: { "compacted": [{ "content": "...", "category": "...", "source": "user|inferred|suggested", "stability": "durable|tentative|temporary", "contextHint": "..." }] }`)

  return sections.join('\n\n')
}

/**
 * Review old, non-pinned memories by sending them to the LLM for dedup/consolidation
 * and anti-boxing cleanup.
 *
 * The app decides when to call this (manual trigger, schedule, etc.).
 * Archetype provides the logic but not the scheduling.
 *
 * Flow:
 * 1. Load all memories from adapter
 * 2. Filter to old, non-pinned memories (candidates for review)
 * 3. If no candidates, skip
 * 4. Send to LLM for consolidation
 * 5. Delete old candidates, save reviewed results
 */
export async function reviewMemories(
  options: MemoryReviewOptions,
): Promise<MemoryReviewResult> {
  const {
    adapter,
    provider,
    maxAge = 7,
    preservePinned = true,
    loadBudget = 16000,
    memoryPurpose,
    categoryDescriptions,
    scope = 'user',
  } = options

  // 1. Load all memories (scoped)
  const allMemories = scope === 'craft' && adapter.loadCraftMemories
    ? await adapter.loadCraftMemories({ budget: loadBudget })
    : await adapter.loadMemories({ budget: loadBudget, pinnedFirst: false })

  // 2. Filter candidates: old + non-pinned
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - maxAge)
  const cutoffStr = cutoff.toISOString()

  const candidates = allMemories.filter(m => {
    if (preservePinned && m.pinned) return false
    if (!m.createdAt) return true // no timestamp = old enough
    return m.createdAt < cutoffStr
  })

  if (candidates.length === 0) {
    return { removed: 0, created: 0 }
  }

  // 3. Build prompt with candidates
  const memoryList = candidates
    .map(m => {
      const meta: string[] = []
      if (m.source) meta.push(`source:${m.source}`)
      if (m.stability) meta.push(`stability:${m.stability}`)
      const metaText = meta.length > 0 ? ` | ${meta.join(' | ')}` : ''
      const contextText = m.contextHint?.trim() ? ` (context: ${m.contextHint.trim()})` : ''
      return `[${m.category}${metaText}] ${m.content}${contextText}`
    })
    .join('\n')

  const label = scope === 'craft' ? 'craft memories' : 'memories'
  const message = `Here are ${candidates.length} ${label} to compact:\n\n${memoryList}`

  // 4. Call LLM
  const response = await provider.chat({
    systemPrompt: buildReviewPrompt({ memoryPurpose, categoryDescriptions, scope }),
    history: [],
    message,
  })

  // 5. Parse response
  let compacted: Array<{
    content: string
    category: string
    source?: 'user' | 'inferred' | 'suggested'
    stability?: Memory['stability']
    contextHint?: string
  }>
  try {
    const parsed = JSON.parse(response.text)
    compacted = parsed.compacted ?? []
  } catch {
    console.error('[archetype] Failed to parse memory review response:', response.text)
    return { removed: 0, created: 0 }
  }

  if (compacted.length === 0) {
    return { removed: 0, created: 0 }
  }

  // 6. Delete old candidates
  const deleteFn = scope === 'craft' && adapter.deleteCraftMemory
    ? adapter.deleteCraftMemory.bind(adapter)
    : adapter.deleteMemory.bind(adapter)
  for (const m of candidates) {
    await deleteFn(m.id)
  }

  // 7. Save reviewed memories
  const saveFn = scope === 'craft' && adapter.saveCraftMemory
    ? (mem: Omit<Memory, 'id'>) => adapter.saveCraftMemory!(mem)
    : (mem: Omit<Memory, 'id'>) => adapter.saveMemory(mem)
  for (const m of compacted) {
    await saveFn({
      content: m.content,
      category: m.category,
      scope,
      source: m.source,
      stability: m.stability,
      contextHint: m.contextHint,
      pinned: false,
      createdAt: new Date().toISOString(),
    })
  }

  return { removed: candidates.length, created: compacted.length }
}

/** @deprecated Use reviewMemories instead */
export const compactMemories = reviewMemories
/** @deprecated Use MemoryReviewOptions instead */
export type CompactMemoriesOptions = MemoryReviewOptions
/** @deprecated Use MemoryReviewResult instead */
export type CompactMemoriesResult = MemoryReviewResult
