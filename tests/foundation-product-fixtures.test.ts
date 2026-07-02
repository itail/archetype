import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { archetype, type LLMProvider } from '../src/index.js'

const provider: LLMProvider = {
  name: 'mock',
  async chat() {
    return { text: '{"message":"ok"}' }
  },
}

const memoryAdapter = {
  async load() {
    return [{ id: 'mem-1', content: 'User prefers savory breakfasts.', category: 'preference' }]
  },
  async save(memory: Record<string, unknown>) {
    return { id: 'mem-created', ...memory }
  },
  async update(id: string, updates: Record<string, unknown>) {
    return { id, ...updates }
  },
  async delete() {},
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

describe('foundation product fixtures', () => {
  it('models Savor as full-persona reality: nutrition data plus person and craft memory', () => {
    const savor = archetype.nutritionCoach({ provider })
    const personMemory = archetype.memory.person({
      adapter: memoryAdapter,
      categories: {
        preference: 'Food preferences and cooking habits',
        routine: 'Repeatable eating patterns',
      },
      budget: 5000,
    })
    const craftMemory = archetype.memory.craft({
      adapter: memoryAdapter,
      categories: {
        approach: 'What works when coaching nutrition',
      },
      budget: 3000,
    })

    const world = archetype.world.nutrition({
      user: { id: 'user-1', name: 'Alex' },
      profile: { id: 'profile-1', goal: 'cut', dailyCalories: 1800 },
      meals: [{ id: 'meal-1', description: 'Longevity Anchor breakfast' }],
      recentDays: [{ date: '2026-04-23', calories: 1750, proteinG: 170 }],
      personMemory,
      craftMemory,
    })

    expect(savor.inspect().archetype).toBe('nutrition-coach')
    expect(world.kind).toBe('nutrition-world')
    expect((world.data.personMemory as typeof personMemory).semanticsOwner).toBe('archetype')
    expect((world.data.craftMemory as typeof craftMemory).scope).toBe('craft')
  })

  it('models Iron as full-persona reality without adding fitness prompt prose', () => {
    const iron = archetype.fitnessCoach({ provider })
    const world = archetype.world.fitness({
      athlete: { id: 'athlete-1', name: 'Alex' },
      trainingPlan: { id: 'plan-1', focus: 'lower strength' },
      recentWorkouts: [{ id: 'workout-1', title: 'Squat day', completedAt: '2026-04-23' }],
      availableEquipment: ['barbell', 'rack', 'dumbbells'],
      personMemory: archetype.memory.person({ adapter: memoryAdapter, budget: 6000 }),
      craftMemory: archetype.memory.craft({ adapter: memoryAdapter, budget: 2500 }),
    })

    expect(iron.inspect().archetype).toBe('fitness-coach')
    expect(world.kind).toBe('fitness-world')
    expect(() => archetype.world.fitness({
      athlete: { id: 'athlete-1' },
      methodology: 'Always start with a compound lift.',
    } as any)).toThrow(/world\.fitness does not accept app-authored prompt field "methodology"/u)
  })

  it('models Orbit as full-persona reality with peer data and thread CRUD surfaces', () => {
    const orbit = archetype.personalAssistant({ provider })
    const threadLedger = archetype.ledger({
      name: 'threads',
      schema: z.object({
        state: z.enum(['active', 'waiting', 'reference', 'suppressed', 'done']).optional(),
        summary: z.string().optional(),
        draft: z.string().optional(),
      }),
      adapter: ledgerAdapter,
    })

    const world = archetype.world.inbox({
      account: { id: 'acct-1', email: 'alex@example.com' },
      threads: [{ id: 'thread-1', subject: 'Advisor confirmation', state: 'active' }],
      selectedThread: { id: 'thread-1' },
      ledgers: { threads: threadLedger },
      peers: { relay: { id: 'relay' } },
      personMemory: archetype.memory.person({ adapter: memoryAdapter }),
    })

    expect(orbit.inspect().archetype).toBe('personal-assistant')
    expect(world.kind).toBe('inbox-world')
    expect((world.data.ledgers as { threads: typeof threadLedger }).threads.docsSource).toBe('generated')
    expect(() => archetype.world.inbox({
      threads: [],
      sections: { inbox: 'INBOX LANDSCAPE' },
    } as any)).toThrow(/world\.inbox does not accept app-authored prompt field "sections"/u)
  })

  it('models Compound ledgers as typed mutable records with visible ids', () => {
    const compound = archetype.financialAdvisor({ provider })
    const transactions = archetype.ledger({
      name: 'transactions',
      schema: z.object({
        merchant: z.string(),
        amount: z.number(),
        category: z.string().optional(),
      }),
      adapter: ledgerAdapter,
    })
    const profile = archetype.singletonLedger({
      name: 'profile',
      schema: z.object({
        monthlyIncome: z.number().optional(),
        savingsGoal: z.number().optional(),
      }),
      adapter: { list: ledgerAdapter.list, update: ledgerAdapter.update },
    })

    const world = archetype.world.generic({
      ledgers: { transactions, profile },
      data: {
        personMemory: archetype.memory.person({ adapter: memoryAdapter }),
      },
    })

    expect(compound.inspect().archetype).toBe('financial-advisor')
    expect(world.kind).toBe('generic-world')
    expect(archetype.audit.ledgerRecords({
      ledgerName: 'transactions',
      records: [{ id: 'tx-1', merchant: 'Spotify', amount: -12.99 }],
    })).toEqual({ pass: true, issues: [] })

    const serialized = archetype.audit.ledgerRecords({
      ledgerName: 'transactions',
      records: 'tx-1 Spotify -12.99',
    })
    expect(serialized.pass).toBe(false)
    expect(serialized.issues[0].message).toContain('serialized prose')

    const missingId = archetype.audit.ledgerRecords({
      ledgerName: 'transactions',
      records: [{ merchant: 'Spotify', amount: -12.99 }],
    })
    expect(missingId.pass).toBe(false)
    expect(missingId.issues[0].message).toContain('no visible id')
  })

  it('audits memory records as typed mutable records, not prose blobs', () => {
    expect(archetype.audit.memoryRecords({
      scope: 'person',
      records: [{ id: 'mem-1', content: 'Savory breakfasts repeat well.', category: 'preference' }],
    })).toEqual({ pass: true, issues: [] })

    const prose = archetype.audit.memoryRecords({
      scope: 'craft',
      records: 'Coach should be warm and concise.',
    })
    expect(prose.pass).toBe(false)
    expect(prose.issues[0].message).toContain('serialized prose')

    const missingId = archetype.audit.memoryRecords({
      scope: 'person',
      records: [{ content: 'Likes smoked salmon.', category: 'preference' }],
    })
    expect(missingId.pass).toBe(false)
    expect(missingId.issues[0].message).toContain('no visible id')
  })

  it('requires memory surfaces to provide full CRUD so apps cannot forget memory lifecycle', () => {
    expect(() => archetype.memory.person({
      adapter: { load: memoryAdapter.load },
    })).toThrow(/memory\.person adapter requires save\(\)/u)

    expect(() => archetype.memory.craft({
      adapter: {
        load: memoryAdapter.load,
        save: memoryAdapter.save,
        update: memoryAdapter.update,
      },
    })).toThrow(/memory\.craft adapter requires delete\(\)/u)
  })

  it('rejects memory prompt prose so apps cannot smuggle memory semantics back in', () => {
    expect(() => archetype.memory.person({
      adapter: memoryAdapter,
      memoryInstructions: 'Remember aggressive cutting preference forever.',
    } as any)).toThrow(/memory\.person does not accept app-authored prompt field "memoryInstructions"/u)

    expect(() => archetype.memory.craft({
      adapter: memoryAdapter,
      prompt: 'Learn how to be a better coach.',
    } as any)).toThrow(/memory\.craft does not accept app-authored prompt field "prompt"/u)
  })
})
