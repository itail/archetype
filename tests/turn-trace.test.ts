import { describe, it, expect, vi } from 'vitest'
import { definePersona, extractAlerts, summarizeTrace, annotateMessage, stripActionAnnotations, stripAnnotationsForDisplay } from '../src/index.js'
import { chat, validateActions, createTrace } from '../src/engine/chat.js'
import type { LLMProvider, PersonaConfig, TurnTrace } from '../src/types.js'
import { z } from 'zod'

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockProvider(responseOverride?: string): LLMProvider {
  const defaultResponse = JSON.stringify({
    message: 'Hello!',
    actions: [],
  })
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseOverride ?? defaultResponse }),
  }
}

const baseConfig: Omit<PersonaConfig, 'provider'> = {
  identity: { name: 'Coach', expertise: ['coaching'], relationship: 'partner', northStar: 'growth' },
  voice: { tone: 'balanced', style: 'educator' },
}

// ─── TurnTrace: trace building ──────────────────────────────────────────────

describe('TurnTrace', () => {
  it('returns trace with parseOk: true for valid JSON response', async () => {
    const provider = createMockProvider()
    const config: PersonaConfig = { ...baseConfig, provider }
    const result = await chat(config, { message: 'hi' })

    expect(result.trace).toBeDefined()
    expect(result.trace.traceId).toBeTruthy()
    expect(result.trace.parseOk).toBe(true)
    expect(result.trace.startedAt).toBeGreaterThan(0)
  })

  it('records the actual provider model that produced the turn', async () => {
    const provider: LLMProvider = {
      name: 'mock:primary',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify({ message: 'Hello!', actions: [] }),
        requestedModel: 'primary',
        model: 'fallback-model',
      }),
    }
    const config: PersonaConfig = { ...baseConfig, provider }
    const result = await chat(config, { message: 'hi' })

    expect(result.trace.provider).toEqual({
      name: 'mock:primary',
      requestedModel: 'primary',
      model: 'fallback-model',
    })
  })

  it('returns trace with parseOk: false for invalid JSON response', async () => {
    const provider = createMockProvider('not json at all')
    const config: PersonaConfig = { ...baseConfig, provider }
    const result = await chat(config, { message: 'hi' })

    expect(result.trace.parseOk).toBe(false)
    expect(result.trace.errors).toContain('Failed to parse LLM response as JSON')
  })

  it('captures valid actions in trace', async () => {
    const response = JSON.stringify({
      message: 'Logging weight.',
      actions: [{ name: 'logWeight', params: { weightLbs: 85 } }],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = {
      ...baseConfig,
      provider,
      actions: {
        logWeight: {
          description: 'Log weight',
          schema: z.object({ weightLbs: z.number() }),
          confidence: 'low',
        },
      },
    }
    const result = await chat(config, { message: 'I weigh 85 lbs' })

    expect(result.trace.actions).toHaveLength(1)
    expect(result.trace.actions[0]).toMatchObject({
      name: 'logWeight',
      status: 'valid',
    })
  })

  it('captures unknown actions in trace (currently silently dropped)', async () => {
    const response = JSON.stringify({
      message: 'Done!',
      actions: [{ name: 'nonExistentAction', params: { foo: 'bar' } }],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = { ...baseConfig, provider }
    const result = await chat(config, { message: 'do something' })

    expect(result.trace.actions).toHaveLength(1)
    expect(result.trace.actions[0]).toMatchObject({
      name: 'nonExistentAction',
      status: 'unknown_action',
    })
    // extractAlerts derives the alert from trace.actions — no need for explicit error push
    const alerts = extractAlerts(result.trace)
    expect(alerts.some(a => a.message.includes('nonExistentAction'))).toBe(true)
  })

  it('captures invalid action params in trace', async () => {
    const response = JSON.stringify({
      message: 'Logging.',
      actions: [{ name: 'logWeight', params: { weightLbs: 'not a number' } }],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = {
      ...baseConfig,
      provider,
      actions: {
        logWeight: {
          description: 'Log weight',
          schema: z.object({ weightLbs: z.number() }),
          confidence: 'low',
        },
      },
    }
    const result = await chat(config, { message: 'weight' })

    const invalid = result.trace.actions.find(a => a.status === 'invalid')
    expect(invalid).toBeDefined()
    expect(invalid!.name).toBe('logWeight')
    expect(invalid!.error).toBeTruthy()
  })

  it('captures CRUD validation failures in trace', async () => {
    const response = JSON.stringify({
      message: 'Creating task.',
      actions: [{
        name: 'crud',
        params: { operation: 'create', entity: 'unknownEntity', params: '{}' },
      }],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = {
      ...baseConfig,
      provider,
      entities: {
        task: { schema: z.object({ title: z.string() }), label: 'Task' },
      },
      memory: { enabled: true },
    }
    const result = await chat(config, { message: 'create something' })

    const invalidCrud = result.trace.crudActions.find(c => c.status === 'invalid')
    expect(invalidCrud).toBeDefined()
    expect(invalidCrud!.entity).toBe('unknownEntity')
  })

  it('marks legacy top-level crudActions as contract drift in trace', async () => {
    const response = JSON.stringify({
      message: 'Creating task.',
      actions: [],
      crudActions: [
        { operation: 'create', entity: 'task', params: '{"title":"Inbox cleanup"}' },
      ],
      outcomeNotes: ['Created a task.'],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = {
      ...baseConfig,
      provider,
      entities: {
        task: { schema: z.object({ title: z.string() }), label: 'Task' },
      },
    }
    const result = await chat(config, { message: 'create something' })

    expect(result.crudActions).toEqual([
      expect.objectContaining({ operation: 'create', entity: 'task' }),
    ])
    expect(result.trace.errors).toContain(
      'Raw response used legacy top-level "crudActions" key; use actions[{ "name": "crud", ... }] instead.',
    )
  })

  it('tracks repair attempts', async () => {
    // First response has invalid params, second is valid
    let callCount = 0
    const provider: LLMProvider = {
      name: 'mock',
      chat: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            text: JSON.stringify({
              message: 'Hi',
              actions: [{ name: 'logWeight', params: { weightLbs: 'bad' } }],
            }),
          })
        }
        return Promise.resolve({
          text: JSON.stringify({
            message: 'Hi',
            actions: [{ name: 'logWeight', params: { weightLbs: 85 } }],
          }),
        })
      }),
    }
    const config: PersonaConfig = {
      ...baseConfig,
      provider,
      actions: {
        logWeight: {
          description: 'Log weight',
          schema: z.object({ weightLbs: z.number() }),
          confidence: 'low',
        },
      },
    }
    const result = await chat(config, { message: 'weight 85' })

    expect(result.trace.repairAttempted).toBe(true)
  })

  it('includes outcomeNotes only when valid actions exist', async () => {
    const response = JSON.stringify({
      message: 'Logged!',
      actions: [{ name: 'logWeight', params: { weightLbs: 85 } }],
      outcomeNotes: ['Weight logged at 85 lbs'],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = {
      ...baseConfig,
      provider,
      actions: {
        logWeight: {
          description: 'Log weight',
          schema: z.object({ weightLbs: z.number() }),
          confidence: 'low',
        },
      },
    }
    const result = await chat(config, { message: 'I weigh 85 lbs' })

    expect(result.outcomeNotes).toEqual(['Weight logged at 85 lbs'])
  })

  it('drops outcomeNotes when all actions fail validation', async () => {
    const response = JSON.stringify({
      message: 'Done!',
      actions: [{ name: 'nonExistent', params: {} }],
      outcomeNotes: ['Something happened'],
    })
    const provider = createMockProvider(response)
    const config: PersonaConfig = { ...baseConfig, provider }
    const result = await chat(config, { message: 'do it' })

    expect(result.outcomeNotes).toBeUndefined()
  })
})

// ─── extractAlerts ──────────────────────────────────────────────────────────

describe('extractAlerts', () => {
  it('returns empty for clean trace', () => {
    const trace = createTrace()
    trace.parseOk = true
    expect(extractAlerts(trace)).toEqual([])
  })

  it('flags parse failure', () => {
    const trace = createTrace()
    trace.parseOk = false
    const alerts = extractAlerts(trace)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('error')
  })

  it('flags unknown actions', () => {
    const trace = createTrace()
    trace.parseOk = true
    trace.actions = [{ name: 'badAction', status: 'unknown_action' }]
    const alerts = extractAlerts(trace)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('error')
    expect(alerts[0].action).toBe('badAction')
  })

  it('flags invalid actions as warnings', () => {
    const trace = createTrace()
    trace.parseOk = true
    trace.actions = [{ name: 'logWeight', status: 'invalid', error: 'bad params' }]
    const alerts = extractAlerts(trace)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('warn')
  })

  it('flags execution failures', () => {
    const trace = createTrace()
    trace.parseOk = true
    trace.executionResults = [{ operation: 'create', entity: 'memory', status: 'failed', error: 'db down' }]
    const alerts = extractAlerts(trace)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('error')
  })

  it('flags legacy top-level crudActions drift as a warning', () => {
    const trace = createTrace()
    trace.parseOk = true
    trace.errors.push('Raw response used legacy top-level "crudActions" key; use actions[{ "name": "crud", ... }] instead.')
    const alerts = extractAlerts(trace)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('warn')
  })
})

// ─── summarizeTrace ─────────────────────────────────────────────────────────

describe('summarizeTrace', () => {
  it('counts actions and failures', () => {
    const trace = createTrace()
    trace.parseOk = true
    trace.actions = [
      { name: 'a', status: 'valid' },
      { name: 'b', status: 'invalid', error: 'oops' },
    ]
    trace.crudActions = [
      { operation: 'create', entity: 'task', status: 'valid' },
    ]
    const summary = summarizeTrace(trace)
    expect(summary.actionCount).toBe(3)
    expect(summary.failedCount).toBe(1)
    expect(summary.traceId).toBe(trace.traceId)
  })
})

// ─── Outcome annotation round-trip ──────────────────────────────────────────

describe('outcome annotation round-trip', () => {
  it('annotateMessage writes both markers in correct order', () => {
    const result = annotateMessage(
      'Great morning!',
      ['logWeight: weightLbs=85'],
      ['Weight logged at 85 lbs'],
    )
    expect(result).toBe(
      'Great morning!\n---outcomes: Weight logged at 85 lbs\n---actions: logWeight: weightLbs=85',
    )
  })

  it('stripActionAnnotations preserves ---outcomes: and strips ---actions:', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'Great morning!\n---outcomes: Weight logged at 85 lbs\n---actions: logWeight: weightLbs=85',
      },
    ]
    const cleaned = stripActionAnnotations(history)
    expect(cleaned[0].content).toBe('Great morning!\n---outcomes: Weight logged at 85 lbs')
  })

  it('preserves messages without annotations', () => {
    const history = [
      { role: 'assistant' as const, content: 'Just a normal message' },
      { role: 'user' as const, content: 'Hello' },
    ]
    const cleaned = stripActionAnnotations(history)
    expect(cleaned[0].content).toBe('Just a normal message')
    expect(cleaned[1].content).toBe('Hello')
  })

  it('handles message with outcomes but no actions', () => {
    const result = annotateMessage('Hello!', [], ['Weight logged'])
    expect(result).toBe('Hello!\n---outcomes: Weight logged')
    // No ---actions: marker since annotations array is empty
  })

  it('handles message with actions but no outcomes', () => {
    const result = annotateMessage('Hello!', ['logWeight: 85'])
    expect(result).toBe('Hello!\n---actions: logWeight: 85')
  })
})

// ─── stripAnnotationsForDisplay (user-facing) ───────────────────────────────

describe('stripAnnotationsForDisplay', () => {
  it('strips both outcomes and actions for user display', () => {
    const stored = 'Great morning!\n---outcomes: Weight logged at 85 lbs\n---actions: logWeight: weightLbs=85'
    expect(stripAnnotationsForDisplay(stored)).toBe('Great morning!')
  })

  it('strips actions-only messages', () => {
    const stored = 'Done!\n---actions: logWeight: weightLbs=85'
    expect(stripAnnotationsForDisplay(stored)).toBe('Done!')
  })

  it('strips outcomes-only messages', () => {
    const stored = 'Logged!\n---outcomes: Weight recorded'
    expect(stripAnnotationsForDisplay(stored)).toBe('Logged!')
  })

  it('passes through clean messages unchanged', () => {
    expect(stripAnnotationsForDisplay('Just a message')).toBe('Just a message')
  })
})
