import { describe, it, expect, vi } from 'vitest'
import { PersonaEngine } from '../src/persona.js'
import type { PersonaConfig, LLMProvider } from '../src/types.js'

// The retrospect pass must offer — and honor — exactly ONE memory-mutation
// representation: the crud envelope. It must never offer the legacy per-entity
// action names (saveMemory / updateMemory / saveCraftMemory…), and if the model
// emits one anyway it must surface in the trace, never be silently passed.

function fixedProvider(responseText: string): { provider: LLMProvider; lastSchema: () => unknown } {
  let schema: unknown
  return {
    lastSchema: () => schema,
    provider: {
      name: 'fixed',
      chat: vi.fn().mockImplementation(async (req: any) => {
        schema = req.responseSchema
        return { text: responseText }
      }),
    },
  }
}

function memoryPersona(): PersonaConfig {
  return {
    identity: { name: 'Bot', expertise: ['x'], relationship: 'guide', northStar: 'g' },
    voice: { tone: 'balanced', style: 'educator' },
    memory: { enabled: true, purpose: 'durable background', categories: { general: 'general' } },
    craftMemory: { enabled: true, purpose: 'craft', categories: { approach: 'what works' } },
    provider: { name: 'noop', chat: vi.fn() },
  }
}

function actionNameEnums(schema: any): string[] {
  // actions.items is either a single variant or { anyOf: [...] }
  const items = schema?.properties?.actions?.items
  const variants = items?.anyOf ?? (items ? [items] : [])
  return variants.flatMap((v: any) => v?.properties?.name?.enum ?? [])
}

describe('retrospect memory-mutation contract', () => {
  it('offers only the crud action in the schema — never legacy named memory actions', async () => {
    const { provider, lastSchema } = fixedProvider(JSON.stringify({ actions: [] }))
    const engine = new PersonaEngine({ ...memoryPersona(), provider })

    await engine.retrospect({ userIdentity: 'Tester' })

    const names = actionNameEnums(lastSchema())
    expect(names).toContain('crud')
    expect(names).not.toContain('saveMemory')
    expect(names).not.toContain('updateMemory')
    expect(names).not.toContain('saveCraftMemory')
    expect(names).not.toContain('deleteMemory')
  })

  it('parses a crud-envelope memory mutation as a valid crud action', async () => {
    const response = JSON.stringify({
      actions: [
        { name: 'crud', params: { operation: 'create', entity: 'memory', params: JSON.stringify({ content: 'likes kimchi', category: 'general' }) } },
      ],
    })
    const engine = new PersonaEngine({ ...memoryPersona(), provider: fixedProvider(response).provider })

    const result = await engine.retrospect({ userIdentity: 'Tester' })

    expect(result.crudActions).toHaveLength(1)
    expect(result.crudActions![0]).toMatchObject({ operation: 'create', entity: 'memory' })
    expect(result.trace.crudActions.some(c => c.status === 'valid')).toBe(true)
    // No legacy action silently treated as valid
    expect(result.actions).toHaveLength(0)
  })

  it('flags a stray legacy named memory action in the trace instead of silently passing it', async () => {
    const response = JSON.stringify({
      actions: [
        { name: 'updateMemory', params: { id: 'm1', content: 'x' } },
        { name: 'saveCraftMemory', params: { content: 'y', category: 'approach' } },
      ],
    })
    const engine = new PersonaEngine({ ...memoryPersona(), provider: fixedProvider(response).provider })

    const result = await engine.retrospect({ userIdentity: 'Tester' })

    // Neither is honored as a valid action…
    expect(result.actions).toHaveLength(0)
    // …and both are recorded in the trace as unknown actions (loud, not silent).
    const unknown = result.trace.actions.filter(a => a.status === 'unknown_action').map(a => a.name)
    expect(unknown).toContain('updateMemory')
    expect(unknown).toContain('saveCraftMemory')
  })
})
