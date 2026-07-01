import type { Memory } from '../types.js'

const DEFAULT_BUDGET = 8000
const DEFAULT_MAX_ENTRIES = 200

export interface MemoryBlockOptions {
  budget?: number
  maxEntries?: number
  label?: string
  /** When true, include memory IDs in the prompt for AI-driven update/delete */
  includeIds?: boolean
  /** Priority strategy: 'pinned-first' (default) splits pinned/unpinned then sorts by recency;
   *  'recent-first' sorts all memories by recency regardless of pinned status. */
  prioritize?: 'pinned-first' | 'recent-first'
}

/**
 * Load memories for prompt injection, respecting budget and prioritization.
 * Respects character budget and entry limit.
 *
 * Prioritization strategies:
 * - 'pinned-first' (default): pinned memories first, then unpinned; each group sorted by createdAt desc.
 * - 'recent-first': all memories sorted by createdAt desc regardless of pinned status.
 */
export function selectMemoriesForPrompt(
  memories: Memory[],
  options?: MemoryBlockOptions,
): string[] {
  const budget = options?.budget ?? DEFAULT_BUDGET
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const includeIds = options?.includeIds ?? false
  const strategy = options?.prioritize ?? 'pinned-first'

  let sorted: Memory[]

  if (strategy === 'recent-first') {
    sorted = [...memories].sort(byCreatedAtDesc)
  } else {
    // pinned-first: split, then sort by salience inside each group
    const pinned = memories.filter(m => m.pinned).sort(byMemorySalience)
    const unpinned = memories.filter(m => !m.pinned).sort(byMemorySalience)
    sorted = [...pinned, ...unpinned]
  }

  sorted = sorted.slice(0, maxEntries)

  const result: string[] = []
  let charCount = 0

  for (const mem of sorted) {
    const idPart = includeIds ? ` (id:${mem.id})` : ''
    const metadata = buildMemoryMetadataLabel(mem)
    const contextPart = mem.contextHint?.trim() ? ` (context: ${mem.contextHint.trim()})` : ''
    const line = `[${mem.category}${metadata}]${idPart} ${mem.content}${contextPart}`
    if (charCount + line.length > budget) break
    result.push(line)
    charCount += line.length
  }

  return result
}

/** Sort by createdAt descending (most recent first). Memories without createdAt sort last. */
function byCreatedAtDesc(a: Memory, b: Memory): number {
  if (!a.createdAt && !b.createdAt) return 0
  if (!a.createdAt) return 1
  if (!b.createdAt) return -1
  return b.createdAt.localeCompare(a.createdAt)
}

function byMemorySalience(a: Memory, b: Memory): number {
  const stabilityDiff = stabilityRank(b.stability) - stabilityRank(a.stability)
  if (stabilityDiff !== 0) return stabilityDiff

  const sourceDiff = sourceRank(b.source) - sourceRank(a.source)
  if (sourceDiff !== 0) return sourceDiff

  return byCreatedAtDesc(a, b)
}

function stabilityRank(stability?: Memory['stability']): number {
  switch (stability) {
    case 'durable':
      return 3
    case 'tentative':
      return 2
    case 'temporary':
      return 1
    default:
      return 2
  }
}

function sourceRank(source?: Memory['source']): number {
  switch (source) {
    case 'user':
      return 3
    case 'inferred':
      return 2
    case 'suggested':
      return 1
    default:
      return 2
  }
}

function buildMemoryMetadataLabel(memory: Memory): string {
  const parts: string[] = []
  if (memory.source) parts.push(`source:${memory.source}`)
  if (memory.stability) parts.push(`stability:${memory.stability}`)
  return parts.length > 0 ? ` | ${parts.join(' | ')}` : ''
}

/**
 * Format selected memories into a prompt section.
 */
export function buildMemoryBlock(
  memories: Memory[],
  options?: MemoryBlockOptions,
): string {
  const label = options?.label ?? 'MEMORY'
  const selected = selectMemoriesForPrompt(memories, options)

  if (selected.length === 0) return ''
  return `--- ${label} (what you've learned about this person) ---\nYour accumulated understanding from working with them.\n${selected.join('\n')}`
}

// ─── Category inference ──────────────────────────────────────────────────────

const DEFAULT_CATEGORY_KEYWORDS: Record<string, string[]> = {
  approach: [
    'responds well to', 'resists', 'shuts down when', 'push harder', 'pull back',
    'framing that works', 'approach that works', 'landed well', 'style that works',
    'softer', 'direct pushback',
  ],
  commitment: [
    "said he'd", 'committed to', 'this week', 'promised to', 'going to confront',
    'will stop', "next time i'll", 'i need to stop', "i'll",
  ],
  pattern: [
    'across threads', 'keeps showing up', 'systemic', 'multiple', 'recurring across',
    'pattern spanning', 'cross-cutting', 'connected to',
  ],
  context: [
    'optimizing for', 'trade-off', 'current bet', 'strategic frame', 'north star',
    'what matters most', 'key assumption', 'thesis',
  ],
  preference: [
    'prefers', 'likes to', 'works best when', 'communication style', 'wants to be',
    'rather than', 'comfortable with', 'hates when', 'pet peeve', 'processing style',
    'think out loud', 'needs space',
  ],
  values: [
    'believes in', 'cares about', 'matters more than', 'integrity', 'transparency',
    'proud of', 'stands for', 'deeply values', 'non-negotiable', 'kind of leader',
    'kind of company',
  ],
}

/**
 * Infer the best category for a memory text based on keyword matching.
 * Returns 'general' if no strong signal.
 *
 * When `customKeywords` is provided, uses those for keyword matching.
 * When `categoryNames` is provided (from MemoryConfig.categories),
 * does simple name matching against the text as a lightweight fallback
 * after keyword matching.
 */
export function inferMemoryCategory(
  text: string,
  customKeywords?: Record<string, string[]>,
  categoryNames?: string[],
): string {
  const keywords = customKeywords ?? DEFAULT_CATEGORY_KEYWORDS
  const lower = text.toLowerCase()
  let best = 'general'
  let bestScore = 0

  for (const [category, kws] of Object.entries(keywords)) {
    let score = 0
    for (const kw of kws) {
      if (lower.includes(kw)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = category
    }
  }

  // If keyword matching found nothing and we have domain categories,
  // try simple name matching as a fallback
  if (best === 'general' && categoryNames && categoryNames.length > 0) {
    for (const name of categoryNames) {
      if (lower.includes(name.toLowerCase())) {
        return name
      }
    }
  }

  return best
}
