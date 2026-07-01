import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeAdapter, KnowledgeDocument, KnowledgeSearchInput } from '../types.js'

export interface MarkdownKnowledgeAdapterOptions {
  rootDir: string
  includeDrafts?: boolean
}

interface ParsedFrontmatter {
  id?: string
  title?: string
  summary?: string
  status?: KnowledgeDocument['status']
  tags?: string[]
}

export function createMarkdownKnowledgeAdapter(
  options: MarkdownKnowledgeAdapterOptions,
): KnowledgeAdapter {
  return {
    async searchDocuments(input: KnowledgeSearchInput): Promise<KnowledgeDocument[]> {
      const tokens = tokenize(input.query)
      if (tokens.length === 0) return []

      const files = await listMarkdownFiles(options.rootDir)
      const docs: Array<KnowledgeDocument & { score: number }> = []

      for (const file of files) {
        const doc = await readMarkdownKnowledgeDocument(file, options.rootDir)
        if (!options.includeDrafts && doc.status === 'draft') continue
        const score = scoreDocument(doc, tokens)
        if (score <= 0) continue
        docs.push({ ...doc, score })
      }

      return docs
        .sort((a, b) => b.score - a.score || compareUpdatedAtDesc(a.updatedAt, b.updatedAt))
        .slice(0, input.maxDocuments ?? 12)
        .map(({ score: _score, ...doc }) => doc)
    },

    async getDocument(id: string): Promise<KnowledgeDocument | null> {
      const files = await listMarkdownFiles(options.rootDir)
      for (const file of files) {
        const doc = await readMarkdownKnowledgeDocument(file, options.rootDir)
        if (!options.includeDrafts && doc.status === 'draft') continue
        if (doc.id === id) return doc
      }
      return null
    },
  }
}

async function listMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath)
    }
  }

  return files
}

async function readMarkdownKnowledgeDocument(
  filePath: string,
  rootDir: string,
): Promise<KnowledgeDocument> {
  const raw = await readFile(filePath, 'utf8')
  const fileStat = await stat(filePath)
  const { frontmatter, body } = extractFrontmatter(raw)
  const title = frontmatter.title ?? extractFirstHeading(body) ?? basenameTitle(filePath)
  const id = frontmatter.id ?? slugify(path.relative(rootDir, filePath).replace(/\.md$/i, ''))

  return {
    id,
    title,
    content: body.trim(),
    summary: frontmatter.summary,
    tags: frontmatter.tags,
    status: frontmatter.status,
    updatedAt: fileStat.mtime.toISOString(),
    path: filePath,
  }
}

function extractFrontmatter(raw: string): { frontmatter: ParsedFrontmatter; body: string } {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return { frontmatter: {}, body: raw }

  const frontmatterBlock = raw.slice(4, end)
  const body = raw.slice(end + 5)
  const parsed: ParsedFrontmatter = {}

  for (const line of frontmatterBlock.split('\n')) {
    const [rawKey, ...rawValue] = line.split(':')
    if (!rawKey || rawValue.length === 0) continue
    const key = rawKey.trim()
    const value = rawValue.join(':').trim()
    if (!value) continue

    if (key === 'id') parsed.id = stripQuotes(value)
    if (key === 'title') parsed.title = stripQuotes(value)
    if (key === 'summary') parsed.summary = stripQuotes(value)
    if (key === 'status') parsed.status = stripQuotes(value) as KnowledgeDocument['status']
    if (key === 'tags') parsed.tags = parseTags(value)
  }

  return { frontmatter: parsed, body }
}

function parseTags(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(part => stripQuotes(part.trim()))
      .filter(Boolean)
  }
  return trimmed
    .split(',')
    .map(part => stripQuotes(part.trim()))
    .filter(Boolean)
}

function extractFirstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim()
  }
  return null
}

function basenameTitle(filePath: string): string {
  return path.basename(filePath, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map(part => part.trim())
      .filter(part => part.length >= 3),
  )]
}

function scoreDocument(document: KnowledgeDocument, tokens: string[]): number {
  const title = document.title.toLowerCase()
  const summary = document.summary?.toLowerCase() ?? ''
  const body = document.content.toLowerCase()
  const tags = (document.tags ?? []).join(' ').toLowerCase()
  let score = 0

  for (const token of tokens) {
    if (title.includes(token)) score += 8
    if (tags.includes(token)) score += 6
    if (summary.includes(token)) score += 5
    if (body.includes(token)) score += 2
  }

  if (document.status === 'approved') score += 2
  if (document.status === 'provisional') score += 1

  return score
}

function compareUpdatedAtDesc(a?: string, b?: string): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return b.localeCompare(a)
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
