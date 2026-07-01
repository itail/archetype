// This example demonstrates the working-set staging pattern with named actions.
// For the primary entity CRUD pattern (recommended for most apps), see the other examples.

import { definePersona, Gemini, commitWorkingSet, reviewWorkingSetDelta, type WorkingSet } from '../../src/index.js'
import { z } from 'zod'

/**
 * Minimal transport-backed example.
 *
 * Meaning-layer draft:
 * - accepted by default
 *
 * Transport-layer archive:
 * - explicit review, then explicit commit
 */

const assistant = definePersona({
  identity: {
    name: 'Inbox Assistant',
    expertise: ['communication triage'],
    relationship: 'personal communications assistant',
    northStar: 'turn noisy incoming communication into a few clear situations',
  },
  voice: {
    tone: 'balanced',
    style: 'quick',
    medium: 'mobile-chat',
  },
  directives: {
    default:
      'Bring the user only the few things that matter. Reason from the live communication situation. Keep the current draft and Gmail reality distinct without turning that boundary into procedural language.',
  },
  staging: {
    model: 'working-set',
  },
  actions: {
    setReplyDraft: {
      description: 'Accept the current best reply draft for this thread.',
      schema: z.object({
        threadId: z.string(),
        draft: z.string().min(1),
      }),
      layer: 'meaning',
      defaultReviewState: 'accepted',
      commitMode: 'not_required',
      targetKey: (params) => `thread:${String(params.threadId)}:reply-draft`,
    },
    archiveThread: {
      description: 'Stage archiving this Gmail thread when that is the right next move for the situation.',
      schema: z.object({
        threadId: z.string(),
      }),
      layer: 'transport',
      defaultReviewState: 'pending',
      commitMode: 'explicit',
      targetKey: (params) => `thread:${String(params.threadId)}:archive`,
    },
  },
  provider: Gemini({
    model: 'gemini-3.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
  }),
})

async function demo() {
  let workingSet: WorkingSet | null = null

  const first = await assistant.chat({
    message: 'Draft a warm RSVP yes, but do not archive anything yet.',
    context: {
      situation: 'Wedding invite from Maya for next month. RSVP requested by Friday.',
      availableActions: '- archiveThread only after explicit approval',
    },
    workingSet,
  })

  workingSet = first.workingSet ?? null
  console.log('TURN 1')
  console.log(first.message)
  console.log(first.workingSetSummary)

  const second = await assistant.chat({
    message: 'Looks good. Archive it after the draft is created.',
    context: {
      situation: 'Same wedding invite thread.',
      availableActions: '- archiveThread only after explicit approval',
    },
    workingSet,
  })

  workingSet = second.workingSet ?? workingSet
  console.log('\nTURN 2')
  console.log(second.message)
  console.log(second.workingSetSummary)

  if (!workingSet) return

  const archiveDelta = workingSet.deltas.find((delta) => delta.action.name === 'archiveThread')
  if (!archiveDelta) return

  workingSet = reviewWorkingSetDelta(workingSet, {
    deltaId: archiveDelta.id,
    decision: 'accept',
  })

  console.log('\nREVIEW')
  console.log('Accepted staged archive action.')
  console.log(workingSet.deltas.find((delta) => delta.id === archiveDelta.id)?.commitState)

  const committed = await commitWorkingSet(workingSet, {
    archiveThread: async () => ({ success: true }),
  })

  console.log('\nCOMMIT')
  console.log(committed.summary)
}

void demo()
