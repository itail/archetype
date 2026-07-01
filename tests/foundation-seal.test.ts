import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  archetype,
  auditFoundationSourceBoundary,
  foundationPromptKnobs,
  type LLMProvider,
} from '../src/index.js'

const provider: LLMProvider = {
  name: 'mock',
  async chat() {
    return { text: '{"message":"ok"}' }
  },
}

const ledgerAdapter = {
  async list() {
    return []
  },
  async create(params: Record<string, unknown>) {
    return { id: 'created-1', ...params }
  },
  async update(id: string, params: Record<string, unknown>) {
    return { id, ...params }
  },
  async delete() {},
}

describe('foundation sealed product path', () => {
  it('creates locked archetypes without exposing app-authored prompt knobs', () => {
    const builder = archetype.builder({ provider })

    expect(builder.kind).toBe('foundation-archetype')
    expect(builder.inspect()).toEqual({
      archetype: 'builder',
      promptSealed: true,
      appAuthoredPromptAllowed: false,
      lowLevelToolContractsExposed: false,
    })

    expect(() => archetype.builder({ provider, taste: 'always run tests before finishing' } as any))
      .toThrow(/does not accept app-authored prompt field "taste"/u)
    expect(() => archetype.productManager({ provider, directives: 'write exactly three docs' } as any))
      .toThrow(/does not accept app-authored prompt field "directives"/u)
    expect(() => archetype.personalAssistant({ provider, extraSystemSections: ['THREADS'] } as any))
      .toThrow(/does not accept app-authored prompt field "extraSystemSections"/u)
  })

  it('rejects every known prompt-shaped knob on archetype constructors', () => {
    for (const knob of foundationPromptKnobs) {
      expect(() => archetype.builder({ provider, [knob]: 'helpful prompt tweak' } as any), knob)
        .toThrow(new RegExp(`does not accept app-authored prompt field "${knob}"`, 'u'))
    }
  })

  it('accepts typed world reality but rejects prompt-shaped world data', () => {
    expect(archetype.world.workspace('./artifact')).toEqual({
      kind: 'workspace-world',
      roots: [{ prefix: 'workspace', path: './artifact', writable: true }],
    })

    expect(archetype.world.workspace({
      roots: [
        { prefix: 'spec', path: './spec', writable: false },
        { prefix: 'artifact', path: './artifact', writable: true },
      ],
    })).toEqual({
      kind: 'workspace-world',
      roots: [
        { prefix: 'spec', path: './spec', writable: false },
        { prefix: 'artifact', path: './artifact', writable: true },
      ],
    })

    expect(() => archetype.world.savor({
      user: { id: 'u1' },
      meals: [],
      contextInputs: { meals: { label: 'MEALS' } },
    } as any)).toThrow(/world\.savor does not accept app-authored prompt field "contextInputs"/u)

    expect(() => archetype.world.orbit({
      threads: [],
      labels: { threads: 'INBOX LANDSCAPE' },
    } as any)).toThrow(/world\.orbit does not accept app-authored prompt field "labels"/u)
  })

  it('rejects every known prompt-shaped knob on world surfaces', () => {
    for (const knob of foundationPromptKnobs) {
      expect(() => archetype.world.compound({ accounts: [], [knob]: 'helpful context wrapper' } as any), knob)
        .toThrow(new RegExp(`does not accept app-authored prompt field "${knob}"`, 'u'))
    }
  })

  it('treats ledgers as generated world surfaces, not app-authored prompt docs', () => {
    const ledger = archetype.ledger({
      name: 'transactions',
      schema: z.object({ merchant: z.string(), amount: z.number() }),
      adapter: ledgerAdapter,
    })

    expect(ledger.kind).toBe('ledger')
    expect(ledger.name).toBe('transactions')
    expect(ledger.singleton).toBe(false)
    expect(ledger.docsSource).toBe('generated')
    expect(ledger.appAuthoredDocsAllowed).toBe(false)

    expect(() => archetype.ledger({
      name: 'transactions',
      schema: z.object({ merchant: z.string() }),
      adapter: ledgerAdapter,
      ledgerDocs: 'Use this when correcting the ledger.',
    } as any)).toThrow(/ledger does not accept app-authored prompt field "ledgerDocs"/u)

    expect(() => archetype.singletonLedger({
      name: 'profile',
      schema: z.object({ monthlyIncome: z.number().optional() }),
      adapter: { list: ledgerAdapter.list, update: ledgerAdapter.update },
      toolDescriptions: { updateProfile: 'Always update profile on income changes.' },
    } as any)).toThrow(/ledger does not accept app-authored prompt field "toolDescriptions"/u)
  })

  it('rejects every known prompt-shaped knob on ledgers', () => {
    for (const knob of foundationPromptKnobs) {
      expect(() => archetype.ledger({
        name: 'transactions',
        schema: z.object({ merchant: z.string() }),
        adapter: ledgerAdapter,
        [knob]: 'helpful ledger prompt',
      } as any), knob).toThrow(new RegExp(`does not accept app-authored prompt field "${knob}"`, 'u'))
    }
  })

  it('requires ledgers to provide real adapter contracts, not placeholder objects', () => {
    expect(() => archetype.ledger({
      name: 'transactions',
      schema: z.object({ merchant: z.string() }),
      adapter: {},
    })).toThrow(/ledger adapter requires list\(\)/u)

    expect(() => archetype.ledger({
      name: 'transactions',
      schema: z.object({ merchant: z.string() }),
      adapter: { list: ledgerAdapter.list, create: ledgerAdapter.create, update: ledgerAdapter.update },
    })).toThrow(/ledger adapter requires delete\(\)/u)

    expect(() => archetype.singletonLedger({
      name: 'profile',
      schema: z.object({ monthlyIncome: z.number().optional() }),
      adapter: { list: ledgerAdapter.list },
    })).toThrow(/singleton ledger adapter requires update\(\)/u)
  })

  it('blocks foundation samples from importing low-level runtime internals', () => {
    const clean = `
      import { archetype } from 'archetype'
      const builder = archetype.builder({ provider })
      await builder.work('Build the game.', { world })
    `

    expect(auditFoundationSourceBoundary(clean)).toEqual({ pass: true, issues: [] })

    const leaky = `
      import { archetype, executeCoderAction, renderWorkHistoryEntries } from 'archetype'
      const world = archetype.world.workspace('./artifact')
    `

    const result = auditFoundationSourceBoundary(leaky)
    expect(result.pass).toBe(false)
    expect(result.issues.map(issue => issue.token)).toEqual(
      expect.arrayContaining(['executeCoderAction', 'renderWorkHistoryEntries']),
    )

    const namespaceLeak = `
      import { archetype } from 'archetype'
      await archetype.executeCoderAction(action)
    `

    expect(auditFoundationSourceBoundary(namespaceLeak).issues.map(issue => issue.token))
      .toContain('executeCoderAction')
  })

  it('does not implement hidden completion vetoes in the foundation skeleton', () => {
    const builder = archetype.builder({ provider })
    const contract = builder.inspect()

    expect(contract.promptSealed).toBe(true)
    expect(contract.appAuthoredPromptAllowed).toBe(false)
    expect(Object.keys(contract)).not.toContain('completionVeto')
    expect(Object.keys(contract)).not.toContain('finishDeferral')
  })
})
