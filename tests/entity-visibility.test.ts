import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { auditEntityVisibility } from '../src/evals/entity-visibility.js'
import type { PersonaConfig } from '../src/types.js'

const baseIdentity = {
  name: 'TestCoach',
  expertise: ['testing'],
  relationship: 'trusted companion',
  northStar: 'testing well',
}

const baseVoice = { tone: 'warm' as const, style: 'educator' as const, medium: 'mobile-chat' as const }

function makeConfig(
  entities: PersonaConfig['entities'],
  contextInputs?: PersonaConfig['contextInputs'],
): PersonaConfig {
  return {
    identity: baseIdentity,
    voice: baseVoice,
    entities,
    contextInputs,
    provider: { name: 'mock' } as any,
  }
}

describe('auditEntityVisibility', () => {
  it('passes when the entity name key is declared AND context carries a record with id', () => {
    const config = makeConfig(
      {
        profile: {
          schema: z.object({ goal: z.string() }),
          description: 'The user profile.',
        },
      },
      {
        profile: { label: 'PROFILE', format: 'kv' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { profile: [{ id: 'profile-1', goal: 'maintenance' }] },
    })

    expect(result.pass).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.perEntity.profile.visible).toBe(true)
    expect(result.perEntity.profile.how).toBe('context.profile (via contextInputs.profile)')
  })

  it('passes via the legacy ${name}Record convention', () => {
    const config = makeConfig(
      {
        profile: {
          schema: z.object({ goal: z.string() }),
          description: 'The user profile.',
        },
      },
      {
        profileRecord: { label: 'PROFILE RECORD', format: 'list' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { profileRecord: [{ id: 'profile-1', goal: 'maintenance' }] },
    })

    expect(result.pass).toBe(true)
    expect(result.perEntity.profile.how).toBe('context.profileRecord (via contextInputs.profileRecord)')
  })

  it('errors when context has the record but no contextInput is declared — the SDK silently drops it', () => {
    const config = makeConfig({
      profile: {
        schema: z.object({ goal: z.string() }),
        description: 'The user profile.',
      },
    })

    const result = auditEntityVisibility({
      config,
      context: { profile: [{ id: 'profile-1', goal: 'maintenance' }] },
    })

    expect(result.pass).toBe(false)
    const issue = result.issues.find(i => i.entity === 'profile')
    expect(issue?.severity).toBe('error')
    expect(issue?.principle).toBe('not-visible-in-context')
    expect(issue?.suggestion).toContain('contextInput')
    expect(result.perEntity.profile).toEqual({ visible: false, how: null })
  })

  it('errors when the contextInput is declared but the record has no id field', () => {
    const config = makeConfig(
      {
        weight: {
          schema: z.object({ weightLbs: z.number() }),
          description: 'Bodyweight log entry.',
        },
      },
      {
        weight: { label: 'WEIGHT', format: 'list' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { weight: [{ weightLbs: 180 }] },
    })

    expect(result.pass).toBe(false)
    expect(result.perEntity.weight.visible).toBe(false)
  })

  it('errors when the context passes a serialized string instead of a record — the Savor bug shape', () => {
    const config = makeConfig(
      {
        profile: {
          schema: z.object({ goal: z.string(), tone: z.string() }),
          description: 'The user profile.',
        },
        dailyTargets: {
          schema: z.object({ calTarget: z.number(), proteinG: z.number() }),
          description: 'Daily macro targets.',
        },
      },
      {
        profile: { label: 'USER PROFILE', format: 'kv' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: {
        profile: 'goal=maintenance, tone=warm',
        todayStatus: 'on track',
      },
    })

    expect(result.pass).toBe(false)
    const offenders = result.issues.map(i => i.entity).sort()
    expect(offenders).toEqual(['dailyTargets', 'profile'])
  })

  it('passes a createOnly entity even with no record in context', () => {
    const config = makeConfig({
      meal: {
        schema: z.object({ items: z.array(z.string()) }),
        description: 'A logged meal for today.',
        createOnly: true,
      },
    })

    const result = auditEntityVisibility({
      config,
      context: {},
    })

    expect(result.pass).toBe(true)
    expect(result.perEntity.meal.how).toContain('create-only')
  })

  it('stays silent when no entities are declared', () => {
    const config = makeConfig({})
    const result = auditEntityVisibility({ config, context: {} })
    expect(result.pass).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.perEntity).toEqual({})
  })

  it('matches the idiomatic semantic-prefix convention (openTasks → task)', () => {
    const config = makeConfig(
      {
        task: {
          schema: z.object({ title: z.string() }),
          description: 'A commitment to track.',
        },
      },
      {
        openTasks: { label: 'OPEN TASKS', format: 'list', includeIds: true, priority: 'critical' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { openTasks: [{ id: 'task-1', title: 'Draft investor update' }] },
    })

    expect(result.pass).toBe(true)
    expect(result.perEntity.task.how).toContain('openTasks')
  })

  it('matches a multi-word entity via its last camelCase token (forcingFunctions → forcingFunction)', () => {
    const config = makeConfig(
      {
        forcingFunction: {
          schema: z.object({ title: z.string() }),
          description: 'A concrete commitment that makes a thread move.',
        },
      },
      {
        forcingFunctions: { label: 'OPEN FORCING FUNCTIONS', format: 'list', includeIds: true },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { forcingFunctions: [{ id: 'ff-1', title: 'VP Eng roadmap call' }] },
    })

    expect(result.pass).toBe(true)
  })

  it('handles -y → -ies pluralization (memories → memory, if memory were user-declared)', () => {
    // Using a user-declared entity name that ends in 'y' to exercise the pluralize rule.
    // memory itself is SDK-exempt, so we use a synthetic name.
    const config = makeConfig(
      {
        story: {
          schema: z.object({ title: z.string() }),
          description: 'A user-written story.',
        },
      },
      {
        recentStories: { label: 'RECENT STORIES', format: 'list' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { recentStories: [{ id: 's-1', title: 'First story' }] },
    })

    expect(result.pass).toBe(true)
  })

  it('does not false-match on unrelated tokens (entity meal, contextInput ideal)', () => {
    const config = makeConfig(
      {
        meal: {
          schema: z.object({ name: z.string() }),
          description: 'A logged meal.',
        },
      },
      {
        ideal: { label: 'IDEAL TARGETS', format: 'block' },
      },
    )

    const result = auditEntityVisibility({
      config,
      context: { ideal: [{ id: 'x-1', name: 'high-protein' }] },
    })

    expect(result.pass).toBe(false)
    expect(result.perEntity.meal.visible).toBe(false)
  })

  it('flags user-declared memory entity when config.memory.includeIds is not set — the AI sees content without ids', () => {
    const config: PersonaConfig = {
      ...makeConfig({
        memory: {
          schema: z.object({ content: z.string(), category: z.string() }),
          description: 'User memories.',
        },
      }),
      memory: { enabled: true },
    }

    const result = auditEntityVisibility({
      config,
      context: {},
      memories: [{ id: 'm1', content: 'Something', category: 'general' }],
    })

    expect(result.pass).toBe(false)
    const issue = result.issues.find(i => i.entity === 'memory')
    expect(issue?.message).toContain('includeIds')
    expect(result.perEntity.memory.visible).toBe(false)
  })

  it('flags memory entity when includeIds is true but no memories are provided', () => {
    const config: PersonaConfig = {
      ...makeConfig({
        memory: {
          schema: z.object({ content: z.string(), category: z.string() }),
          description: 'User memories.',
        },
      }),
      memory: { enabled: true, includeIds: true },
    }

    const result = auditEntityVisibility({
      config,
      context: {},
      memories: [],
    })

    expect(result.pass).toBe(false)
    expect(result.perEntity.memory.visible).toBe(false)
  })

  it('passes memory entity when includeIds is true AND memories are provided', () => {
    const config: PersonaConfig = {
      ...makeConfig({
        memory: {
          schema: z.object({ content: z.string(), category: z.string() }),
          description: 'User memories.',
        },
      }),
      memory: { enabled: true, includeIds: true },
    }

    const result = auditEntityVisibility({
      config,
      context: {},
      memories: [{ id: 'm1', content: 'Something', category: 'general' }],
    })

    expect(result.pass).toBe(true)
    expect(result.perEntity.memory.visible).toBe(true)
    expect(result.perEntity.memory.how).toContain('includeIds=true')
  })

  it('passes craftMemory entity when enabled AND craftMemories are provided (includeIds is hardcoded)', () => {
    const config: PersonaConfig = {
      ...makeConfig({
        craftMemory: {
          schema: z.object({ content: z.string(), category: z.string() }),
          description: 'Craft observations.',
        },
      }),
      craftMemory: { enabled: true },
    }

    const result = auditEntityVisibility({
      config,
      context: {},
      craftMemories: [{ id: 'c1', content: 'Pattern', category: 'approach' }],
    })

    expect(result.pass).toBe(true)
    expect(result.perEntity.craftMemory.visible).toBe(true)
  })

  it('flags craftMemory entity when enabled is missing', () => {
    const config = makeConfig({
      craftMemory: {
        schema: z.object({ content: z.string(), category: z.string() }),
        description: 'Craft observations.',
      },
    })

    const result = auditEntityVisibility({
      config,
      context: {},
      craftMemories: [{ id: 'c1', content: 'Pattern', category: 'approach' }],
    })

    expect(result.pass).toBe(false)
    const issue = result.issues.find(i => i.entity === 'craftMemory')
    expect(issue?.message).toContain('enabled')
  })
})
