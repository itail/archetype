import { z } from 'zod'
import type { ActionDefinition, ParsedAction } from '../types.js'

export const ENTER_FOCUS_MODE_ACTION_NAME = 'enterFocusMode'
export const UPDATE_FOCUS_WORK_ITEM_ACTION_NAME = 'updateFocusWorkItem'
export const RETURN_TO_SESSION_ACTION_NAME = 'returnToSession'

export const enterFocusModeAction: ActionDefinition = {
  description:
    'Enter focus mode for this persona\'s ongoing work. When entering focus mode, you have an opportunity to write a work item for your future self. This is your future operating context: it follows future focus prompts as your own expert anchor, layered on top of source truth, visible conversation, durable files, and tool outcomes. It can describe the expert judgment lens to hold, the work or product spine, what excellent success feels like, and the manageable parts you expect your future self to reason through. It is private operating context for this persona, not a handoff that replaces another expert\'s ownership of method, sequencing, tools, or implementation approach. The focused work context begins on the next turn.',
  confidence: 'low',
  schema: z.object({
    workItem: z.string().min(1).optional(),
  }),
}

export const updateFocusWorkItemAction: ActionDefinition = {
  description:
    'Update the focus work item for this persona\'s future self. The work item is editable private operating context: replace it when your expert judgment lens, work spine, success picture, or reasoning decomposition has changed. The runtime carries the updated work item into future focus prompts; this is not a quality check, approval step, or substitute source of truth.',
  confidence: 'low',
  schema: z.object({
    workItem: z.string().min(1),
  }),
}

export const returnToSessionAction: ActionDefinition = {
  description:
    'Return from private focus work to the visible session flow. Use this when the persona is ready to make its handoff, result, question, or blocked state visible to the session. This is a routing/visibility action, not a quality check: it does not approve or reject the work.',
  confidence: 'low',
  schema: z.object({
    message: z.string().min(1),
    to: z.string().min(1).optional(),
    state: z.enum(['ready', 'blocked', 'failed']).optional(),
  }),
}

export const FOCUS_MODE_ACTIONS: Record<
  typeof ENTER_FOCUS_MODE_ACTION_NAME | typeof UPDATE_FOCUS_WORK_ITEM_ACTION_NAME | typeof RETURN_TO_SESSION_ACTION_NAME,
  ActionDefinition
> = {
  [ENTER_FOCUS_MODE_ACTION_NAME]: enterFocusModeAction,
  [UPDATE_FOCUS_WORK_ITEM_ACTION_NAME]: updateFocusWorkItemAction,
  [RETURN_TO_SESSION_ACTION_NAME]: returnToSessionAction,
}

export function buildFocusActionSets<const TActions extends Record<string, ActionDefinition>>(
  actions: TActions,
): {
  conversation: TActions & { enterFocusMode: ActionDefinition }
  focus: TActions & { returnToSession: ActionDefinition }
} {
  return {
    conversation: {
      enterFocusMode: enterFocusModeAction,
      ...actions,
    },
    focus: {
      ...actions,
      updateFocusWorkItem: updateFocusWorkItemAction,
      returnToSession: returnToSessionAction,
    },
  }
}

export function isEnterFocusModeAction(action: Pick<ParsedAction, 'name'>): boolean {
  return action.name === ENTER_FOCUS_MODE_ACTION_NAME
}

export function isUpdateFocusWorkItemAction(action: Pick<ParsedAction, 'name'>): boolean {
  return action.name === UPDATE_FOCUS_WORK_ITEM_ACTION_NAME
}

export function isReturnToSessionAction(action: Pick<ParsedAction, 'name'>): boolean {
  return action.name === RETURN_TO_SESSION_ACTION_NAME
}

export function enterFocusModeOutcomeNote(action: Pick<ParsedAction, 'params'>): string {
  const workItem = typeof action.params.workItem === 'string' ? action.params.workItem.trim() : ''
  if (workItem) return 'focus mode entered with a persona-authored work item.'
  return 'focus mode entered.'
}

export function updateFocusWorkItemOutcomeNote(action: Pick<ParsedAction, 'params'>): string {
  void action
  return 'focus work item updated.'
}

export function returnToSessionOutcomeNote(action: Pick<ParsedAction, 'params'>): string {
  const message = typeof action.params.message === 'string' ? action.params.message.trim() : ''
  const to = typeof action.params.to === 'string' && action.params.to.trim()
    ? ` to ${action.params.to.trim()}`
    : ''
  return message
    ? `returnToSession posted visible message${to}: ${message}`
    : `returnToSession posted visible message${to}.`
}
