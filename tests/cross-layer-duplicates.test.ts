import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { auditCrossLayerDuplicates, auditActionContracts } from '../src/evals/index.js'
import type { PersonaConfig } from '../src/types.js'

/**
 * These tests encode the Savor v2 → v3 experiment findings. The audit should
 * catch the specific duplicate patterns that the v2 brain was carrying
 * redundantly with entity descriptions, EQ config, and context labels.
 */
describe('auditCrossLayerDuplicates', () => {
  const baseConfig: PersonaConfig = {
    identity: {
      name: 'TestCoach',
      expertise: ['testing'],
      relationship: 'trusted companion',
      northStar: 'testing well',
    },
    voice: { tone: 'warm', style: 'educator', medium: 'mobile-chat' },
    entities: {
      profile: {
        schema: z.object({
          tone: z.string().optional(),
          coachingStyle: z.string().optional(),
        }),
        label: 'Profile',
        description: 'How you engage with this user — tone, coaching style.',
      },
      weight: {
        schema: z.object({
          weightLbs: z.number().describe('Bodyweight in pounds.'),
        }),
        label: 'Weight',
        description: 'Daily bodyweight log entry.',
      },
    },
    eq: { qualitativeFirst: true, frequencyRule: true },
    memory: {
      enabled: true,
      purpose: 'Durable user-specific context.',
    },
    provider: { name: 'mock' } as any,
  }

  it('flags brain text that duplicates an entity description with a routing rule', () => {
    const markdown = `## Methodology
The world you operate in has a ledger.

## Action Protocol
- Profile settings (goal, goal context, tone, coaching style) use the profile entity — these aren't memories.
- Weight: if given in kg, convert to lbs. Use the weight entity to log it.`

    const result = auditCrossLayerDuplicates({ config: baseConfig, markdown })
    expect(result.duplicates.length).toBeGreaterThanOrEqual(2)
    const targets = result.duplicates.map((d) => d.target)
    expect(targets).toContain('profile')
    expect(targets).toContain('weight')
  })

  it('flags brain text that duplicates eq.qualitativeFirst', () => {
    const markdown = `## Greeting Guidelines
- Default to qualitative language, but share numbers if the user asks.`
    const result = auditCrossLayerDuplicates({ config: baseConfig, markdown })
    expect(result.duplicates.some((d) => d.target === 'qualitativeFirst')).toBe(true)
  })

  it('does not flag scene-setting prose that merely mentions an entity name', () => {
    const markdown = `## Methodology
You work inside Savor. The daily ledger is the food record and memories are the relationship history.`
    const result = auditCrossLayerDuplicates({ config: baseConfig, markdown })
    expect(result.duplicates).toHaveLength(0)
  })

  it('flags "use the id shown" when the context input already has includeIds', () => {
    const withContext: PersonaConfig = {
      ...baseConfig,
      contextInputs: {
        profileRecord: {
          label: 'PROFILE RECORD (use this id for profile updates)',
          format: 'list',
          includeIds: true,
        },
      },
    }
    const markdown = `## Action Protocol
- For profile updates, use the id shown in the PROFILE RECORD context block.`
    const result = auditCrossLayerDuplicates({ config: withContext, markdown })
    expect(result.duplicates.some((d) => d.target === 'profileRecord')).toBe(true)
  })

  // Northstar-pattern regressions — these are the cases that exposed gaps in
  // the entity-gated first version.

  it('flags definitional drift — "Threads are CEO-level challenges..."', () => {
    const config: PersonaConfig = {
      ...baseConfig,
      entities: {
        thread: {
          schema: z.object({ title: z.string() }),
          label: 'Thread',
          description: 'CEO-level challenge that persists across weeks.',
        },
      },
    }
    const markdown = `## Methodology
"Threads" are CEO-level challenges that persist across weeks. Movement means decisions made, resources committed, or forcing functions created.`
    const result = auditCrossLayerDuplicates({ config, markdown })
    const targets = result.duplicates.map((d) => d.target)
    expect(targets).toContain('thread')
  })

  it('flags frequencyRule duplicate in concept form ("when something shows up three times")', () => {
    const markdown = `## Methodology
Patterns across meetings and execs. When something shows up once, it's a moment. When it shows up three times, it's worth naming.`
    const result = auditCrossLayerDuplicates({ config: baseConfig, markdown })
    expect(result.duplicates.some((d) => d.target === 'frequencyRule')).toBe(true)
  })

  it('flags identity.keystone paraphrase (80/20 leverage language)', () => {
    const configWithKeystone: PersonaConfig = {
      ...baseConfig,
      identity: {
        ...baseConfig.identity,
        keystone: 'What is the single most impactful thing you could say right now?',
      },
    }
    const markdown = `## Methodology
The 80/20 leverage point: what single move creates disproportionate forward progress?`
    const result = auditCrossLayerDuplicates({ config: configWithKeystone, markdown })
    expect(result.duplicates.some((d) => d.targetLayer === 'identity-keystone')).toBe(true)
  })

  it('flags voice-formatting leaking into methodology', () => {
    const markdown = `## Methodology
The interface renders rich markdown — **bold**, *italic*, headers, bullet lists, blockquotes — so use formatting when it helps structure your thinking for the CEO.`
    const result = auditCrossLayerDuplicates({ config: baseConfig, markdown })
    expect(result.duplicates.some((d) => d.targetLayer === 'voice-formatting')).toBe(true)
  })
})

describe('auditActionContracts', () => {
  const mockProvider = { name: 'mock' } as any
  const baseIdentity = {
    identity: { name: 'Test', expertise: ['x'], relationship: 'y', northStar: 'z' },
    voice: { tone: 'warm', style: 'educator', medium: 'mobile-chat' } as const,
    provider: mockProvider,
  }

  it('flags generic action names', () => {
    const config: PersonaConfig = {
      ...baseIdentity,
      actions: {
        handleData: {
          description: 'Process the incoming data payload.',
          schema: z.object({ data: z.any() }),
          confidence: 'medium',
        },
      },
    }
    const result = auditActionContracts({ config })
    const principles = result.issues.map((i) => i.principle)
    expect(principles).toContain('generic-name')
    expect(principles).toContain('vague-schema-type')
    expect(result.pass).toBe(false)
  })

  it('flags self-documenting names with redundant long descriptions', () => {
    const config: PersonaConfig = {
      ...baseIdentity,
      actions: {
        sendEmail: {
          description:
            'This action sends an email. Use sendEmail to send an email to the specified recipient. The email is sent immediately after this action is called. Sending an email is the primary function of sendEmail.',
          schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
          confidence: 'medium',
        },
      },
    }
    const result = auditActionContracts({ config })
    expect(
      result.issues.some((i) => i.principle === 'self-documenting-overdocumented'),
    ).toBe(true)
  })

  it('flags entity fields missing describe() annotations for non-obvious fields', () => {
    const config: PersonaConfig = {
      ...baseIdentity,
      entities: {
        task: {
          schema: z.object({
            complexity: z.number(),
            priority: z.string(),
            title: z.string(),
          }),
          label: 'Task',
          description: 'A task in the system.',
        },
      },
    }
    const result = auditActionContracts({ config })
    const missingFields = result.issues
      .filter((i) => i.principle === 'missing-field-description')
      .map((i) => i.message)
    expect(missingFields.some((m) => m.includes('complexity'))).toBe(true)
    expect(missingFields.some((m) => m.includes('priority'))).toBe(true)
    // title is in the "obvious" set
    expect(missingFields.some((m) => m.includes('"title"'))).toBe(false)
  })

  it('passes clean contracts', () => {
    const config: PersonaConfig = {
      ...baseIdentity,
      entities: {
        meal: {
          schema: z.object({
            description: z.string().describe('Short description of the meal.'),
            time: z.string().describe('HH:MM when the meal was eaten.'),
          }),
          label: 'Meal',
          description: 'A meal the user ate or is planning.',
        },
      },
      actions: {
        sendEmail: {
          description: 'Use when the user confirms they want to send an email.',
          schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
          confidence: 'medium',
        },
      },
    }
    const result = auditActionContracts({ config })
    expect(result.pass).toBe(true)
  })
})
