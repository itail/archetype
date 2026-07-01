import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildPromptedTurnLLMRequest, coderActions, definePersona } from '../src/index.js'

describe('prompt contract style', () => {
  const persona = definePersona({
    identity: {
      name: 'Operator',
      expertise: ['operations'],
      relationship: 'assistant',
      northStar: 'move durable work honestly',
    },
    voice: {
      tone: 'balanced',
      style: 'quick',
    },
    provider: {
      name: 'stub',
      async chat() {
        throw new Error('not used in prompt tests')
      },
    },
    entities: {
      work_item: {
        description: 'Durable owned work in the shared ledger.',
        schema: z.object({
          title: z.string(),
          ownerId: z.string(),
          priority: z.enum(['low', 'medium', 'high']),
          dueAt: z.string().optional(),
        }),
      },
    },
    actions: {
      sendExternalMessage: {
        description: 'Send a message on an owned external thread.',
        schema: z.object({
          threadId: z.string(),
          body: z.string(),
        }),
        confidence: 'low',
      },
      requestCapability: {
        description: 'Surface a real missing capability when blocked.',
        schema: z.object({
          kind: z.enum(['tool', 'authority']),
          whyBlocked: z.string(),
        }),
        confidence: 'high',
      },
    },
  })

  it('keeps self-documenting names and param shapes in lean mode', () => {
    const { request } = buildPromptedTurnLLMRequest(persona.config, {
      intent: 'Operate from your seat.',
      label: 'Operator / Test',
      turnKind: 'operational',
      promptMode: 'operational',
      contractStyle: 'lean',
      context: {
        queue: ['work item waiting'],
      },
    })

    const prompt = request.systemPrompt

    expect(prompt).toContain('--- AVAILABLE ACTIONS ---')
    expect(prompt).toContain('- sendExternalMessage')
    expect(prompt).toContain('params: { threadId: string, body: string }')
    expect(prompt).toContain('- requestCapability')
    expect(prompt).toContain('params: { kind: "tool" | "authority", whyBlocked: string }')
    expect(prompt).toContain('--- CRUD ---')
    expect(prompt).toContain('- work_item')
    expect(prompt).toContain('fields: { title: string, ownerId: string, priority: "low" | "medium" | "high", dueAt: string? }')
    expect(prompt).toContain('valid action names: sendExternalMessage, requestCapability')
  })

  it('strips bulky contract prose in lean mode', () => {
    const full = buildPromptedTurnLLMRequest(persona.config, {
      intent: 'Operate from your seat.',
      label: 'Operator / Full',
      turnKind: 'operational',
      promptMode: 'operational',
      contractStyle: 'full',
    }).request.systemPrompt

    const lean = buildPromptedTurnLLMRequest(persona.config, {
      intent: 'Operate from your seat.',
      label: 'Operator / Lean',
      turnKind: 'operational',
      promptMode: 'operational',
      contractStyle: 'lean',
    }).request.systemPrompt

    expect(full).toContain('params may only contain keys declared in that action\'s params signature')
    expect(full).toContain('Only include actions when the live operational turn should actually change state.')
    expect(full).toContain('do not use a top-level "crudActions" key')
    expect(lean).not.toContain('params may only contain keys declared in that action\'s params signature')
    expect(lean).not.toContain('Only include actions when the live operational turn should actually change state.')
    expect(lean).not.toContain('do not use a top-level "crudActions" key')
    expect(lean.length).toBeLessThan(full.length)
  })

  it('keeps focus output wording capability-based rather than over-prescribing batching or edit semantics', () => {
    const { request } = buildPromptedTurnLLMRequest(persona.config, {
      intent: 'Operate from your seat.',
      label: 'Operator / Focus',
      turnKind: 'operational',
      promptMode: 'focus',
      contractStyle: 'lean',
    })

    expect(request.systemPrompt).toContain('actions" is a list executed in order within this turn')
    expect(request.systemPrompt).toContain('Later actions run after earlier state changes')
    expect(request.systemPrompt).toContain('you choose the whole list before any action outcomes are known')
    expect(request.systemPrompt).toContain('when a result could change what you do next')
    expect(request.systemPrompt).toContain('Future turns receive factual action outcomes, not raw action payloads')
    expect(request.systemPrompt).not.toContain('Pack as many as fit')
    expect(request.systemPrompt).not.toContain('A multi-edit editFile')
    expect(request.systemPrompt).not.toContain('action 1, then action 2, then action 3')
  })

  it('documents workspace-vs-browser surfaces only when both file and browser tools exist', () => {
    const builderPersona = definePersona({
      identity: {
        name: 'Builder',
        expertise: ['browser implementation'],
        relationship: 'builder',
        northStar: 'ship working artifacts',
      },
      provider: persona.config.provider,
      actions: {
        applyPatch: coderActions.applyPatch,
        browserOpen: coderActions.browserOpen,
        browserScreenshot: coderActions.browserScreenshot,
      },
    })

    const { request: builderRequest } = buildPromptedTurnLLMRequest(builderPersona.config, {
      intent: 'Work on the browser artifact.',
      label: 'Builder',
      turnKind: 'operational',
      promptMode: 'operational',
      contractStyle: 'lean',
    })
    const { request: operatorRequest } = buildPromptedTurnLLMRequest(persona.config, {
      intent: 'Operate from your seat.',
      label: 'Operator',
      turnKind: 'operational',
      promptMode: 'operational',
      contractStyle: 'lean',
    })

    expect(builderRequest.systemPrompt).toContain('Workspace files and live browser pages are separate surfaces')
    expect(builderRequest.systemPrompt).toContain('use browserOpen to load or reload those files before browser actions inspect the updated page')
    expect(operatorRequest.systemPrompt).not.toContain('Workspace files and live browser pages are separate surfaces')
  })

  it('does not name optional browser actions inside runTests guidance', () => {
    expect(coderActions.runTests.description).toContain('whichever browser actions this persona exposes')
    expect(coderActions.runTests.description).not.toContain('browserClick')
  })
})
