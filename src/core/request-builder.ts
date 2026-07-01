import type { ChatInput, LLMProviderRequest, PersonaConfig, PromptMode, PromptOrigin, PromptedTurnInput } from '../types.js'
import { stripActionAnnotations } from './actions.js'
import { buildSystemPrompt } from './prompt-builder.js'
import { buildGeminiResponseSchema } from '../providers/gemini.js'
import { resolveEffectiveConfig } from './effective-config.js'
import { toPromptedTurnChatInput } from './prompted-turn.js'
import { resolvePersonaConfigBrain } from '../brain.js'
import { renderTurnLedgerForModel } from '../engine/continuity.js'

export interface BuiltLLMRequest extends LLMProviderRequest {
  promptMode: PromptMode
  promptOrigin: PromptOrigin
}

export interface PreparedChatRequest {
  effectiveConfig: PersonaConfig
  request: BuiltLLMRequest
}

export function buildChatLLMRequest(
  config: PersonaConfig,
  input: ChatInput,
): PreparedChatRequest {
  const resolvedConfig = resolvePersonaConfigBrain(config)
  const effectiveConfig = resolveEffectiveConfig(resolvedConfig)
  const systemPrompt = buildSystemPrompt({ config: effectiveConfig, input })
  const turnLedgerActorId = input.turnLedgerActorId ?? input.personaId
  const focusWithPrivateWorkHistory = (input.promptMode ?? 'conversation') === 'focus' && hasPrivateWorkHistory(input)
  const modelTurnLedger = focusWithPrivateWorkHistory
    ? turnLedgerActorId
      ? input.turnLedger?.filter(entry => entry.actorId === turnLedgerActorId)
      : []
    : input.turnLedger
  const history = modelTurnLedger
      ? stripActionAnnotations(renderTurnLedgerForModel(modelTurnLedger, {
          perspectiveActorId: turnLedgerActorId,
          participants: input.session?.participants,
          historyTransport: effectiveConfig.provider.historyTransport,
          omitActionOutcomesForActorId: hasPrivateWorkHistory(input) ? turnLedgerActorId : undefined,
          currentTurn: input.turnLedgerCurrentTurn,
        }))
      : stripActionAnnotations(input.history ?? [])
  const responseSchema = buildGeminiResponseSchema(
    effectiveConfig.actions,
    {
      followUpsDescription: resolvedConfig.followUpsDescription,
      entities: effectiveConfig.entities,
      promptMode: input.promptMode ?? 'conversation',
    },
  )

  return {
    effectiveConfig,
    request: {
      systemPrompt,
      history,
      message: input.message,
      responseSchema,
      attachments: input.attachments,
      promptMode: input.promptMode ?? 'conversation',
      promptOrigin: input.promptOrigin ?? 'user',
    },
  }
}

function hasPrivateWorkHistory(input: ChatInput): boolean {
  if (!input.context || !Object.hasOwn(input.context, 'workHistory')) return false
  const value = input.context.workHistory
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return Boolean(value)
}

export function buildPromptedTurnLLMRequest(
  config: PersonaConfig,
  input: PromptedTurnInput,
): PreparedChatRequest & { chatInput: ChatInput } {
  const chatInput = toPromptedTurnChatInput(input)
  const prepared = buildChatLLMRequest(config, chatInput)
  return {
    ...prepared,
    chatInput,
  }
}
