import { parseBrainMarkdown } from '../brain.js'
import type { LoadedBrainArtifact } from '../types.js'

export interface BrainBloatAuditInput {
  markdown?: string
  brain?: LoadedBrainArtifact
  sourcePath?: string
  options?: Partial<BrainBloatAuditOptions>
}

export interface BrainBloatAuditOptions {
  maxTotalChars: number
  maxParagraphChars: number
  sectionCharBudgets: Record<string, number>
  defaultSectionChars: number
}

export interface BrainBloatAuditIssue {
  severity: 'error' | 'warn'
  kind:
    | 'total-brain-size'
    | 'section-size'
    | 'long-paragraph'
    | 'repeated-line'
    | 'implementation-leakage'
  message: string
  section?: string
  actual?: number
  limit?: number
}

export interface BrainBloatSectionMetric {
  name: string
  chars: number
  lines: number
  paragraphs: number
}

export interface BrainBloatAuditResult {
  pass: boolean
  issues: BrainBloatAuditIssue[]
  metrics: {
    totalChars: number
    totalLines: number
    sectionCount: number
    sections: BrainBloatSectionMetric[]
  }
}

const DEFAULT_OPTIONS: BrainBloatAuditOptions = {
  maxTotalChars: 4000,
  maxParagraphChars: 420,
  defaultSectionChars: 900,
  sectionCharBudgets: {
    // Voice formatting enumerates markdown/rendering capabilities — it's
    // mechanical, not prescriptive, so a slightly longer section is OK here.
    'voice-formatting': 320,
    methodology: 1400,
    'action-protocol': 1200,
    'greeting-guidelines': 250,
    'retrospective-guidelines': 350,
    directives: 500,
    discovery: 450,
  },
}

const CONCISE_SECTIONS = new Set([
  'voice-formatting',
  'action-protocol',
  'greeting-guidelines',
  'retrospective-guidelines',
  'directives',
  'discovery',
])

/**
 * Patterns that indicate actual implementation mechanics leaking into the brain.
 * Tuned to avoid false positives on domain vocabulary — e.g., a nutrition brain
 * talking about a "food record" is scene-setting, not implementation leakage.
 * The patterns below look for infrastructure phrasing, not just nouns.
 */
const IMPLEMENTATION_LEAKAGE_PATTERNS = [
  /\bcrud\b/i,
  /\buse the (\w+\s+)?entity\b/i,
  /\buse the id shown\b/i,
  /\bthe id (shown|from)\b/i,
  /\bcontext block\b/i,
  /\bupdate (the |your )?record\b/i,
  /\buse the record\b/i,
  /\brecord (cleanup|update|id|entry)\b/i,
  /\brecord shows\b/i,
  /\brecipe:\s*null\b/i,
  /\bzod\b/i,
  /\bjson (schema|format|response)\b/i,
  /\breturn.*\bjson\b/i,
  /\bschema\b.*\b(compliance|validation)\b/i,
] as const

export function auditBrainBloat(input: BrainBloatAuditInput): BrainBloatAuditResult {
  const options = { ...DEFAULT_OPTIONS, ...input.options, sectionCharBudgets: { ...DEFAULT_OPTIONS.sectionCharBudgets, ...(input.options?.sectionCharBudgets ?? {}) } }
  const brain = input.brain ?? parseBrainMarkdown(input.markdown ?? '', input.sourcePath)
  const sections = Object.entries(brain.sections).map(([name, content]) => ({
    name,
    content,
    chars: content.length,
    lines: content.split('\n').length,
    paragraphs: countParagraphs(content),
  }))

  const issues: BrainBloatAuditIssue[] = []
  const totalChars = sections.reduce((sum, section) => sum + section.chars, 0)
  const totalLines = sections.reduce((sum, section) => sum + section.lines, 0)

  if (totalChars > options.maxTotalChars) {
    issues.push({
      severity: 'error',
      kind: 'total-brain-size',
      message: `Brain carries ${totalChars} chars across sections (limit ${options.maxTotalChars}).`,
      actual: totalChars,
      limit: options.maxTotalChars,
    })
  }

  for (const section of sections) {
    const sectionLimit = options.sectionCharBudgets[section.name] ?? options.defaultSectionChars
    if (section.chars > sectionLimit) {
      issues.push({
        severity: 'error',
        kind: 'section-size',
        section: section.name,
        message: `Section "${section.name}" carries ${section.chars} chars (limit ${sectionLimit}).`,
        actual: section.chars,
        limit: sectionLimit,
      })
    }

    for (const paragraph of collectParagraphs(section.content)) {
      if (paragraph.length > options.maxParagraphChars) {
        issues.push({
          severity: CONCISE_SECTIONS.has(section.name) ? 'error' : 'warn',
          kind: 'long-paragraph',
          section: section.name,
          message: `Section "${section.name}" contains a long paragraph of ${paragraph.length} chars.`,
          actual: paragraph.length,
          limit: options.maxParagraphChars,
        })
      }
    }

    for (const rawLine of section.content.split('\n')) {
      const trimmed = rawLine.trim()
      if (!trimmed) continue
      if (!IMPLEMENTATION_LEAKAGE_PATTERNS.some(pattern => pattern.test(trimmed))) continue
      issues.push({
        severity: CONCISE_SECTIONS.has(section.name) ? 'error' : 'warn',
        kind: 'implementation-leakage',
        section: section.name,
        message: `Section "${section.name}" leaks implementation mechanics instead of staying brain-level: "${trimmed}"`,
      })
    }
  }

  const repeatedLines = findRepeatedLines(sections.map(section => ({ name: section.name, content: section.content })))
  for (const repeated of repeatedLines) {
    issues.push({
      severity: 'warn',
      kind: 'repeated-line',
      message: `Repeated line appears across sections: "${repeated.line}"`,
    })
  }

  return {
    pass: issues.every(issue => issue.severity !== 'error'),
    issues,
    metrics: {
      totalChars,
      totalLines,
      sectionCount: sections.length,
      sections: sections.map(section => ({
        name: section.name,
        chars: section.chars,
        lines: section.lines,
        paragraphs: section.paragraphs,
      })),
    },
  }
}

function collectParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/g)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function countParagraphs(content: string): number {
  return collectParagraphs(content).length
}

function normalizeRepeatedLineCandidate(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function findRepeatedLines(sections: Array<{ name: string, content: string }>): Array<{ line: string }> {
  const seen = new Map<string, Set<string>>()
  const canonical = new Map<string, string>()

  for (const section of sections) {
    for (const rawLine of section.content.split('\n')) {
      const normalized = normalizeRepeatedLineCandidate(rawLine)
      if (!normalized || normalized.length < 45) continue
      if (!canonical.has(normalized)) canonical.set(normalized, rawLine.trim())
      const owners = seen.get(normalized) ?? new Set<string>()
      owners.add(section.name)
      seen.set(normalized, owners)
    }
  }

  return Array.from(seen.entries())
    .filter(([, owners]) => owners.size > 1)
    .map(([normalized]) => ({ line: canonical.get(normalized) ?? normalized }))
}
