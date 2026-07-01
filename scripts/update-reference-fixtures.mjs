import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChatLLMRequest, buildPromptedTurnLLMRequest, COACH_TEMPLATE, CHIEF_OF_STAFF_TEMPLATE } from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const fixtureDir = join(__dirname, '..', 'tests', '__fixtures__', 'reference-app-prompts')
mkdirSync(fixtureDir, { recursive: true })

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }
const promptNow = '2026-04-10T23:20:00-07:00'

function render(name, request) {
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

const coachConfig = { ...COACH_TEMPLATE, provider: mockProvider }

const coachChat = buildChatLLMRequest(coachConfig, {
  message: 'I just had a tough 1:1 with my VP of Engineering. He keeps saying he needs more headcount, but I think the real issue is prioritization. How should I think about this?',
  history: [],
  context: {
    threads: [
      { id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'VP Eng', description: 'Shipping has slowed 40% quarter-over-quarter' },
      { id: 't2', title: 'Product-market fit for enterprise', status: 'active', owner: 'CRO', description: 'Need to close 3 enterprise deals by Q3' },
    ],
    forcingFunctions: [
      { id: 'ff1', title: 'VP Eng returns with a top-3 roadmap tradeoff call', owner: 'VP Eng', due: '2026-04-14', status: 'open', threadId: 't1' },
    ],
    coachingNotes: [
      { id: 'note-1', type: 'behavioral', text: 'Alex keeps brainstorming with VP Eng instead of forcing clear ownership.' },
    ],
  },
  memories: [
    { id: 'm1', content: 'CEO tends to over-index on headcount discussions', category: 'coaching_approach', pinned: true },
    { id: 'm2', content: 'VP Eng responds well to data-driven framing', category: 'preference' },
  ],
  timezone: 'America/Los_Angeles',
  promptNow,
  userIdentity: 'Alex, CEO',
})

const coachProactive = buildPromptedTurnLLMRequest(coachConfig, {
  intent: 'Offer one concise coaching observation before the CEO walks into the VP Eng roadmap 1:1.',
  label: 'pre_1_1 reflection',
  turnKind: 'proactive-conversation',
  context: {
    threads: [
      { id: 't1', title: 'Engineering velocity', status: 'stuck', owner: 'VP Eng', description: 'Shipping has slowed 40% quarter-over-quarter' },
    ],
    forcingFunctions: [
      { id: 'ff1', title: 'VP Eng returns with a top-3 roadmap tradeoff call', owner: 'VP Eng', due: '2026-04-14', status: 'open', threadId: 't1' },
    ],
    coachingNotes: [
      { id: 'note-1', type: 'behavioral', text: 'When Alex keeps brainstorming with VP Eng, ownership gets blurrier instead of sharper.' },
    ],
    profile: { name: 'Alex', role: 'CEO', company: 'Acme' },
  },
  memories: [
    { id: 'm1', content: 'Responds well to direct pattern-naming when it is specific and earned.', category: 'coaching_approach', pinned: true },
  ],
  timezone: 'America/Los_Angeles',
  promptNow,
  userIdentity: 'Alex, CEO',
  directives: 'Push for precision over reassurance.',
})

const chiefConfig = { ...CHIEF_OF_STAFF_TEMPLATE, provider: mockProvider }

const chiefChat = buildChatLLMRequest(chiefConfig, {
  message: 'I am overloaded. Do not make me a bigger system. Given what is already on my plate, what actually matters this week?',
  history: [],
  context: {
    openTasks: [
      { id: 'task-1', title: 'Draft investor update', owner: 'Alex', due: '2026-04-17', priority: 'high', status: 'open', definitionOfDone: 'A sendable draft exists with topline metrics up front.' },
      { id: 'task-2', title: 'Prep board metrics review', owner: 'Maya', due: '2026-04-16', priority: 'medium', status: 'open', notes: 'Need one clean page on burn and pipeline.' },
    ],
    constraints: [
      'Deep work blocks are protected from 09:00-11:00.',
      'Avoid Friday afternoon follow-ups if Thursday works.',
    ],
    profile: { name: 'Alex', role: 'CEO' },
  },
  memories: [
    { id: 'm1', content: 'Prefers blunt drafts over diplomatic softening.', category: 'working_style', pinned: true },
  ],
  timezone: 'America/Los_Angeles',
  promptNow,
  userIdentity: 'Alex',
})

const chiefOperational = buildPromptedTurnLLMRequest(chiefConfig, {
  intent: 'Read the operating state, decide the next clean move, and change shared state only through declared entities.',
  label: 'daily operating turn',
  turnKind: 'operational',
  promptMode: 'operational',
  guidelines: 'Prefer the smallest real move that reduces load or sharpens ownership.',
  context: {
    openTasks: [
      { id: 'task-1', title: 'Draft investor update', owner: 'Alex', due: '2026-04-17', priority: 'high', status: 'open', definitionOfDone: 'A sendable draft exists with topline metrics up front.' },
      { id: 'task-2', title: 'Prep board metrics review', owner: 'Maya', due: '2026-04-16', priority: 'medium', status: 'open', notes: 'Need one clean page on burn and pipeline.' },
    ],
    constraints: [
      'Deep work blocks are protected from 09:00-11:00.',
      'Avoid Friday afternoon follow-ups if Thursday works.',
    ],
    profile: { name: 'Alex', role: 'CEO' },
  },
  memories: [
    { id: 'm1', content: 'Prefers blunt drafts over diplomatic softening.', category: 'working_style', pinned: true },
  ],
  timezone: 'America/Los_Angeles',
  promptNow,
  userIdentity: 'Alex',
})

writeFileSync(join(fixtureDir, 'coach-chat.txt'), render('coach-chat', coachChat.request))
writeFileSync(join(fixtureDir, 'coach-proactive.txt'), render('coach-proactive', coachProactive.request))
writeFileSync(join(fixtureDir, 'chief-chat.txt'), render('chief-chat', chiefChat.request))
writeFileSync(join(fixtureDir, 'chief-operational.txt'), render('chief-operational', chiefOperational.request))

console.log(`Updated reference fixtures in ${fixtureDir}`)
