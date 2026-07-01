import type { ChatInput, PromptedTurnInput } from '../types.js'
import { resolvePromptedTurnMode } from './prompt-mode.js'

export function buildPromptedTurnFrame(input: Pick<PromptedTurnInput, 'intent' | 'label'>): string {
  return [
    input.label ? `${input.label.toUpperCase()}:` : null,
    input.intent ? `Intent: ${input.intent}` : null,
  ].filter(Boolean).join('\n')
}

export function buildPromptedTurnTransportMessage(): string {
  return 'Use the turn instructions and structured context as the live input. ' +
    'Return the raw JSON object described in the system prompt.'
}

export function buildPromptedTurnTailSections(
  input: Pick<PromptedTurnInput, 'intent' | 'label' | 'guidelines' | 'extraSystemSections' | 'tailSystemSections'>,
): string[] {
  return [
    buildPromptedTurnFrame(input) || null,
    ...(input.guidelines ? [input.guidelines] : []),
    ...(input.extraSystemSections ?? []),
    ...(input.tailSystemSections ?? []),
  ].filter((value): value is string => Boolean(value))
}

export function toPromptedTurnChatInput(input: PromptedTurnInput): ChatInput {
  const promptNow = input.promptNow
    ? input.promptNow instanceof Date
      ? input.promptNow
      : new Date(input.promptNow)
    : new Date()

  return {
    message: buildPromptedTurnTransportMessage(),
    promptMode: resolvePromptedTurnMode(input.promptMode, input.turnKind),
    history: input.history,
    memories: input.memories,
    knowledgeDocuments: input.knowledgeDocuments,
    craftMemories: input.craftMemories,
    context: input.context,
    timezone: input.timezone,
    promptNow,
    userIdentity: input.userIdentity,
    locale: input.locale,
    directives: input.directives,
    promptOrigin: 'app',
    promptScaffold: input.promptScaffold,
    contractStyle: input.contractStyle,
    extraSystemSections: undefined,
    tailSystemSections: buildPromptedTurnTailSections(input),
    workingSet: input.workingSet,
    lastMessageAt: promptNow,
  }
}
