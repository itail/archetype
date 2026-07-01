import type { PersonaConfig, ChatInput, ChatResult, CrudAction, GreetingInput, PromptedTurnInput, RetrospectInput, RetrospectResult, ParsedAction } from './types.js'
import { chat, createTrace } from './engine/chat.js'
import { validateCrudActions } from './engine/crud.js'
import { shouldGreet } from './core/greeting.js'
import { buildRetrospectPrompt } from './core/prompt-builder.js'
import { MEMORY_ACTIONS, CRAFT_MEMORY_ACTIONS } from './core/memory-actions.js'
import { buildGeminiActionOnlySchema } from './providers/gemini.js'
import { stripActionAnnotations } from './core/actions.js'
import { auditPrompt } from './audit/prompt-audit.js'
import { auditConversation } from './audit/conversation-audit.js'
import type { AuditInput, AuditResult } from './audit/types.js'
import { resolvePromptedTurnMode } from './core/prompt-mode.js'
import { resolveEntities } from './core/effective-config.js'
import { toPromptedTurnChatInput } from './core/prompted-turn.js'
import { resolvePersonaConfigBrain } from './brain.js'

function filterRetrospectEntities(
  entities?: Record<string, import('./types.js').EntityConfig>,
): Record<string, import('./types.js').EntityConfig> | undefined {
  if (!entities) return undefined
  const filtered = Object.fromEntries(
    Object.entries(entities).filter(([name]) => name === 'memory' || name === 'craftMemory'),
  )
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

function collectLegacyCrudContractDrift(parsed: { crudActions?: CrudAction[] }, label: string): string[] {
  if (!parsed.crudActions?.length) return []
  return [`${label} used legacy top-level "crudActions" key; use actions[{ "name": "crud", ... }] instead.`]
}

function parseRetrospectResponse(text: string, config?: PersonaConfig): RetrospectResult {
  const trace = createTrace()
  try {
    const parsed = JSON.parse(text) as {
      actions?: Array<{ name: string; params: Record<string, unknown> }>
      crudActions?: CrudAction[]
      diagnostics?: string[]
    }
    trace.parseOk = true
    trace.errors.push(...collectLegacyCrudContractDrift(parsed, 'Retrospect response'))

    // Extract crud actions from the actions array
    const crudActionsFromActions: CrudAction[] = []
    const rawActions = parsed.actions ?? []

    // Also accept legacy top-level crudActions for backward compat
    if (parsed.crudActions?.length) {
      crudActionsFromActions.push(...parsed.crudActions)
    }

    // When memory is CRUD-native (memory entities present), the crud envelope
    // is the only honored memory-mutation path — matching the schema. Named
    // memory actions are NOT valid here; if the model emits one anyway it must
    // be flagged in the trace as unknown_action, never silently treated as
    // valid (which would disagree with the executor and hide the deviation).
    const effectiveEntities = config ? filterRetrospectEntities(resolveEntities(config)) : undefined
    const memoryIsCrudNative = Boolean(effectiveEntities && Object.keys(effectiveEntities).length > 0)

    // Legacy action-path: only honored for personas that opted out of CRUD-native memory.
    const actions: ParsedAction[] = []
    const allActions = memoryIsCrudNative
      ? {}
      : (config?.craftMemory?.enabled
          ? { ...MEMORY_ACTIONS, ...CRAFT_MEMORY_ACTIONS }
          : MEMORY_ACTIONS)

    for (const action of rawActions) {
      if (action.name === 'crud') {
        const p = action.params as Record<string, unknown>
        const innerParams = typeof p.params === 'string' ? p.params : (p.params ? JSON.stringify(p.params) : undefined)
        crudActionsFromActions.push({
          operation: p.operation as CrudAction['operation'],
          entity: p.entity as string,
          id: p.id as string | undefined,
          params: innerParams as unknown as Record<string, unknown> | undefined,
        })
        continue
      }
      if (!(action.name in allActions)) {
        trace.actions.push({ name: action.name, params: action.params ?? {}, status: 'unknown_action' })
        continue
      }
      const parseResult = allActions[action.name].schema.safeParse(action.params ?? {})
      if (!parseResult.success) {
        trace.actions.push({ name: action.name, params: action.params, status: 'invalid', error: parseResult.error.message })
        continue
      }
      actions.push({
        name: action.name,
        params: parseResult.data as Record<string, unknown>,
        confidence: allActions[action.name].confidence,
      })
      trace.actions.push({ name: action.name, params: parseResult.data as Record<string, unknown>, status: 'valid' })
    }

    // CRUD-path: validate against entity schemas
    let crudActions: CrudAction[] | undefined
    if (effectiveEntities && crudActionsFromActions.length > 0) {
      const crudValidation = validateCrudActions(crudActionsFromActions, effectiveEntities)
      for (const valid of crudValidation.valid) {
        trace.crudActions.push({ operation: valid.operation, entity: valid.entity, id: valid.id, params: valid.params ?? {}, status: 'valid' })
      }
      for (const inv of crudValidation.invalid) {
        trace.crudActions.push({ operation: inv.action.operation, entity: inv.action.entity, id: inv.action.id, params: inv.action.params ?? {}, status: 'invalid', error: inv.error })
      }
      if (crudValidation.invalid.length > 0) {
        console.warn(
          `[archetype:retrospect] ${crudValidation.invalid.length} CRUD action(s) failed validation:`,
          crudValidation.invalid.map(i => `${i.action.operation} ${i.action.entity}: ${i.error}`).join(' | '),
        )
      }
      if (crudValidation.valid.length > 0) {
        crudActions = crudValidation.valid
      }
    }

    const diagnostics = config?.diagnostics?.enabled && parsed.diagnostics?.length
      ? parsed.diagnostics.map(d => d.trim()).filter(Boolean)
      : undefined

    return { actions, crudActions, diagnostics, raw: text, trace }
  } catch {
    trace.parseOk = false
    trace.errors.push('Failed to parse retrospect response as JSON')
    return { actions: [], raw: text, trace }
  }
}

/**
 * Build the response schema for retrospective passes.
 * When memory entities are registered, includes a crud variant in the actions anyOf.
 * Legacy actions array is kept for backward compat.
 */
function buildRetrospectResponseSchema(
  config: PersonaConfig,
  effectiveEntities?: Record<string, import('./types.js').EntityConfig>,
): Record<string, unknown> {
  const memoryEntities = filterRetrospectEntities(effectiveEntities)

  // Memory is CRUD-native: when memory entities are present, the ONLY memory
  // mutation path the executor can honor is the `crud` action envelope. Offer
  // exactly that — never the legacy per-entity action names (saveMemory,
  // updateMemory, saveCraftMemory…). Offering both lets the model pick a
  // representation the executor then rejects, and a schema that invites an
  // unhonorable shape is bad context, not something to patch around at runtime.
  if (memoryEntities && Object.keys(memoryEntities).length > 0) {
    return buildGeminiActionOnlySchema({}, memoryEntities)
  }

  // No memory entities (a persona that opted out of CRUD-native memory): the
  // legacy named-action interface is the only path that exists for it.
  const legacyActions = config.craftMemory?.enabled
    ? { ...MEMORY_ACTIONS, ...CRAFT_MEMORY_ACTIONS }
    : MEMORY_ACTIONS
  return buildGeminiActionOnlySchema(legacyActions)
}

/**
 * PersonaEngine — the main SDK entry point.
 * Wraps a PersonaConfig and provides the chat interface.
 */
export class PersonaEngine {
  readonly config: PersonaConfig

  constructor(config: PersonaConfig) {
    this.config = resolvePersonaConfigBrain(config)
  }

  /**
   * Stateless chat — app manages history + persistence.
   * Build prompt → call LLM → parse response.
   */
  async chat(input: ChatInput): Promise<ChatResult> {
    return chat(this.config, input)
  }

  /**
   * Stateless app-initiated turn — delegates to chat() with the intent
   * framed as a system section, not a user message.
   * The message slot gets a neutral directive so the AI understands
   * this is system-initiated, not user-initiated.
   */
  async promptedTurn(input: PromptedTurnInput): Promise<ChatResult> {
    const promptMode = resolvePromptedTurnMode(input.promptMode, input.turnKind)
    const chatInput: ChatInput = {
      ...toPromptedTurnChatInput(input),
      promptMode,
      // crudValidation handled below — not passed to chat() because chat()'s
      // retry adds input.message to history, and prompted turns should not
      // fabricate a fresh user utterance.
    }

    const result = await this.chat(chatInput)

    // CRUD validation gate — handled here (not in chat()) to keep retry
    // history clean: no synthetic user message in retry context.
    if (input.crudValidation && result.crudActions && result.crudActions.length > 0) {
      const validationErrors = input.crudValidation(result.crudActions)
      if (validationErrors && validationErrors.length > 0) {
        result.trace.errors.push(...validationErrors.map(e => `CRUD validation rejected: ${e}`))
        const maxRetries = input.crudValidationRetries ?? 1
        if (maxRetries > 0) {
          const retryGuidance = [
            '--- VALIDATION FEEDBACK (internal) ---',
            'The previous draft had CRUD validation errors:',
            ...validationErrors.map(e => `- ${e}`),
            '',
            'Regenerate the complete app-initiated turn for the original intent.',
            'Do not mention validation, correction, retries, the previous draft, or that you fixed anything in the user-facing message.',
          ].join('\n')

          return this.promptedTurn({
            ...input,
            extraSystemSections: [...(input.extraSystemSections ?? []), retryGuidance],
            crudValidationRetries: maxRetries - 1,
          })
        }
      }
    }

    return result
  }

  /**
   * Stateless retrospective memory pass — infer durable memory updates silently.
   * Returns memory CRUD actions only; no user-facing message.
   */
  async retrospect(input: RetrospectInput): Promise<RetrospectResult> {
    const effectiveEntities = filterRetrospectEntities(resolveEntities(this.config))

    const systemPrompt = buildRetrospectPrompt({
      config: { ...this.config, entities: effectiveEntities },
      input: {
        timezone: input.timezone,
        promptNow: input.promptNow,
        userIdentity: input.userIdentity,
        locale: input.locale,
        memories: input.memories,
        knowledgeDocuments: input.knowledgeDocuments,
        craftMemories: input.craftMemories,
        context: input.context,
        directives: input.directives,
        promptScaffold: input.promptScaffold,
        extraSystemSections: input.extraSystemSections,
        workingSet: input.workingSet,
      },
      guidelines: input.guidelines,
      history: input.history,
    })

    // Build response schema: CRUD entities for memory when available, legacy actions as fallback
    const retrospectSchema = buildRetrospectResponseSchema(this.config, effectiveEntities)

    const cleanHistory = stripActionAnnotations(input.history ?? [])
    const response = await this.config.provider.chat({
      systemPrompt,
      history: cleanHistory,
      message: 'Run the silent retrospective and return only the memory mutations that should change.',
      responseSchema: retrospectSchema,
    })

    return parseRetrospectResponse(response.text, this.config)
  }

  /**
   * Stateless greeting — build greeting prompt, call LLM, return plain text.
   * No response schema, no actions — just a warm check-in message.
   */
  async greet(input: GreetingInput): Promise<{ greeting: string }> {
    const result = await this.promptedTurn({
      label: 'Greeting',
      intent: "Generate a warm, natural check-in for a fresh or resumed session. Text like a thoughtful person, not a notification.",
      turnKind: 'proactive-conversation',
      timezone: input.timezone,
      promptNow: input.promptNow,
      userIdentity: input.userIdentity,
      locale: input.locale,
      memories: input.memories,
      knowledgeDocuments: input.knowledgeDocuments,
      craftMemories: input.craftMemories,
      context: input.context,
      guidelines: input.guidelines,
      history: input.history,
    })

    return { greeting: result.message }
  }

  /**
   * Check if a greeting is appropriate given the last message time.
   */
  shouldGreet(lastMessageAt: Date | null | undefined, timezone?: string): boolean {
    return shouldGreet(lastMessageAt, undefined, timezone)
  }

  /** The persona's display name */
  get name(): string {
    return this.config.identity.name
  }

  /** The LLM provider name */
  get providerName(): string {
    return this.config.provider.name
  }

  /**
   * Audit the persona for keystone principle violations.
   * Reviews the assembled prompt and optionally the conversation history.
   * Returns explicit, actionable failure lists for developers/coding agents.
   */
  async audit(input: AuditInput): Promise<AuditResult> {
    const promptResult = await auditPrompt({
      apiKey: input.apiKey,
      config: this.config,
      context: input.context,
      memories: input.memories,
    })

    const conversationResult = input.history?.length
      ? await auditConversation({
          apiKey: input.apiKey,
          config: this.config,
          history: input.history,
          context: input.context,
        })
      : null

    return {
      prompt: promptResult,
      conversation: conversationResult,
    }
  }
}
