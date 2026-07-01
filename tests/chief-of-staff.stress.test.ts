import { describe, expect, it } from 'vitest'
import { runEvalConversation } from '../src/evals/runtime.js'
import { chiefOfStaffProject, type ChiefOfStaffEvalState } from '../src/evals/sample-projects.js'
import type { EvalProject } from '../src/evals/types.js'
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from '../src/types.js'

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

function withChiefMemory(memory: ChiefOfStaffEvalState['memories'][number]): EvalProject<ChiefOfStaffEvalState> {
  return {
    ...chiefOfStaffProject,
    initialState() {
      const base = chiefOfStaffProject.initialState()
      return {
        ...base,
        memories: [memory],
      }
    },
  }
}

describe('chief-of-staff stress tests', () => {
  it('keeps one task alive through repeated corrections instead of stacking duplicates', async () => {
    const { provider } = createScriptedProvider([
      {
        message: 'Captured.',
        actions: [
          { name: 'crud', params: { operation: 'create', entity: 'task', id: 'task-2', params: '{"title":"Send investor update","due":"2026-03-20","priority":"high"}' } },
        ],
      },
      {
        message: 'Updated the same task.',
        actions: [
          { name: 'crud', params: { operation: 'update', entity: 'task', id: 'task-2', params: '{"due":"2026-03-19","notes":"Lead with the topline numbers."}' } },
        ],
      },
      {
        message: 'Tightened it again without creating another task.',
        actions: [
          { name: 'crud', params: { operation: 'update', entity: 'task', id: 'task-2', params: '{"notes":"Lead with topline numbers and keep the opening warm."}' } },
        ],
      },
    ])

    const result = await runEvalConversation(chiefOfStaffProject, provider, [
      { userMessage: 'Remind me to send the investor update Friday.' },
      { userMessage: 'Actually Thursday morning, and lead with the topline numbers.' },
      { userMessage: 'One more tweak: keep the opening warm.' },
    ])

    const finalState = result.finalState as ChiefOfStaffEvalState
    const investorTasks = finalState.openTasks.filter(item => item.title === 'Send investor update')

    expect(investorTasks).toHaveLength(1)
    expect(investorTasks[0].due).toBe('2026-03-19')
    expect(investorTasks[0].notes).toContain('opening warm')
  })

  it('updates a stale working-style memory instead of saving a duplicate', async () => {
    const project = withChiefMemory({
      id: 'mem-1',
      content: 'Prefers blunt drafts over diplomatic softening.',
      category: 'working_style',
    })
    const { provider, requests } = createScriptedProvider([
      {
        message: 'Updated that preference for investor updates.',
        actions: [
          { name: 'crud', params: { operation: 'update', entity: 'memory', id: 'mem-1', params: '{"content":"For investor updates, prefers a warmer opening before the blunt core.","category":"working_style"}' } },
        ],
      },
    ])

    const result = await runEvalConversation(project, provider, [
      { userMessage: 'For investor updates specifically, I want a warmer opening now. Do not save that as a second style preference.' },
    ])

    const finalState = result.finalState as ChiefOfStaffEvalState
    expect(finalState.memories).toHaveLength(1)
    expect(finalState.memories[0].id).toBe('mem-1')
    expect(finalState.memories[0].content).toContain('warmer opening')
    expect(result.turns[0].storedAssistantMessage).toContain('updated memory')
    expect(requests[0].systemPrompt).toContain('(id:mem-1)')
  })

  it('deletes a stale working-style memory when the user says it no longer applies', async () => {
    const project = withChiefMemory({
      id: 'mem-1',
      content: 'Prefers blunt drafts over diplomatic softening.',
      category: 'working_style',
    })
    const { provider } = createScriptedProvider([
      {
        message: 'Removed it. I will not keep stale style guidance around.',
        actions: [
          { name: 'crud', params: { operation: 'delete', entity: 'memory', id: 'mem-1' } },
        ],
      },
    ])

    const result = await runEvalConversation(project, provider, [
      { userMessage: 'That blunt-drafts preference no longer applies. Delete it.' },
    ])

    const finalState = result.finalState as ChiefOfStaffEvalState
    expect(finalState.memories).toHaveLength(0)
    expect(result.turns[0].storedAssistantMessage).toContain('deleted memory')
  })
})
