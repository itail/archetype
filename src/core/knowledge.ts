import type { KnowledgeDocument } from '../types.js'

const DEFAULT_BUDGET = 6000
const DEFAULT_MAX_DOCUMENTS = 12

export interface KnowledgeBlockOptions {
  budget?: number
  maxDocuments?: number
  label?: string
  purpose?: string
}

export function selectKnowledgeForPrompt(
  documents: KnowledgeDocument[],
  options?: KnowledgeBlockOptions,
): string[] {
  const budget = options?.budget ?? DEFAULT_BUDGET
  const maxDocuments = options?.maxDocuments ?? DEFAULT_MAX_DOCUMENTS
  const selected = documents.slice(0, maxDocuments)

  const result: string[] = []
  let charCount = 0

  for (const doc of selected) {
    const block = formatKnowledgeDocument(doc)
    if (charCount + block.length > budget) continue
    result.push(block)
    charCount += block.length
  }

  return result
}

export function buildKnowledgeBlock(
  documents: KnowledgeDocument[],
  options?: KnowledgeBlockOptions,
): string {
  const label = options?.label ?? 'KNOWLEDGE'
  const selected = selectKnowledgeForPrompt(documents, options)
  if (selected.length === 0) return ''

  const purpose = options?.purpose?.trim()
  const purposeLine = purpose
    ? `Use this shared knowledge for ${purpose}.`
    : 'Use this shared knowledge as grounded reference. Prefer claims supported here over improvised specifics.'

  return `--- ${label} (durable shared reference) ---\n${purposeLine} If it is silent, ambiguous, or provisional, say less and frame uncertainty rather than inventing specifics.\n${selected.join('\n\n')}`
}

function formatKnowledgeDocument(document: KnowledgeDocument): string {
  const titleParts = [document.title.trim()]
  if (document.id) titleParts.push(`id:${document.id}`)
  if (document.status) titleParts.push(`status:${document.status}`)
  if (document.tags?.length) titleParts.push(`tags:${document.tags.join(', ')}`)

  const body = (document.summary?.trim() || document.content.trim()).trim()
  return `[${titleParts.join(' | ')}]\n${body}`
}
