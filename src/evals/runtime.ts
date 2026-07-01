import { PersonaEngine } from '../persona.js'
import type { LLMProvider, Memory, CrudAction } from '../types.js'
import { resolveActions, resolveEntities } from '../core/effective-config.js'
import {
  executeSideEffects,
  getExecutedAnnotations,
  getProposedActions,
} from '../engine/side-effects.js'
import { buildAssistantContinuityMessage } from '../engine/continuity.js'
import { crudActionToAnnotation, resolveTempIds } from '../engine/crud.js'
import type {
  EvalActionRecord,
  EvalConversationResult,
  EvalProject,
  EvalState,
  EvalTurn,
  EvalTurnResult,
} from './types.js'

export async function runEvalConversation<State extends EvalState>(
  project: EvalProject<State>,
  provider: LLMProvider,
  turns: EvalTurn[],
): Promise<EvalConversationResult<State>> {
  const engine = new PersonaEngine({ ...project.persona, provider })
  const state = project.initialState()
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const results: EvalTurnResult<State>[] = []
  let memoryCounter = 1

  for (const turn of turns) {
    const stateBefore = project.summarizeState(state)
    const chatResult = await engine.chat({
      message: turn.userMessage,
      history,
      context: project.buildContext(state),
      memories: state.memories,
      timezone: project.timezone,
      directives: turn.directives,
      extraSystemSections: turn.extraSystemSections,
      userIdentity: project.userIdentity,
    })

    const actionDefs = resolveActions(engine.config) ?? {}
    const handlers = project.buildHandlers(state)

    const sideEffectResults = chatResult.actions.length > 0
      ? await executeSideEffects(chatResult.actions, handlers, actionDefs, {
          approval: engine.config.approval,
        })
      : []

    // Execute CRUD actions through entity-specific handlers (including memory entities)
    if (chatResult.crudActions && chatResult.crudActions.length > 0) {
      // Resolve temp IDs (_w1 → UUID) so handlers see real IDs with cross-references resolved
      const resolvedCrud = resolveTempIds(chatResult.crudActions)
      const appCrudHandlers = project.buildCrudHandlers ? project.buildCrudHandlers(state) : {}
      const memoryCrudHandlers = buildMemoryCrudHandlers(state, () => `mem-auto-${memoryCounter++}`)
      const allCrudHandlers = { ...memoryCrudHandlers, ...appCrudHandlers }
      for (const crudAction of resolvedCrud) {
        const handler = allCrudHandlers[crudAction.entity]
        if (handler) {
          await handler(crudAction)
        }
      }
    }

    const proposedActions = getProposedActions(sideEffectResults)
    const actionRecords: EvalActionRecord[] = sideEffectResults.map(result => ({
      action: result.action,
      annotation: result.annotation,
      proposed: result.status === 'proposed',
      success: result.success,
      error: result.error,
    }))

    history.push({ role: 'user', content: turn.userMessage })

    // Store assistant continuity through the same invariant used by managed
    // chat and autonomous loops: narrative + outcome notes are model-visible;
    // raw action annotations are debug/display-only and stripped before future
    // turns.
    const actionAnnotations = getExecutedAnnotations(sideEffectResults)
    const actionOutcomes = sideEffectResults.map(result => ({
      action: result.action,
      status: result.status,
      success: result.success,
      error: result.error,
      annotation: result.annotation,
    }))
    // Append CRUD action annotations (use effective entities to include memory entities)
    const crudAnnotations: string[] = []
    if (chatResult.crudActions && chatResult.crudActions.length > 0) {
      const effectiveEntities = resolveEntities(engine.config) ?? engine.config.entities ?? {}
      crudAnnotations.push(...chatResult.crudActions.map(a => crudActionToAnnotation(a, effectiveEntities)))
    }
    const storedAssistantMessage = buildAssistantContinuityMessage({
      message: chatResult.message,
      modelOutcomeNotes: chatResult.outcomeNotes,
      actionOutcomes: [
        ...actionOutcomes,
        ...crudAnnotations.map(annotation => ({ outcomeNote: `${annotation} executed.` })),
      ],
      actionAnnotations: [...actionAnnotations, ...crudAnnotations],
    })
    history.push({ role: 'assistant', content: storedAssistantMessage })

    results.push({
      userMessage: turn.userMessage,
      assistantMessage: chatResult.message,
      storedAssistantMessage,
      raw: chatResult.raw,
      actions: chatResult.actions,
      actionRecords,
      proposedActions,
      followUps: chatResult.followUps ?? [],
      outcomeNotes: chatResult.outcomeNotes,
      stateBefore,
      stateAfter: project.summarizeState(state),
      stateSnapshot: cloneState(state),
      sideEffectResults,
      trace: chatResult.trace,
    })
  }

  return {
    project,
    provider,
    turns: results,
    finalState: state,
    history,
  }
}

/**
 * CRUD handlers for memory and craftMemory entities in evals.
 */
function buildMemoryCrudHandlers<State extends EvalState>(
  state: State,
  nextId: () => string,
): Record<string, (action: CrudAction) => Promise<void>> {
  return {
    memory: async (action: CrudAction) => {
      const params = action.params ?? {}
      if (action.operation === 'create') {
        state.memories.push({
          id: nextId(),
          content: String(params.content),
          category: String(params.category),
          source: params.source === 'user' || params.source === 'inferred' || params.source === 'suggested'
            ? params.source
            : undefined,
          stability: params.stability === 'durable' || params.stability === 'tentative' || params.stability === 'temporary'
            ? params.stability
            : undefined,
          contextHint: typeof params.contextHint === 'string' ? params.contextHint : undefined,
          pinned: false,
          createdAt: new Date().toISOString(),
        })
      } else if (action.operation === 'update' && action.id) {
        const memory = state.memories.find(item => item.id === action.id)
        if (!memory) return
        if (params.content != null) memory.content = String(params.content)
        if (params.category != null) memory.category = String(params.category)
        if (params.source === 'user' || params.source === 'inferred' || params.source === 'suggested') memory.source = params.source
        if (params.stability === 'durable' || params.stability === 'tentative' || params.stability === 'temporary') memory.stability = params.stability
        if (typeof params.contextHint === 'string') memory.contextHint = params.contextHint
      } else if (action.operation === 'delete' && action.id) {
        const index = state.memories.findIndex(item => item.id === action.id)
        if (index !== -1) state.memories.splice(index, 1)
      }
    },
    craftMemory: async (action: CrudAction) => {
      // Craft memories also live in state.memories with scope: 'craft'
      const params = action.params ?? {}
      if (action.operation === 'create') {
        state.memories.push({
          id: nextId(),
          content: String(params.content),
          category: String(params.category),
          scope: 'craft',
          source: params.source === 'user' || params.source === 'inferred' || params.source === 'suggested'
            ? params.source
            : undefined,
          stability: params.stability === 'durable' || params.stability === 'tentative' || params.stability === 'temporary'
            ? params.stability
            : undefined,
          contextHint: typeof params.contextHint === 'string' ? params.contextHint : undefined,
          pinned: false,
          createdAt: new Date().toISOString(),
        })
      } else if (action.operation === 'update' && action.id) {
        const memory = state.memories.find(item => item.id === action.id)
        if (!memory) return
        if (params.content != null) memory.content = String(params.content)
        if (params.category != null) memory.category = String(params.category)
        if (params.source === 'user' || params.source === 'inferred' || params.source === 'suggested') memory.source = params.source
        if (params.stability === 'durable' || params.stability === 'tentative' || params.stability === 'temporary') memory.stability = params.stability
        if (typeof params.contextHint === 'string') memory.contextHint = params.contextHint
      } else if (action.operation === 'delete' && action.id) {
        const index = state.memories.findIndex(item => item.id === action.id)
        if (index !== -1) state.memories.splice(index, 1)
      }
    },
  }
}

function cloneState<State>(state: State): State {
  return JSON.parse(JSON.stringify(state)) as State
}
