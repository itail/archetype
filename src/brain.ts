import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { LoadedBrainArtifact, PersonaBrain, PersonaConfig } from './types.js'

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function normalizeSectionName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function parseFrontmatter(block: string): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (!key) continue
    metadata[key] = value
  }
  return metadata
}

export function parseBrainMarkdown(markdown: string, sourcePath?: string): LoadedBrainArtifact {
  const normalized = normalizeNewlines(markdown).trim()
  let body = normalized
  let metadata: Record<string, string> = {}

  const frontmatterMatch = body.match(/^---\n([\s\S]*?)\n---\n?/)
  if (frontmatterMatch) {
    metadata = parseFrontmatter(frontmatterMatch[1])
    body = body.slice(frontmatterMatch[0].length)
  }

  const sections: Record<string, string> = {}
  const headingPattern = /^##\s+(.+)$/gm
  const matches = [...body.matchAll(headingPattern)]

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i]
    const next = matches[i + 1]
    const title = normalizeSectionName(current[1])
    const start = current.index! + current[0].length
    const end = next ? next.index! : body.length
    const content = body.slice(start, end).trim()
    if (content) {
      sections[title] = content
    }
  }

  return {
    source: 'loaded',
    markdown: normalized,
    metadata,
    sections,
    sourcePath,
  }
}

export function loadBrainFile(path: string): LoadedBrainArtifact {
  const sourcePath = resolvePath(path)
  const markdown = readFileSync(sourcePath, 'utf8')
  return parseBrainMarkdown(markdown, sourcePath)
}

export function resolvePersonaBrain(brain?: PersonaBrain): LoadedBrainArtifact | undefined {
  if (!brain) return undefined
  if (brain.source === 'loaded') return brain
  if (brain.source === 'file') return loadBrainFile(brain.path)
  return parseBrainMarkdown(brain.markdown, brain.path)
}

export function getBrainSection(brain: PersonaBrain | undefined, sectionName: string): string | undefined {
  const resolved = resolvePersonaBrain(brain)
  return resolved?.sections[normalizeSectionName(sectionName)]
}

export function resolvePersonaConfigBrain(config: PersonaConfig): PersonaConfig {
  const brain = resolvePersonaBrain(config.brain)
  if (!brain) return config
  if (config.brain?.source === 'loaded') return config
  return { ...config, brain }
}
