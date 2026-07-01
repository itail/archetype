import type { Memory, PersonaConfig, ParsedAction, CrudAction, LLMProvider, TurnTrace } from '../types.js'
import type { SideEffectHandler, ProposedAction, SideEffectResult } from '../engine/side-effects.js'

export type CrudHandler = (action: CrudAction) => Promise<void>

export interface EvalState {
  memories: Memory[]
}

export interface EvalProject<State extends EvalState = EvalState> {
  id: string
  name: string
  description: string
  failureSurface: string
  userIdentity: string
  timezone: string
  persona: Omit<PersonaConfig, 'provider'>
  initialState(): State
  buildContext(state: State): Record<string, unknown>
  buildHandlers(state: State): Record<string, SideEffectHandler>
  /** Handlers for CRUD actions on declared entities */
  buildCrudHandlers?(state: State): Record<string, CrudHandler>
  summarizeState(state: State): string
}

export interface EvalTurn {
  userMessage: string
  directives?: string | null
  extraSystemSections?: string[]
}

export interface EvalActionRecord {
  action: ParsedAction
  annotation?: string
  proposed: boolean
  success: boolean
  error?: string
}

export interface EvalTurnResult<State extends EvalState = EvalState> {
  userMessage: string
  assistantMessage: string
  storedAssistantMessage: string
  raw?: string
  actions: ParsedAction[]
  actionRecords: EvalActionRecord[]
  proposedActions: ProposedAction[]
  followUps: string[]
  outcomeNotes?: string[]
  stateBefore: string
  stateAfter: string
  stateSnapshot: State
  sideEffectResults: SideEffectResult[]
  /** Pipeline trace — what the AI intended, what was validated, what was dropped */
  trace: TurnTrace
}

export interface EvalConversationResult<State extends EvalState = EvalState> {
  project: EvalProject<State>
  provider: LLMProvider
  turns: EvalTurnResult<State>[]
  finalState: State
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface EvalJudgeScenario {
  name: string
  description: string
  tests: string[]
  expectedBehavior?: string[]
}

export interface EvalJudgeCriterionScore {
  criterion: string
  score: number
  reasoning: string
}

export interface EvalJudgeVerdict {
  scores: EvalJudgeCriterionScore[]
  average: number
  hasZero: boolean
  pass: boolean
  promptFixes: string[]
  sdkGaps: string[]
  conceptGaps: string[]
}

export interface EvalPairwiseVerdict {
  winner: 'a' | 'b' | 'tie'
  reasoning: string
  promptFixes: string[]
  sdkGaps: string[]
  conceptGaps: string[]
}
