import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { definePersona, withStorage, createMarkdownKnowledgeAdapter } from '../src/index.js'
import { buildSystemPrompt } from '../src/core/prompt-builder.js'
import type { LLMProvider, PersonaConfig, StorageAdapter } from '../src/types.js'

function createMockProvider(responseOverride?: string): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      text: responseOverride ?? JSON.stringify({
        message: 'A grounded answer.',
        actions: [],
        outcomeNotes: [],
      }),
    }),
  }
}

function createMockAdapter(): StorageAdapter {
  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; isNote?: boolean; createdAt: string }> = []

  return {
    getActiveConversation: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue('conv-1'),
    endConversation: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockImplementation(async () => messages),
    saveMessage: vi.fn().mockImplementation(async (_conversationId, message) => {
      messages.push({ ...message, createdAt: new Date().toISOString() })
    }),
    loadMemories: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue('mem-1'),
    updateMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  }
}

const BASE_CONFIG: Omit<PersonaConfig, 'provider'> = {
  identity: {
    name: 'Nutrition Guide',
    expertise: ['nutrition coaching'],
    relationship: 'trusted guide',
    northStar: 'consistent, grounded nutrition progress',
  },
  voice: { tone: 'warm', style: 'educator' },
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('knowledge prompt surface', () => {
  it('renders knowledge documents into the system prompt', () => {
    const provider = createMockProvider()
    const prompt = buildSystemPrompt({
      config: {
        ...BASE_CONFIG,
        provider,
        knowledge: {
          purpose: 'grounding claims in durable program docs',
        },
      },
      input: {
        message: 'What breakfast should I have?',
        knowledgeDocuments: [
          {
            id: 'kb-breakfast-playbook',
            title: 'Breakfast Playbook',
            status: 'approved',
            content: '- Prefer a protein anchor when breakfast needs to carry the day.\n- Build from the user’s existing routine when possible.',
          },
        ],
      },
    })

    expect(prompt).toContain('KNOWLEDGE (durable shared reference)')
    expect(prompt).toContain('grounding claims in durable program docs')
    expect(prompt).toContain('Breakfast Playbook')
    expect(prompt).toContain('protein anchor')
  })
})

describe('markdown knowledge adapter', () => {
  it('uses root-relative fallback ids so nested files stay unique', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archetype-knowledge-'))
    tempDirs.push(root)

    await mkdir(path.join(root, 'policies'))
    await mkdir(path.join(root, 'playbooks'))
    await writeFile(path.join(root, 'policies', 'index.md'), `# Policy Index\n\nProtein guidance.`)
    await writeFile(path.join(root, 'playbooks', 'index.md'), `# Playbook Index\n\nBreakfast routines.`)

    const adapter = createMarkdownKnowledgeAdapter({ rootDir: root })
    const results = await adapter.searchDocuments({ query: 'protein breakfast index', maxDocuments: 10 })
    const ids = results.map(result => result.id)

    expect(ids).toContain('policies-index')
    expect(ids).toContain('playbooks-index')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns the most relevant approved docs and omits drafts by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archetype-knowledge-'))
    tempDirs.push(root)

    await writeFile(path.join(root, 'breakfast.md'), `---
id: kb-breakfast
title: Breakfast Playbook
status: approved
tags: [breakfast, protein]
summary: Use breakfast to solve recurring protein misses.
---

# Breakfast Playbook

Prefer a protein anchor at breakfast when the user routinely ends the day low on protein.
`)

    await writeFile(path.join(root, 'draft.md'), `---
id: kb-draft
title: Experimental Draft
status: draft
tags: [breakfast]
---

# Experimental Draft

This should not show up by default.
`)

    const adapter = createMarkdownKnowledgeAdapter({ rootDir: root })
    const results = await adapter.searchDocuments({ query: 'breakfast protein', maxDocuments: 5 })

    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe('kb-breakfast')
    expect(results[0]?.title).toBe('Breakfast Playbook')
  })

  it('does not return draft docs through direct lookup when includeDrafts is false', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archetype-knowledge-'))
    tempDirs.push(root)

    await writeFile(path.join(root, 'draft.md'), `---
id: kb-draft
title: Experimental Draft
status: draft
---

# Experimental Draft

Hidden by default.
`)

    const adapter = createMarkdownKnowledgeAdapter({ rootDir: root })
    const result = await adapter.getDocument?.('kb-draft')

    expect(result).toBeNull()
  })

  it('injects retrieved markdown knowledge into managed mode prompts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'archetype-knowledge-'))
    tempDirs.push(root)

    await mkdir(path.join(root, 'policies'))
    await writeFile(path.join(root, 'policies', 'breakfast-playbook.md'), `---
id: kb-breakfast-playbook
title: Breakfast Playbook
status: approved
tags: [breakfast, protein]
summary: Prefer breakfast suggestions that solve the user’s real recurring pattern.
---

# Breakfast Playbook

- If the user repeatedly ends the day low on protein, breakfast should usually anchor protein early.
- Build from routines that already work instead of replacing them with generic novelty.
`)

    const provider = createMockProvider()
    const persona = definePersona({
      ...BASE_CONFIG,
      provider,
      knowledge: {
        purpose: 'grounding breakfast advice in durable program docs',
      },
    })
    const managed = withStorage(persona, {
      adapter: createMockAdapter(),
      knowledge: {
        adapter: createMarkdownKnowledgeAdapter({ rootDir: root }),
      },
    })

    await managed.chat({
      message: 'What breakfast would make sense if I keep ending the day low on protein?',
    })

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.systemPrompt).toContain('KNOWLEDGE (durable shared reference)')
    expect(call.systemPrompt).toContain('Breakfast Playbook')
    expect(call.systemPrompt).toContain('solve the user’s real recurring pattern')
  })
})

describe('knowledge block selection', () => {
  it('skips oversized docs and still injects smaller matches that fit', () => {
    const selected = buildSystemPrompt({
      config: {
        ...BASE_CONFIG,
        provider: createMockProvider(),
        knowledge: {
          budget: 120,
        },
      },
      input: {
        message: 'ground me',
        knowledgeDocuments: [
          {
            id: 'kb-long',
            title: 'Long Doc',
            content: 'x'.repeat(400),
          },
          {
            id: 'kb-short',
            title: 'Short Doc',
            content: 'Use the short grounded answer.',
          },
        ],
      },
    })

    expect(selected).toContain('Short Doc')
    expect(selected).not.toContain('Long Doc')
  })
})
