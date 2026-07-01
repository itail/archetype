import type { PromptMode, PromptedTurnKind } from '../types.js'

export function resolvePromptedTurnMode(
  promptMode?: PromptMode,
  turnKind?: PromptedTurnKind,
): PromptMode {
  if (promptMode) return promptMode
  return turnKind === 'proactive-conversation' ? 'conversation' : 'operational'
}
