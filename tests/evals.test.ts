import { describe, expect, it } from 'vitest'
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from '../src/types.js'
import { runEvalConversation } from '../src/evals/runtime.js'
import {
  chiefOfStaffProject,
  coachProject,
  fitnessProject,
  languageTutorProject,
  nutritionProject,
  type ChiefOfStaffEvalState,
  type CoachEvalState,
  type FitnessEvalState,
  type LanguageTutorEvalState,
  type NutritionEvalState,
} from '../src/evals/sample-projects.js'

function createScriptedProvider(responses: unknown[]): {
  provider: LLMProvider
  requests: LLMProviderRequest[]
} {
  const requests: LLMProviderRequest[] = []

  return {
    requests,
    provider: {
      name: 'scripted',
      async chat(request: LLMProviderRequest): Promise<LLMProviderResponse> {
        requests.push(request)
        const next = responses.shift()
        if (next == null) {
          throw new Error('No scripted response left for provider')
        }
        return { text: typeof next === 'string' ? next : JSON.stringify(next) }
      },
    },
  }
}

describe('eval runtime', () => {
  it('handles executive coaching with persisted learnings and confirm-first proposals', async () => {
    const { provider, requests } = createScriptedProvider([
      {
        message: "You're not in a tactics problem yet. You're in a pattern-recognition problem.",
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content":"Sarah delays commitment when the decision is still ambiguous.","category":"cross_pattern"}' } },
        ],
      },
      {
        message: 'The recurring issue is not roadmap quality. It is decision avoidance. Name that and force a narrower commitment.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'coachingNote', id: '_n1', params: '{"type":"growth_edge","text":"Sarah uses more-data requests to delay commitment under ambiguity."}' } },
          { name: 'crud', params: { operation: 'update', entity: 'thread', id: 'thread-1', params: '{"status":"at_risk"}' } },
          { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content":"Sarah delays commitment when the decision is ambiguous.","category":"cross_pattern"}' } },
        ],
      },
    ])

    const result = await runEvalConversation(coachProject, provider, [
      { userMessage: 'I just had another frustrating 1:1 with Sarah.' },
      { userMessage: 'What is the real issue here?' },
    ])

    const finalState = result.finalState as CoachEvalState
    expect(finalState.coachingNotes).toHaveLength(1)
    expect(finalState.coachingNotes[0].text).toContain('delay commitment')
    expect(finalState.memories).toHaveLength(3)
    // CRUD actions execute immediately (no confidence gating)
    expect(finalState.threads.find(item => item.id === 'thread-1')?.status).toBe('at_risk')

    // updateThread is now a crudAction, not a proposed action
    expect(result.turns[1].storedAssistantMessage).toContain('---actions:')
    expect(result.turns[1].storedAssistantMessage).toContain('created coaching note')
    expect(result.turns[1].storedAssistantMessage).toContain('updated thread')
    expect(result.turns[1].storedAssistantMessage).toContain('created memory')

    expect(requests[1].systemPrompt).toContain('OPEN THREADS')
    expect(requests[1].systemPrompt).toContain('(id:thread-1)')
    expect(requests[1].systemPrompt).toContain('COACH MEMORY')
  })

  it('updates meals instead of duplicating them for nutrition guidance', async () => {
    const { provider, requests } = createScriptedProvider([
      {
        message: 'Nice start. That is an easy protein win.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'meal', id: 'meal-1', params: '{"name":"Greek yogurt bowl","calories":260,"protein":23}' } },
        ],
      },
      {
        message: 'Perfect. I updated it rather than creating a second breakfast.',
        actions: [
          { name: 'crud', params: { operation: 'update', entity: 'meal', id: 'meal-1', params: '{"name":"Greek yogurt bowl with banana","calories":320}' } },
        ],
      },
      {
        message: 'That tracks. Savory breakfasts are probably easier for you to repeat consistently.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content":"Savory breakfasts are easier to repeat than sweet ones.","category":"preference"}' } },
        ],
      },
    ])

    const result = await runEvalConversation(nutritionProject, provider, [
      { userMessage: 'I had a Greek yogurt bowl.' },
      { userMessage: 'Actually add a banana too.' },
      { userMessage: 'Honestly I stay more consistent when breakfast is savory.' },
    ])

    const finalState = result.finalState as NutritionEvalState
    expect(finalState.meals).toHaveLength(1)
    expect(finalState.meals[0].name).toBe('Greek yogurt bowl with banana')
    expect(finalState.meals[0].calories).toBe(320)
    expect(finalState.memories).toHaveLength(2)

    expect(result.turns[1].assistantMessage).not.toContain('---actions:')
    expect(result.turns[1].storedAssistantMessage).toContain('updated meal')
    expect(requests[1].systemPrompt).toContain('Meals logged today')
    expect(requests[1].systemPrompt).toContain('(id:meal-1)')
  })

  it('creates a structured workout while persisting durable training context', async () => {
    const { provider, requests } = createScriptedProvider([
      {
        message: 'Here is a shoulder-friendly push day that still gives you real work.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'workout', id: '_w1', params: '{"focus":"Push (shoulder-friendly)","warmup":"Band external rotations and scap push-ups","cooldown":"Doorway pec stretch"}' } },
          { name: 'crud', params: { operation: 'create', entity: 'exercise', id: '_e1', params: '{"workoutId":"_w1","name":"Incline dumbbell press","sets":4,"reps":"8","notes":"Neutral grip, stop short of pain."}' } },
          { name: 'crud', params: { operation: 'create', entity: 'exercise', id: '_e2', params: '{"workoutId":"_w1","name":"Landmine press","sets":3,"reps":"10","notes":"Smooth lockout, no shrugging."}' } },
        ],
      },
      {
        message: 'Noted. I am treating deep barbell pressing as an irritation pattern, not a fluke.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content":"Deep barbell pressing aggravates the left shoulder.","category":"injury_history"}' } },
        ],
      },
    ])

    const result = await runEvalConversation(fitnessProject, provider, [
      { userMessage: 'Give me a push workout that avoids aggravating my shoulder.' },
      { userMessage: 'Yeah, deep barbell pressing is what usually pisses it off.' },
    ])

    const finalState = result.finalState as FitnessEvalState
    expect(finalState.generatedWorkouts).toHaveLength(1)
    expect(finalState.generatedWorkouts[0].exercises).toHaveLength(2)
    expect(finalState.generatedWorkouts[0].exercises[0].name).toBe('Incline dumbbell press')
    expect(finalState.memories).toHaveLength(1)
    expect(requests[0].systemPrompt).toContain('INJURIES [CRITICAL]')
    expect(requests[0].systemPrompt).toContain('AVAILABLE EQUIPMENT [CRITICAL]')
  })

  it('supports language tutoring with practice assignment and mistake logging', async () => {
    const { provider, requests } = createScriptedProvider([
      {
        message: 'Absolutely. I will correct you fast and clean rather than waiting until the end.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content":"Wants immediate correction instead of end-of-message feedback.","category":"preference"}' } },
        ],
      },
      {
        message: 'The natural phrasing is "Quiero reservar una mesa para dos." Use this drill three times out loud.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'mistake', params: '{"pattern":"Using querer + noun where reservar is more natural for bookings","correction":"Use \\"reservar\\" for bookings","example":"Quiero reservar una mesa para dos."}' } },
          { name: 'crud', params: { operation: 'create', entity: 'practice', params: '{"title":"Restaurant booking reps","focus":"Natural reservation phrasing","prompt":"Say the sentence out loud 3 times, then vary time and party size.","durationMin":4}' } },
        ],
      },
    ])

    const result = await runEvalConversation(languageTutorProject, provider, [
      { userMessage: 'Correct me immediately. I hate delayed correction.' },
      { userMessage: 'How do I say "I want to book a table for two" in a natural way?' },
    ])

    const finalState = result.finalState as LanguageTutorEvalState
    expect(finalState.memories).toHaveLength(1)
    expect(finalState.recentMistakes).toHaveLength(1)
    expect(finalState.practiceQueue).toHaveLength(1)
    expect(requests[1].systemPrompt).toContain('CURRENT GOAL [CRITICAL]')
    expect(requests[1].systemPrompt).toContain('LEARNER MEMORY')
  })

  it('keeps a chief-of-staff task system clean through create, update, and delete', async () => {
    const { provider, requests } = createScriptedProvider([
      {
        message: 'Captured. I will keep it short and numbers-first.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'task', id: 'task-2', params: '{"title":"Send investor update","due":"2026-03-20","notes":"Keep it short and numbers-first.","priority":"high"}' } },
        ],
      },
      {
        message: 'Moved it to Thursday and noted the draft preference.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'memory', params: '{"content":"Prefers blunt drafts over diplomatic softening.","category":"working_style"}' } },
          { name: 'crud', params: { operation: 'update', entity: 'task', id: 'task-2', params: '{"due":"2026-03-19","notes":"Keep it short, blunt, and numbers-first."}' } },
        ],
      },
      {
        message: 'Done. I removed the stale task instead of leaving it around.',
        actions: [
          { name: 'crud', params: { operation: 'delete', entity: 'task', id: 'task-1' } },
        ],
      },
    ])

    const result = await runEvalConversation(chiefOfStaffProject, provider, [
      { userMessage: 'Remind me to send the investor update Friday. Keep it short and numbers-first.' },
      { userMessage: 'Actually move that to Thursday and make the tone blunter.' },
      { userMessage: 'Delete the older draft-investor-update task. It is stale.' },
    ])

    const finalState = result.finalState as ChiefOfStaffEvalState
    expect(finalState.openTasks).toHaveLength(1)
    expect(finalState.openTasks[0].id).toBe('task-2')
    expect(finalState.openTasks[0].due).toBe('2026-03-19')
    expect(finalState.openTasks[0].notes).toContain('blunt')
    expect(finalState.memories).toHaveLength(1)
    expect(requests[1].systemPrompt).toContain('(id:task-1)')
    expect(result.turns[2].storedAssistantMessage).toContain('deleted task')
    expect(result.turns[1].stateAfter).toContain('due=2026-03-19')
  })
})
