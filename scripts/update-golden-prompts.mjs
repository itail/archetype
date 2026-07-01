import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { buildChatLLMRequest, buildPromptedTurnLLMRequest } from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const fixtureDir = join(__dirname, '..', 'tests', '__fixtures__', 'golden-prompts')

function createFoundationConfig() {
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

function renderRequestArtifact(name, request) {
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

const config = createFoundationConfig()
const promptNow = '2026-04-10T23:20:00-07:00'
mkdirSync(fixtureDir, { recursive: true })

const chat = buildChatLLMRequest(config, {
  message: 'What should I focus on before tomorrow’s 1:1 with Sarah?',
  context: {
    page: 'Dashboard. One stuck thread: VP Eng roadmap stalling (thread_vp_eng). A decision is still open on roadmap ownership.',
    teamDir: '- Sarah: VP Engineering\n- Maya: Chief of Staff',
  },
  timezone: 'America/Los_Angeles',
  promptNow,
  userIdentity: 'Alex, CEO',
})

const proactive = buildPromptedTurnLLMRequest(config, {
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

const operational = buildPromptedTurnLLMRequest(config, {
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

writeFileSync(join(fixtureDir, 'chat.txt'), renderRequestArtifact('chat', chat.request))
writeFileSync(join(fixtureDir, 'proactive-conversation.txt'), renderRequestArtifact('proactive-conversation', proactive.request))
writeFileSync(join(fixtureDir, 'operational-turn.txt'), renderRequestArtifact('operational-turn', operational.request))

console.log(`Updated golden prompt fixtures in ${fixtureDir}`)
