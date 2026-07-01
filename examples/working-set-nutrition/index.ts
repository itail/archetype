// This example demonstrates the working-set staging pattern with named actions.
// For the primary entity CRUD pattern (recommended for most apps), see the other examples.

import { definePersona, Gemini, commitWorkingSet, type WorkingSet } from '../../src/index.js'
import { z } from 'zod'

/**
 * Minimal conversational working-set example.
 *
 * Meaning-layer meal draft:
 * - accepted by default
 * - supersedes prior meal drafts through a singleton targetKey
 *
 * Transport-layer meal log:
 * - explicit commit
 */

const nutritionist = definePersona({
  identity: {
    name: 'Nutrition Guide',
    expertise: ['nutrition', 'meal planning', 'behavior change'],
    relationship: 'nutrition guide',
    northStar: 'shape realistic meals the user will actually eat and keep the conversational draft separate from the final meal log',
  },
  voice: {
    tone: 'warm',
    style: 'quick',
    medium: 'mobile-chat',
  },
  directives: {
    default:
      'Work from the live situation. Help the user shape one realistic meal draft at a time. Infer from the conversation whether the user is planning a meal or describing one they already ate. You may stage logging when the scene makes that clear, but do not narrate the meal as already logged before commit.',
  },
  staging: {
    model: 'working-set',
  },
  actions: {
    setMealDraft: {
      description: 'Accept the current best meal draft for this conversation.',
      schema: z.object({
        mealName: z.string().min(1),
        items: z.array(z.string().min(1)).min(1),
        rationale: z.string().min(1),
      }),
      layer: 'meaning',
      defaultReviewState: 'accepted',
      commitMode: 'not_required',
      targetKey: () => 'meal-draft',
    },
    logMeal: {
      description: 'Stage logging a meal when the conversation makes it reasonably clear the user already ate it.',
      schema: z.object({
        mealName: z.string().min(1),
        items: z.array(z.string().min(1)).min(1),
      }),
      layer: 'transport',
      defaultReviewState: 'accepted',
      commitMode: 'explicit',
      targetKey: () => 'meal-log',
    },
  },
  provider: Gemini({
    model: 'gemini-3.5-flash',
    apiKey: process.env.GEMINI_API_KEY,
  }),
})

async function demo() {
  let workingSet: WorkingSet | null = null

  const first = await nutritionist.chat({
    message: 'Plan a light lunch. I want something high-protein and Mediterranean, around 550 calories.',
    context: {
      profile: 'Prefers Mediterranean flavors and easy week-day meals.',
      note: 'This turn should shape the meal draft, not log anything yet.',
    },
    workingSet,
  })

  workingSet = first.workingSet ?? null
  console.log('TURN 1')
  console.log(first.message)
  console.log(first.workingSetSummary)

  const second = await nutritionist.chat({
    message: 'Swap the chicken for salmon and keep it a little lower carb.',
    context: {
      profile: 'Prefers Mediterranean flavors and easy week-day meals.',
      note: 'Revise the same meal draft rather than creating a second one.',
    },
    workingSet,
  })

  workingSet = second.workingSet ?? workingSet
  console.log('\nTURN 2')
  console.log(second.message)
  console.log(second.workingSetSummary)

  const third = await nutritionist.chat({
    message: 'Perfect. I had exactly that for lunch, so log it.',
    context: {
      profile: 'Prefers Mediterranean flavors and easy week-day meals.',
      note: 'Use the scene to judge whether this is still planning or a real eaten meal that should now be logged.',
    },
    workingSet,
  })

  workingSet = third.workingSet ?? workingSet
  console.log('\nTURN 3')
  console.log(third.message)
  console.log(third.workingSetSummary)

  if (!workingSet) return

  const committed = await commitWorkingSet(workingSet, {
    logMeal: async () => ({ success: true }),
  })

  console.log('\nCOMMIT')
  console.log(committed.summary)
}

void demo()
