import { describe, it, expect } from 'vitest'
import { resolveActions, resolveEntities } from '../src/core/effective-config.js'
import type { PersonaConfig, ActionDefinition } from '../src/types.js'
import { z } from 'zod'

const baseConfig: PersonaConfig = {
  identity: { name: 'Test', expertise: [], relationship: 'test', northStar: 'test' },
  voice: { tone: 'direct', style: 'quick' },
  provider: { name: 'mock', chat: async () => ({ text: '{}' }) },
}

describe('resolveActions', () => {
  it('returns undefined when no actions and no internal memory entities', () => {
    expect(resolveActions(baseConfig)).toBeUndefined()
  })

  it('returns app actions when no internal memory entities are enabled', () => {
    const appAction: ActionDefinition = {
      description: 'test',
      schema: z.object({ x: z.string() }),
      confidence: 'low',
    }
    const config = { ...baseConfig, actions: { testAction: appAction } }
    const resolved = resolveActions(config)
    expect(resolved).toEqual({ testAction: appAction })
  })

  it('does not merge internal memory actions into actions when memory is enabled', () => {
    const appAction: ActionDefinition = {
      description: 'test',
      schema: z.object({ x: z.string() }),
      confidence: 'low',
    }
    const config: PersonaConfig = {
      ...baseConfig,
      actions: { testAction: appAction },
      memory: { enabled: true },
    }
    const resolved = resolveActions(config)!
    expect(resolved).toHaveProperty('testAction')
    expect(resolved).not.toHaveProperty('saveMemory')
    expect(resolved).not.toHaveProperty('updateMemory')
    expect(resolved).not.toHaveProperty('deleteMemory')
  })

  it('returns undefined when only memory entities are enabled and no app actions exist', () => {
    const config: PersonaConfig = { ...baseConfig, memory: { enabled: true } }
    expect(resolveActions(config)).toBeUndefined()
  })
})

describe('resolveEntities', () => {
  it('returns undefined when no entities and no internal memory entities are enabled', () => {
    expect(resolveEntities(baseConfig)).toBeUndefined()
  })

  it('returns app entities when no internal memory entities are enabled', () => {
    const config: PersonaConfig = {
      ...baseConfig,
      entities: {
        task: { schema: z.object({ title: z.string() }), label: 'Task', displayField: 'title' },
      },
    }
    const resolved = resolveEntities(config)!
    expect(resolved).toHaveProperty('task')
    expect(resolved).not.toHaveProperty('memory')
  })

  it('registers memory entity when memory is enabled', () => {
    const config: PersonaConfig = {
      ...baseConfig,
      memory: { enabled: true },
    }
    const resolved = resolveEntities(config)!
    expect(resolved).toHaveProperty('memory')
    expect(resolved.memory.label).toBe('Memory')
    expect(resolved.memory.displayField).toBe('content')
  })

  it('registers craftMemory entity when craftMemory enabled', () => {
    const config: PersonaConfig = {
      ...baseConfig,
      craftMemory: { enabled: true },
    }
    const resolved = resolveEntities(config)!
    expect(resolved).toHaveProperty('craftMemory')
    expect(resolved.craftMemory.label).toBe('Craft Memory')
  })

  it('merges app entities with internal memory entities', () => {
    const config: PersonaConfig = {
      ...baseConfig,
      entities: {
        task: { schema: z.object({ title: z.string() }), label: 'Task', displayField: 'title' },
      },
      memory: { enabled: true },
      craftMemory: { enabled: true },
    }
    const resolved = resolveEntities(config)!
    expect(Object.keys(resolved)).toEqual(expect.arrayContaining(['task', 'memory', 'craftMemory']))
  })
})
