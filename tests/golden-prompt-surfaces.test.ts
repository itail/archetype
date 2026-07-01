import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PersonaConfig } from '../src/types.js'
import { buildChatLLMRequest, buildPromptedTurnLLMRequest } from '../src/core/request-builder.js'
import { auditPromptContent } from '../src/evals/prompt-content.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function createFoundationConfig(): PersonaConfig {
  return {
    identity: {
      name: 'Coach',
      expertise: ['executive coaching', 'organizational behavior', 'strategic thinking'],
      relationship: 'trusted thinking partner',
      northStar: "the CEO's growth and the company's forward momentum",
    },
    voice: { tone: 'balanced', style: 'educator', medium: 'desktop-panel' },
    methodology: 'Threads are live company challenges. Progress means sharper ownership, clearer decisions, and real movement.',
    directives: {
      default: 'Speak like a sharp executive coach who can also move shared state cleanly when the work calls for it.',
      editable: true,
    },
    eq: {
      frequencyRule: true,
      autonomyRespect: true,
      qualitativeFirst: true,
      coherence: true,
      expertJudgment: true,
    },
    actions: {
      notifyOwner: {
        description: 'Nudge the accountable owner when a thread needs attention.',
        schema: z.object({
          threadId: z.string(),
          note: z.string(),
        }),
        confidence: 'high',
      },
    },
    entities: {
      thread: {
        label: 'Thread',
        displayField: 'title',
        schema: z.object({
          title: z.string(),
          ownerId: z.string(),
          status: z.enum(['active', 'waiting', 'done']),
        }),
      },
      decision: {
        label: 'Decision',
        displayField: 'title',
        schema: z.object({
          title: z.string(),
          status: z.enum(['open', 'made']),
        }),
      },
      memory: {
        label: 'Memory',
        displayField: 'content',
        schema: z.object({
          content: z.string(),
          category: z.string(),
          source: z.enum(['user', 'inferred', 'suggested']).optional(),
          stability: z.enum(['durable', 'tentative', 'temporary']).optional(),
          contextHint: z.string().optional(),
        }),
      },
      craftMemory: {
        label: 'Craft memory',
        displayField: 'content',
        schema: z.object({
          content: z.string(),
          category: z.string(),
        }),
      },
    },
    contextInputs: {
      page: { label: 'CURRENT PAGE CONTEXT' },
      teamDir: { label: 'TEAM DIRECTORY' },
    },
    memory: {
      enabled: true,
    },
    craftMemory: {
      enabled: true,
    },
    diagnostics: {
      enabled: true,
    },
    provider: { name: 'mock', chat: async () => ({ text: '' }) },
  }
}

function renderRequestArtifact(name: string, request: { promptMode: string, promptOrigin: string, systemPrompt: string, message: string }) {
  return [
    `NAME: ${name}`,
    `PROMPT MODE: ${request.promptMode}`,
    `PROMPT ORIGIN: ${request.promptOrigin}`,
    '',
    'SYSTEM PROMPT:',
    request.systemPrompt,
    '',
    'MESSAGE:',
    request.message,
    '',
  ].join('\n')
}

function readGoldenFixture(name: string) {
  return readFileSync(join(__dirname, '__fixtures__', 'golden-prompts', `${name}.txt`), 'utf8')
}

describe('golden prompt surfaces', () => {
  // NOTE on auditEntityVisibility: this suite intentionally does NOT wire it in.
  // The foundation config above is a synthetic harness for SDK-level prompt
  // assembly — thread/decision entities exist to render the CRUD block, not
  // to be exercised end-to-end. Visibility coverage belongs on SHIPPED templates
  // (see reference-coach-surfaces, reference-chief-surfaces, reference-template-surface).
  const config = createFoundationConfig()
  const declaredEntities = Object.keys(config.entities ?? {})
  const promptNow = '2026-04-10T23:20:00-07:00'

  it('matches the reviewed direct chat prompt', () => {
    const { request } = buildChatLLMRequest(config, {
      message: 'What should I focus on before tomorrow’s 1:1 with Sarah?',
      context: {
        page: 'Dashboard. One stuck thread: VP Eng roadmap stalling (thread_vp_eng). A decision is still open on roadmap ownership.',
        teamDir: '- Sarah: VP Engineering\n- Maya: Chief of Staff',
      },
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex, CEO',
    })

    const audit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(audit.issues).toEqual([])

    expect(renderRequestArtifact('chat', request)).toBe(readGoldenFixture('chat'))
  })

  it('matches the reviewed proactive conversation prompt', () => {
    const { request } = buildPromptedTurnLLMRequest(config, {
      intent: 'Offer one concise coaching observation before the CEO opens the roadmap review.',
      label: 'pre_accept reflection',
      turnKind: 'proactive-conversation',
      context: {
        page: 'Review screen. Proposed thread: VP Eng roadmap stalling (thread_vp_eng). Proposed decision: choose a single roadmap owner.',
        teamDir: '- Sarah: VP Engineering\n- Maya: Chief of Staff',
      },
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex, CEO',
      directives: 'Push for precision over reassurance.',
    })

    const audit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(audit.issues).toEqual([])

    expect(renderRequestArtifact('proactive-conversation', request)).toBe(readGoldenFixture('proactive-conversation'))
  })

  it('matches the reviewed operational turn prompt', () => {
    const { request } = buildPromptedTurnLLMRequest(config, {
      intent: 'Read the company state, decide the next operational move, and change shared state only through declared actions or entities.',
      label: 'daily operating turn',
      turnKind: 'operational',
      promptMode: 'operational',
      guidelines: 'Make the smallest real move that improves ownership or momentum.',
      context: {
        page: 'Operations view. Active thread: VP Eng roadmap stalling (thread_vp_eng). Open decision: roadmap owner. No new inbound user message.',
        teamDir: '- Sarah: VP Engineering\n- Maya: Chief of Staff',
      },
      timezone: 'America/Los_Angeles',
      promptNow,
      userIdentity: 'Alex, CEO',
    })

    const audit = auditPromptContent({ prompt: request.systemPrompt, declaredEntities })
    expect(audit.issues).toEqual([])

    expect(renderRequestArtifact('operational-turn', request)).toBe(readGoldenFixture('operational-turn'))
  })
})
