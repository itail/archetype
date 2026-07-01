import { PersonaEngine } from './persona.js'
import type {
  PersonaConfig,
  ChatInput,
  ChatResult,
  CrudAction,
  RetrospectResult,
  ManagedChatInput,
  ManagedGreetingInput,
  ManagedPromptedTurnInput,
  ManagedRetrospectInput,
  StorageAdapter,
  Memory,
  KnowledgeDocument,
  KnowledgeAdapter,
  WorkingSet,
  TurnTrace,
  TracedCrudAction,
  PeerConfig,
  PeerConsultation,
  ManagedDomainCrudConfig,
  ManagedDomainCrudCommitResult,
} from './types.js'
import { resolveConversation, loadHistory, loadAttachmentCarryForwardSections, endConversation } from './managed/conversation.js'
import { loadMemories, expandPromptMemoryLoadBudget } from './managed/memory-manager.js'
import { createMarkdownKnowledgeAdapter } from './managed/knowledge.js'
import { reviewMemories as reviewMemoriesFn } from './managed/memory-review.js'
import { MEMORY_ACTION_NAMES, CRAFT_MEMORY_ACTION_NAMES } from './core/memory-actions.js'
import { executeSideEffects } from './engine/side-effects.js'
import { resolveActions, resolveEntities } from './core/effective-config.js'
import { buildPeerAction, PEER_ACTION_NAME, PEER_ACTION_NAMES } from './core/peer-actions.js'
import { buildAnnotations, buildPeerAnnotation } from './core/actions.js'
import { buildAssistantContinuityMessage } from './engine/continuity.js'
import type { ContinuityActionOutcome } from './engine/continuity.js'
import { commitCrud, crudActionToAnnotation, resolveTempIds } from './engine/crud.js'
import { buildAttachmentCarryForwardMessage } from './core/attachment-notes.js'
import {
  commitWorkingSet as commitWorkingSetEngine,
  reviewWorkingSetDelta as reviewWorkingSetDeltaEngine,
  summarizeWorkingSet,
  usesWorkingSet,
} from './engine/working-set.js'
export {
  archetype,
  auditFoundationSourceBoundary,
  foundationLowLevelImports,
  foundationPromptKnobs,
  rejectPromptKnobs,
} from './foundation/index.js'
export type {
  FoundationArchetype,
  FoundationArchetypeId,
  FoundationArchetypeOptions,
  FoundationAuditIssue,
  FoundationAuditResult,
  FoundationLedger,
  FoundationMemoryScope,
  FoundationMemorySurface,
  FoundationResolvedContract,
  FoundationWorld,
  GenericWorld,
  AuditLedgerRecordsInput,
  AuditMemoryRecordsInput,
  IronFitnessWorld,
  LedgerAdapter,
  LedgerInput,
  MemoryAdapter,
  MemorySurfaceInput,
  OrbitWorld,
  SavorWorld,
  CompoundWorld,
  WorkspaceRoot,
  WorkspaceWorld,
  WorkspaceWorldInput,
} from './foundation/index.js'

// ─── Trace utilities ────────────────────────────────────────────────────────


/**
 * Extract alerts from a TurnTrace — scan for failures and return severity-tagged entries.
 * Use this to surface problems in admin panels, chat debug cards, or console output.
 */
export function extractAlerts(trace: TurnTrace): Array<{ severity: 'error' | 'warn'; message: string; action?: string }> {
  const alerts: Array<{ severity: 'error' | 'warn'; message: string; action?: string }> = []

  if (!trace.parseOk) {
    alerts.push({ severity: 'error', message: 'Failed to parse LLM response as JSON' })
  }

  for (const error of trace.errors) {
    if (error.includes('legacy top-level "crudActions" key')) {
      alerts.push({ severity: 'warn', message: error })
    }
  }

  for (const a of trace.actions) {
    if (a.status === 'unknown_action') {
      alerts.push({ severity: 'error', message: `Unknown action "${a.name}" — not defined in persona config`, action: a.name })
    } else if (a.status === 'invalid') {
      alerts.push({ severity: 'warn', message: `Action "${a.name}" failed validation: ${a.error ?? 'unknown'}`, action: a.name })
    }
  }

  for (const c of trace.crudActions) {
    if (c.status === 'invalid') {
      alerts.push({ severity: 'warn', message: `CRUD ${c.operation} ${c.entity} failed validation: ${c.error ?? 'unknown'}`, action: `${c.operation} ${c.entity}` })
    }
  }

  for (const e of trace.executionResults) {
    if (e.status === 'failed') {
      alerts.push({ severity: 'error', message: `CRUD ${e.operation} ${e.entity} failed execution: ${e.error ?? 'unknown'}`, action: `${e.operation} ${e.entity}` })
    }
  }

  for (const d of trace.domainActions) {
    if (d.status === 'failed') {
      alerts.push({ severity: 'error', message: `Domain action "${d.name}" failed: ${d.error ?? 'unknown'}`, action: d.name })
    }
  }

  // Check peer consultations for failures
  if (trace.peerConsultations) {
    for (const pc of trace.peerConsultations) {
      const peerAlerts = extractAlerts(pc.trace)
      for (const pa of peerAlerts) {
        alerts.push({ severity: pa.severity, message: `[peer:${pc.peer}] ${pa.message}`, action: pa.action })
      }
    }
  }

  return alerts
}

/**
 * Summarize a TurnTrace into a structured object for chat debug cards and admin views.
 * Returns the full story — outcome notes, action details, pipeline sections — not just counts.
 * This is the rendering contract: what this function returns is what the UI should show.
 */
export function summarizeTrace(trace: TurnTrace) {
  const alerts = extractAlerts(trace)
  const allItems = [...trace.actions, ...trace.crudActions, ...trace.executionResults, ...trace.domainActions]
  const failedCount = allItems.filter(a => a.status === 'invalid' || a.status === 'failed' || a.status === 'unknown_action').length
  return {
    traceId: trace.traceId,
    personaId: trace.personaId,
    correlationId: trace.correlationId,
    durationMs: trace.completedAt ? trace.completedAt - trace.startedAt : null,
    parseOk: trace.parseOk,
    repairAttempted: trace.repairAttempted,
    repairSucceeded: trace.repairSucceeded,
    alerts,
    outcomeNotes: trace.outcomeNotes,
    actions: trace.actions,
    crudActions: trace.crudActions,
    executionResults: trace.executionResults,
    domainActions: trace.domainActions,
    peerConsultations: trace.peerConsultations?.map(pc => ({
      peer: pc.peer,
      query: pc.query.slice(0, 200),
      durationMs: pc.durationMs,
      alertCount: extractAlerts(pc.trace).length,
    })),
    errors: trace.errors,
    actionCount: allItems.length,
    failedCount,
  }
}

function logTraceAlerts(trace: TurnTrace): void {
  const alerts = extractAlerts(trace)
  for (const alert of alerts) {
    const prefix = alert.severity === 'error'
      ? '\x1b[31m[ARCHETYPE ALERT]\x1b[0m'
      : '\x1b[33m[ARCHETYPE WARN]\x1b[0m'
    console[alert.severity === 'error' ? 'error' : 'warn'](`${prefix} ${alert.message}`)
  }
}

function createTracePersister(adapter: StorageAdapter) {
  let warned = false
  return async (conversationId: string, trace: TurnTrace) => {
    if (adapter.saveTrace) {
      await adapter.saveTrace(conversationId, trace)
    } else if (!warned) {
      console.warn('[archetype] Trace persistence unavailable — implement saveTrace() on StorageAdapter')
      warned = true
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Define a persona from config. Returns a PersonaEngine for stateless chat.
 */
export function definePersona(config: PersonaConfig): PersonaEngine {
  return new PersonaEngine(config)
}

// ─── Managed mode ────────────────────────────────────────────────────────────

export interface RetrospectConfig {
  /** Auto-run retrospective before first turn of each day (default: false) */
  auto?: boolean
  /** Domain-specific guidelines for the retrospective prompt */
  guidelines?: string
}

export interface MemoryReviewConfig {
  /** Auto-run memory review on a schedule (default: false) */
  auto?: boolean
  /** Minimum days between review runs (default: 7) */
  interval?: number
  /** Only review memories older than this many days (default: 7) */
  maxAge?: number
  /** Preserve pinned memories from review (default: true) */
  preservePinned?: boolean
}

export interface WithStorageOptions {
  adapter: StorageAdapter
  /** Max messages to load from history (default: 30) */
  historyLimit?: number
  /** Memory character budget (default: 8000) */
  memoryBudget?: number
  /** Craft memory character budget (default: 3000) */
  craftMemoryBudget?: number
  /** Auto-retrospective configuration */
  retrospect?: RetrospectConfig
  /** Auto memory review configuration */
  memoryReview?: MemoryReviewConfig
  /** Queryable durable knowledge surface (docs, capabilities, policies) */
  knowledge?: {
    adapter: KnowledgeAdapter
    budget?: number
    maxDocuments?: number
    buildQuery?: (input: {
      mode: 'chat' | 'prompted-turn' | 'retrospect'
      message?: string
      intent?: string
      context?: Record<string, unknown>
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      userIdentity?: string
    }) => string | null
  }
  /** Peer personas this persona can consult mid-turn via the built-in consultPeer action */
  peers?: Record<string, PeerConfig>
}

export interface ManagedPersona {
  chat(input: ManagedChatInput): Promise<ChatResult & { conversationId: string }>
  promptedTurn(input: ManagedPromptedTurnInput): Promise<ChatResult & { conversationId: string }>
  retrospect(input: ManagedRetrospectInput): Promise<RetrospectResult>
  greet(input: ManagedGreetingInput): Promise<{ greeting: string; conversationId: string }>
  reviewWorkingSet(input: { conversationId: string; deltaId: string; decision: import('./types.js').WorkingSetReviewDecision }): Promise<{ conversationId: string; workingSet: WorkingSet; summary: import('./types.js').WorkingSetSummary }>
  commitWorkingSet(input: { conversationId: string; handlers: Record<string, import('./engine/side-effects.js').SideEffectHandler>; deltaIds?: string[] }): Promise<{ conversationId: string; workingSet: WorkingSet; results: import('./engine/side-effects.js').SideEffectResult[] }>
  endConversation(conversationId: string): Promise<void>
  readonly engine: PersonaEngine
}

/**
 * Wrap a persona engine with a storage adapter for auto-persisting
 * conversations and memories. Layer 2 — opt-in.
 */
export function withStorage(
  engine: PersonaEngine,
  options: WithStorageOptions,
): ManagedPersona {
  const {
    adapter,
    historyLimit = 30,
    memoryBudget = 8000,
    craftMemoryBudget = 3000,
    retrospect: retrospectConfig,
    memoryReview: reviewConfig,
    knowledge,
    peers,
  } = options

  // When peers are configured, create a peer-aware engine with consultPeer action merged in.
  // This ensures the prompt includes peer descriptions and validation works against the schema.
  const effectiveEngine: PersonaEngine = peers && Object.keys(peers).length > 0
    ? new PersonaEngine({
        ...engine.config,
        actions: { ...(engine.config.actions ?? {}), ...buildPeerAction(peers) },
      })
    : engine

  const persistTrace = createTracePersister(adapter)

  // ─── Auto memory review state ──────────────────────────────────────────────
  let lastReviewedAt: number | null = null
  let reviewInFlight = false

  const shouldAutoReview = (): boolean => {
    if (!reviewConfig?.auto) return false
    if (reviewInFlight) return false
    if (lastReviewedAt === null) return true // first run since startup
    const intervalMs = (reviewConfig.interval ?? 7) * 86400000
    return Date.now() - lastReviewedAt >= intervalMs
  }

  const runAutoReview = async (): Promise<void> => {
    reviewInFlight = true
    try {
      // User memories
      const result = await reviewMemoriesFn({
        adapter,
        provider: engine.config.provider,
        maxAge: reviewConfig?.maxAge ?? 7,
        preservePinned: reviewConfig?.preservePinned ?? true,
        memoryPurpose: engine.config.memory?.purpose,
        categoryDescriptions: engine.config.memory?.categories,
        scope: 'user',
      })
      if (result.removed > 0) {
        console.log(`[archetype] Reviewed user memories: ${result.removed} → ${result.created}`)
      }

      // Craft memories (if enabled)
      if (engine.config.craftMemory?.enabled && adapter.loadCraftMemories) {
        const craftResult = await reviewMemoriesFn({
          adapter,
          provider: engine.config.provider,
          maxAge: reviewConfig?.maxAge ?? 7,
          preservePinned: reviewConfig?.preservePinned ?? true,
          memoryPurpose: engine.config.craftMemory.purpose,
          categoryDescriptions: engine.config.craftMemory.categories,
          scope: 'craft',
        })
        if (craftResult.removed > 0) {
          console.log(`[archetype] Reviewed craft memories: ${craftResult.removed} → ${craftResult.created}`)
        }
      }

      lastReviewedAt = Date.now()
    } catch (err) {
      console.error('[archetype] Auto memory review failed:', err instanceof Error ? err.message : err)
    } finally {
      reviewInFlight = false
    }
  }

  /**
   * Check if auto-retrospective should run based on the last message timestamp.
   * Returns true if the last assistant/user message is from a previous calendar day.
   */
  const shouldAutoRetrospect = (
    history: Array<{ role: string; content: string; createdAt?: string }>,
    timezone?: string,
  ): boolean => {
    if (!retrospectConfig?.auto) return false
    if (history.length === 0) return false

    // Find the last non-note message with a timestamp
    const lastMsg = [...history].reverse().find(m => m.createdAt)
    if (!lastMsg?.createdAt) return false

    const lastDate = timezone
      ? new Date(lastMsg.createdAt).toLocaleDateString('en-CA', { timeZone: timezone })
      : new Date(lastMsg.createdAt).toISOString().slice(0, 10)
    const today = timezone
      ? new Date().toLocaleDateString('en-CA', { timeZone: timezone })
      : new Date().toISOString().slice(0, 10)

    return lastDate !== today
  }

  const loadCraftMemories = async (): Promise<Memory[]> => {
    if (!engine.config.craftMemory?.enabled || !adapter.loadCraftMemories) return []
    return adapter.loadCraftMemories({ budget: expandPromptMemoryLoadBudget(craftMemoryBudget) })
  }

  const loadKnowledgeDocuments = async (input: {
    mode: 'chat' | 'prompted-turn' | 'retrospect'
    message?: string
    intent?: string
    context?: Record<string, unknown>
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    userIdentity?: string
  }): Promise<KnowledgeDocument[]> => {
    if (!knowledge?.adapter) return []
    const query = knowledge.buildQuery?.(input) ?? defaultKnowledgeQuery(input)
    if (!query) return []
    return knowledge.adapter.searchDocuments({
      query,
      budget: knowledge.budget ?? effectiveEngine.config.knowledge?.budget,
      maxDocuments: knowledge.maxDocuments ?? effectiveEngine.config.knowledge?.maxDocuments,
    })
  }

  const runPreTurnMaintenance = async (input: {
    conversationId: string
    context?: Record<string, unknown>
    timezone?: string
    promptNow?: Date | string
    userIdentity?: string
    locale?: string
    directives?: string | null
    promptMode?: import('./types.js').PromptMode
    promptScaffold?: import('./types.js').PromptScaffoldConfig
    extraSystemSections?: string[]
    rawMessages?: Array<{ role: string; content: string; createdAt?: string; isNote?: boolean }>
  }): Promise<void> => {
    if (retrospectConfig?.auto) {
      const rawMessages = input.rawMessages ?? await adapter.getMessages(input.conversationId, historyLimit)
      if (shouldAutoRetrospect(rawMessages, input.timezone)) {
        const historyForRetrospect = rawMessages
          .filter(m => !m.isNote && (m.role === 'user' || m.role === 'assistant'))
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        await runRetrospect({
          conversationId: input.conversationId,
          context: input.context,
          timezone: input.timezone,
          promptNow: input.promptNow,
          userIdentity: input.userIdentity,
          locale: input.locale,
          directives: input.directives,
          promptMode: input.promptMode,
          promptScaffold: input.promptScaffold,
          extraSystemSections: input.extraSystemSections,
          guidelines: retrospectConfig.guidelines,
          history: historyForRetrospect,
        })
      }
    }

    if (shouldAutoReview()) {
      await runAutoReview()
    }
  }

  const loadManagedTurnState = async (
    conversationId: string,
    knowledgeInput?: {
      mode: 'chat' | 'prompted-turn' | 'retrospect'
      message?: string
      intent?: string
      context?: Record<string, unknown>
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
      userIdentity?: string
    },
  ): Promise<{
    history: Array<{ role: 'user' | 'assistant'; content: string }>
    attachmentSections: string[]
    workingSet: WorkingSet | null
    memories: Memory[]
    knowledgeDocuments: KnowledgeDocument[]
    craftMemories: Memory[]
  }> => {
    const history = await loadHistory(adapter, conversationId, historyLimit)
    const attachmentSections = await loadAttachmentCarryForwardSections(adapter, conversationId, historyLimit)
    const workingSet = usesWorkingSet(effectiveEngine.config)
      ? await loadManagedWorkingSet(adapter, conversationId)
      : null
    const memories: Memory[] = await loadMemories(adapter, memoryBudget)
    const knowledgeDocuments = knowledgeInput ? await loadKnowledgeDocuments({ ...knowledgeInput, history }) : []
    const craftMemories = await loadCraftMemories()
    return { history, attachmentSections, workingSet, memories, knowledgeDocuments, craftMemories }
  }

  const executeManagedMemorySideEffects = async (
    result: ChatResult,
    options?: { annotateCrud?: boolean },
  ): Promise<{
    executedCrudAnnotations: string[]
    executedMemoryActionNames: Set<string>
    actionOutcomes: ContinuityActionOutcome[]
  }> => {
    const executedCrudAnnotations: string[] = []
    const executedMemoryActionNames = new Set<string>()
    const actionOutcomes: ContinuityActionOutcome[] = []
    const memoryCrudEntities = new Set(['memory', 'craftMemory'])
    const trace = result.trace

    if (result.crudActions && result.crudActions.length > 0) {
      const resolvedCrud = resolveTempIds(result.crudActions)
      const memoryCrudActions = resolvedCrud.filter(action => memoryCrudEntities.has(action.entity))
      const memoryCrudHandler = buildMemoryCrudHandler(adapter)
      const craftCrudHandler = buildCraftMemoryCrudHandler(adapter)

      for (const crudAction of memoryCrudActions) {
        try {
          if (crudAction.entity === 'memory') {
            await memoryCrudHandler(crudAction)
          } else if (crudAction.entity === 'craftMemory') {
            await craftCrudHandler(crudAction)
          }
          if (options?.annotateCrud) {
            executedCrudAnnotations.push(
              crudActionToAnnotation(crudAction, {
                memory: { schema: {} as any, label: 'Memory', displayField: 'content' },
                craftMemory: { schema: {} as any, label: 'Craft Memory', displayField: 'content' },
              }),
            )
          }
          trace.executionResults.push({
            operation: crudAction.operation,
            entity: crudAction.entity,
            id: crudAction.id,
            params: crudAction.params ?? {},
            status: 'executed',
          })
          actionOutcomes.push({
            outcomeNote: crudOutcomeNote(crudAction, 'executed'),
            status: 'executed',
            success: true,
          })
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.warn(`[archetype] Memory CRUD failed: ${crudAction.operation} ${crudAction.entity}: ${errorMsg}`)
          trace.executionResults.push({
            operation: crudAction.operation,
            entity: crudAction.entity,
            id: crudAction.id,
            params: crudAction.params ?? {},
            status: 'failed',
            error: errorMsg,
          })
          actionOutcomes.push({
            outcomeNote: crudOutcomeNote(crudAction, 'failed', errorMsg),
            status: 'failed',
            success: false,
            error: errorMsg,
          })
        }
      }
    }

    if (result.actions.length > 0) {
      const legacyMemoryActions = result.actions.filter(action =>
        MEMORY_ACTION_NAMES.has(action.name) || CRAFT_MEMORY_ACTION_NAMES.has(action.name),
      )
      if (legacyMemoryActions.length > 0) {
        const allHandlers = { ...buildMemoryHandlers(adapter), ...buildCraftMemoryHandlers(adapter) }
        const effectiveActions = resolveActions(effectiveEngine.config) ?? {}
        const legacyResults = await executeSideEffects(legacyMemoryActions, allHandlers, effectiveActions)
        for (const legacyResult of legacyResults) {
          if (legacyResult.status === 'executed' && legacyResult.success) {
            executedMemoryActionNames.add(legacyResult.action.name)
          }
          actionOutcomes.push({
            action: legacyResult.action,
            status: legacyResult.status,
            success: legacyResult.success,
            error: legacyResult.error,
            annotation: legacyResult.annotation,
          })
        }
      }
    }

    return { executedCrudAnnotations, executedMemoryActionNames, actionOutcomes }
  }

  const executeManagedDomainCrud = async (
    result: ChatResult,
    domainCrud?: ManagedDomainCrudConfig,
  ): Promise<{
    actionOutcomes: ContinuityActionOutcome[]
    results: ManagedDomainCrudCommitResult[]
  }> => {
    if (!domainCrud || !result.crudActions || result.crudActions.length === 0) {
      return { actionOutcomes: [], results: [] }
    }

    const sdkCrudEntities = new Set(['memory', 'craftMemory'])
    const resolvedCrud = resolveTempIds(result.crudActions)
    const domainActions = resolvedCrud.filter(action => !sdkCrudEntities.has(action.entity))
    if (domainActions.length === 0) return { actionOutcomes: [], results: [] }

    const preparedActions = domainCrud.prepare ? await domainCrud.prepare(domainActions) : domainActions
    const results = await commitCrud(preparedActions, domainCrud.handlers, { trace: result.trace })
    const customNotes = domainCrud.summarize
      ? (await domainCrud.summarize({ actions: preparedActions, results }))
          .map(note => note.trim())
          .filter(Boolean)
      : []

    const fallbackOutcomes = preparedActions.map((action, index): ContinuityActionOutcome => {
      const result = results[index]
      const success = Boolean(result?.success)
      return {
        outcomeNote: crudOutcomeNote(action, success ? 'executed' : 'failed', result?.error),
        status: success ? 'executed' : 'failed',
        success,
        error: result?.error,
      }
    })

    const actionOutcomes = customNotes.length > 0
      ? [
          ...customNotes.map((note): ContinuityActionOutcome => ({
            outcomeNote: note,
            status: 'executed',
            success: true,
          })),
          ...fallbackOutcomes.filter(outcome => outcome.success === false),
        ]
      : fallbackOutcomes

    return { actionOutcomes, results }
  }

  const finalizeManagedTurn = async (params: {
    conversationId: string
    result: ChatResult
    assistantContent: string
    actionsJson?: string | null
    saveAttachmentNotes?: boolean
  }): Promise<ChatResult & { conversationId: string }> => {
    await adapter.saveMessage(params.conversationId, {
      role: 'assistant',
      content: params.assistantContent,
      actionsJson: params.actionsJson ?? null,
      isNote: false,
    })

    if (params.saveAttachmentNotes && params.result.attachmentNotes && params.result.attachmentNotes.length > 0) {
      await adapter.saveMessage(params.conversationId, {
        role: 'system',
        content: buildAttachmentCarryForwardMessage(params.result.attachmentNotes),
        isNote: true,
      })
    }

    const trace = params.result.trace
    trace.completedAt = Date.now()
    logTraceAlerts(trace)
    await persistTrace(params.conversationId, trace)

    return {
      ...params.result,
      crudActions: stripSdkCrudActions(params.result.crudActions),
      conversationId: params.conversationId,
    }
  }

  const runPromptedTurn = async (
    input: ManagedPromptedTurnInput,
  ): Promise<ChatResult & { conversationId: string }> => {
    const conversationId = await resolveConversation(
      adapter,
      input.conversationId,
      input.trigger ?? 'prompted_turn',
      input.metadata,
    )

    await runPreTurnMaintenance({
      conversationId,
      context: input.context,
      timezone: input.timezone,
      promptNow: input.promptNow,
      userIdentity: input.userIdentity,
      locale: input.locale,
      directives: input.directives,
      promptMode: input.promptMode,
      promptScaffold: input.promptScaffold,
      extraSystemSections: input.extraSystemSections,
    })

    const { history, attachmentSections, workingSet, memories, knowledgeDocuments, craftMemories } = await loadManagedTurnState(conversationId, {
      mode: 'prompted-turn',
      intent: input.intent,
      context: input.context,
      history: input.history,
      userIdentity: input.userIdentity,
    })

    const result = await effectiveEngine.promptedTurn({
      intent: input.intent,
      label: input.label,
      timezone: input.timezone,
      promptNow: input.promptNow,
      userIdentity: input.userIdentity,
      locale: input.locale,
      memories,
      knowledgeDocuments: input.knowledgeDocuments ?? knowledgeDocuments,
      craftMemories,
      context: input.context,
      turnKind: input.turnKind,
      promptMode: input.promptMode,
      directives: input.directives,
      promptScaffold: input.promptScaffold,
      guidelines: input.guidelines,
      extraSystemSections: [...attachmentSections, ...(input.extraSystemSections ?? [])],
      history: input.history ?? history,
      workingSet,
      crudValidation: input.crudValidation,
      crudValidationRetries: input.crudValidationRetries,
    })

    if (usesWorkingSet(effectiveEngine.config) && result.workingSet) {
      await saveManagedWorkingSet(adapter, conversationId, result.workingSet)
    }

    const memoryEffects = await executeManagedMemorySideEffects(result, { annotateCrud: true })
    const domainEffects = await executeManagedDomainCrud(result, input.domainCrud)
    const persistedActions = selectPersistedActions(effectiveEngine.config, result.actions)
    const isSdkAction = (name: string) => MEMORY_ACTION_NAMES.has(name) || CRAFT_MEMORY_ACTION_NAMES.has(name) || PEER_ACTION_NAMES.has(name)
    const annotatedActions = persistedActions.filter(action =>
      !isSdkAction(action.name) || memoryEffects.executedMemoryActionNames.has(action.name),
    )
    const actionAnnotations = annotatedActions.length > 0
      ? buildAnnotations(annotatedActions.map(action => ({ name: action.name, params: action.params })))
      : []
    const annotatedContent = buildAssistantContinuityMessage({
      message: result.message,
      modelOutcomeNotes: result.outcomeNotes,
      actionOutcomes: [...memoryEffects.actionOutcomes, ...domainEffects.actionOutcomes],
      actionAnnotations: [...actionAnnotations, ...memoryEffects.executedCrudAnnotations],
    })

    return finalizeManagedTurn({
      conversationId,
      result,
      assistantContent: annotatedContent,
      actionsJson: annotatedActions.length > 0 ? JSON.stringify(annotatedActions) : null,
      saveAttachmentNotes: true,
    })
  }

  const runRetrospect = async (
    input: ManagedRetrospectInput,
  ): Promise<RetrospectResult> => {
    const memories: Memory[] = await loadMemories(adapter, memoryBudget)
    const historyConversationId = input.conversationId
      ?? (await adapter.getActiveConversation())?.id
      ?? null

    let history = input.history ?? []
    if (history.length === 0) {
      history = historyConversationId
        ? await loadHistory(adapter, historyConversationId, historyLimit)
        : []
    }

    const attachmentSections = historyConversationId
      ? await loadAttachmentCarryForwardSections(adapter, historyConversationId, historyLimit)
      : []

    const knowledgeDocuments = input.knowledgeDocuments ?? await loadKnowledgeDocuments({
      mode: 'retrospect',
      context: input.context,
      history,
      userIdentity: input.userIdentity,
    })
    const craftMemories = await loadCraftMemories()

    const result = await engine.retrospect({
      timezone: input.timezone,
      promptNow: input.promptNow,
      userIdentity: input.userIdentity,
      locale: input.locale,
      memories,
      knowledgeDocuments,
      craftMemories,
      context: input.context,
      promptMode: input.promptMode,
      directives: input.directives,
      promptScaffold: input.promptScaffold,
      guidelines: input.guidelines,
      extraSystemSections: [...attachmentSections, ...(input.extraSystemSections ?? [])],
      history,
    })

    const hasActions = result.actions.length > 0
    const hasCrudActions = result.crudActions && result.crudActions.length > 0
    if (!hasActions && !hasCrudActions) return result

    const retrospectResults: import('./types.js').RetrospectActionResult[] = []

    // Execute CRUD-based memory mutations
    if (hasCrudActions) {
      const memoryCrudHandler = buildMemoryCrudHandler(adapter)
      const craftCrudHandler = buildCraftMemoryCrudHandler(adapter)

      for (const crudAction of result.crudActions!) {
        try {
          if (crudAction.entity === 'memory') {
            await memoryCrudHandler(crudAction)
          } else if (crudAction.entity === 'craftMemory') {
            await craftCrudHandler(crudAction)
          }
          retrospectResults.push({
            name: `${crudAction.operation}_${crudAction.entity}`,
            status: 'executed',
          })
        } catch (err) {
          retrospectResults.push({
            name: `${crudAction.operation}_${crudAction.entity}`,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    // Legacy action-based memory mutations (backward compat)
    if (hasActions) {
      const allHandlers = {
        ...buildMemoryHandlers(adapter),
        ...buildCraftMemoryHandlers(adapter),
      }
      const effectiveActions = resolveActions(effectiveEngine.config) ?? {}
      const sideEffectResults = await executeSideEffects(
        result.actions,
        allHandlers,
        effectiveActions,
      )
      for (const item of sideEffectResults) {
        retrospectResults.push({
          name: item.action.name,
          status: item.status,
          error: item.error,
        })
      }
    }

    return {
      ...result,
      results: retrospectResults,
    }
  }

  return {
    engine: effectiveEngine,

    async chat(input: ManagedChatInput): Promise<ChatResult & { conversationId: string }> {
      const conversationId = await resolveConversation(
        adapter,
        input.conversationId,
        input.trigger,
        input.metadata,
      )

      const rawMessagesBeforeTurn = await adapter.getMessages(conversationId, historyLimit)

      await adapter.saveMessage(conversationId, {
        role: 'user',
        content: input.message,
        isNote: false,
      })

      await runPreTurnMaintenance({
        conversationId,
        context: input.context,
        timezone: input.timezone,
        promptNow: input.promptNow,
        userIdentity: input.userIdentity,
        locale: input.locale,
        directives: input.directives,
        promptScaffold: input.promptScaffold,
        extraSystemSections: input.extraSystemSections,
        rawMessages: rawMessagesBeforeTurn,
      })

      const { history, attachmentSections, workingSet, memories, knowledgeDocuments, craftMemories } = await loadManagedTurnState(conversationId, {
        mode: 'chat',
        message: input.message,
        context: input.context,
        userIdentity: input.userIdentity,
      })
      const historyForLLM = history.slice(0, -1)

      const chatInput: ChatInput = {
        message: input.message,
        history: historyForLLM,
        context: input.context,
        memories,
        knowledgeDocuments: input.knowledgeDocuments ?? knowledgeDocuments,
        craftMemories,
        timezone: input.timezone,
        promptNow: input.promptNow,
        directives: input.directives,
        promptMode: input.promptMode,
        promptScaffold: input.promptScaffold,
        extraSystemSections: [...attachmentSections, ...(input.extraSystemSections ?? [])],
        userIdentity: input.userIdentity,
        locale: input.locale,
        personaId: input.personaId,
        correlationId: input.correlationId,
        attachments: input.attachments,
        workingSet,
        crudValidation: input.crudValidation,
        crudValidationRetries: input.crudValidationRetries,
      }
      let result = await effectiveEngine.chat(chatInput)

      if (peers && Object.keys(peers).length > 0) {
        const peerActions = result.actions.filter(a => a.name === PEER_ACTION_NAME)

        if (peerActions.length > 0) {
          const consultations: PeerConsultation[] = []

          for (const action of peerActions) {
            const { peer: peerName, query } = action.params as { peer: string; query: string }
            const peerConfig = peers[peerName]
            if (!peerConfig) {
              result.trace.errors.push(`Unknown peer: "${peerName}" — not declared in peers config`)
              continue
            }

            const peerStart = Date.now()
            try {
              const peerContext = await peerConfig.contextBuilder(query, input.context ?? {})
              const peerConvId = peerConfig.conversationResolver
                ? await peerConfig.conversationResolver()
                : undefined

              const peerResult = await peerConfig.persona.chat({
                message: query,
                conversationId: peerConvId,
                context: peerContext,
                personaId: peerName,
                correlationId: input.correlationId,
                timezone: input.timezone,
              } as ManagedChatInput)

              consultations.push({
                peer: peerName,
                query,
                response: peerResult.message,
                trace: peerResult.trace,
                durationMs: Date.now() - peerStart,
              })
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err)
              result.trace.errors.push(`Peer consultation "${peerName}" failed: ${errorMsg}`)
              console.warn(`[archetype] Peer consultation failed: ${peerName}: ${errorMsg}`)
            }
          }

          if (consultations.length > 0) {
            // Stamp consultations on the initial trace (preserved even after re-call)
            result.trace.peerConsultations = consultations

            // Re-call engine with enriched context — peer responses injected via extraSystemSections
            const peerSections = consultations.map(c =>
              `--- FROM ${c.peer.toUpperCase()} ---\nYou asked: "${c.query}"\n\n${c.response}\n--- END ${c.peer.toUpperCase()} ---`,
            )

            const enrichedResult = await effectiveEngine.chat({
              ...chatInput,
              extraSystemSections: [
                ...peerSections,
                ...(chatInput.extraSystemSections ?? []),
              ],
            })

            // Merge: use the enriched response but keep the original trace (with peer consultations)
            const enrichedTrace = enrichedResult.trace
            enrichedTrace.personaId = result.trace.personaId
            enrichedTrace.correlationId = result.trace.correlationId
            enrichedTrace.peerConsultations = consultations
            result = enrichedResult
          }
        }
      }

      // Filter out consultPeer actions from persisted actions — they're SDK-internal
      result = {
        ...result,
        actions: result.actions.filter(a => !PEER_ACTION_NAMES.has(a.name)),
      }

      if (usesWorkingSet(effectiveEngine.config) && result.workingSet) {
        await saveManagedWorkingSet(adapter, conversationId, result.workingSet)
      }

      const persistedActions = selectPersistedActions(effectiveEngine.config, result.actions)
      const memoryEffects = await executeManagedMemorySideEffects(result, { annotateCrud: true })
      const domainEffects = await executeManagedDomainCrud(result, input.domainCrud)

      const isSdkAction = (name: string) => MEMORY_ACTION_NAMES.has(name) || CRAFT_MEMORY_ACTION_NAMES.has(name) || PEER_ACTION_NAMES.has(name)
      const annotatedActions = persistedActions.filter(a =>
        !isSdkAction(a.name) || memoryEffects.executedMemoryActionNames.has(a.name),
      )
      const actionAnnotations = annotatedActions.length > 0
        ? buildAnnotations(annotatedActions.map(a => ({ name: a.name, params: a.params })))
        : []
      const allAnnotations = [...actionAnnotations, ...memoryEffects.executedCrudAnnotations]
      const peerAnnotation = result.trace.peerConsultations?.length
        ? buildPeerAnnotation(result.trace.peerConsultations)
        : ''
      const annotatedContent = buildAssistantContinuityMessage({
        message: result.message,
        modelOutcomeNotes: result.outcomeNotes,
        actionOutcomes: [...memoryEffects.actionOutcomes, ...domainEffects.actionOutcomes],
        actionAnnotations: allAnnotations,
        extraHistorySections: peerAnnotation ? [peerAnnotation] : [],
      })

      return finalizeManagedTurn({
        conversationId,
        result,
        assistantContent: annotatedContent,
        actionsJson: annotatedActions.length > 0 ? JSON.stringify(annotatedActions) : null,
        saveAttachmentNotes: true,
      })
    },

    async greet(input: ManagedGreetingInput): Promise<{ greeting: string; conversationId: string }> {
      const result = await runPromptedTurn({
        ...input,
        trigger: input.trigger ?? 'greeting',
        label: 'Greeting',
        intent: "You're checking in on a fresh or resumed session. Generate a warm, natural check-in that reads like a thoughtful person, not a notification.",
        turnKind: 'proactive-conversation',
      })

      return { greeting: result.message, conversationId: result.conversationId }
    },

    async promptedTurn(input: ManagedPromptedTurnInput): Promise<ChatResult & { conversationId: string }> {
      return runPromptedTurn(input)
    },

    async retrospect(input: ManagedRetrospectInput): Promise<RetrospectResult> {
      return runRetrospect(input)
    },

    async reviewWorkingSet(input): Promise<{ conversationId: string; workingSet: WorkingSet; summary: import('./types.js').WorkingSetSummary }> {
      const workingSet = await loadManagedWorkingSet(adapter, input.conversationId)
      if (!workingSet) {
        throw new Error(`No working set found for conversation ${input.conversationId}`)
      }
      const reviewed = reviewWorkingSetDeltaEngine(workingSet, {
        deltaId: input.deltaId,
        decision: input.decision,
      })
      await saveManagedWorkingSet(adapter, input.conversationId, reviewed)
      return {
        conversationId: input.conversationId,
        workingSet: reviewed,
        summary: summarizeWorkingSet(reviewed)!,
      }
    },

    async commitWorkingSet(input): Promise<{ conversationId: string; workingSet: WorkingSet; results: import('./engine/side-effects.js').SideEffectResult[] }> {
      const workingSet = await loadManagedWorkingSet(adapter, input.conversationId)
      if (!workingSet) {
        throw new Error(`No working set found for conversation ${input.conversationId}`)
      }
      const committed = await commitWorkingSetEngine(workingSet, input.handlers, input.deltaIds)
      await saveManagedWorkingSet(adapter, input.conversationId, committed.workingSet)
      return {
        conversationId: input.conversationId,
        workingSet: committed.workingSet,
        results: committed.results,
      }
    },

    async endConversation(conversationId: string): Promise<void> {
      await endConversation(adapter, conversationId)
      if (adapter.clearWorkingSet) {
        await adapter.clearWorkingSet(conversationId)
      }
    },
  }
}

function defaultKnowledgeQuery(input: {
  mode: 'chat' | 'prompted-turn' | 'retrospect'
  message?: string
  intent?: string
  context?: Record<string, unknown>
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  userIdentity?: string
}): string | null {
  const base =
    input.mode === 'chat'
      ? input.message
      : input.mode === 'prompted-turn'
        ? input.intent
        : input.history?.slice(-4).map(item => item.content).join('\n')

  const query = base?.trim()
  return query ? query : null
}

function selectPersistedActions(config: PersonaConfig, actions: import('./types.js').ParsedAction[]): import('./types.js').ParsedAction[] {
  if (!usesWorkingSet(config)) return actions
  return actions.filter(action => MEMORY_ACTION_NAMES.has(action.name) || CRAFT_MEMORY_ACTION_NAMES.has(action.name))
}

function stripSdkCrudActions(
  crudActions?: CrudAction[],
): CrudAction[] | undefined {
  if (!crudActions || crudActions.length === 0) return crudActions
  const sdkCrudEntities = new Set(['memory', 'craftMemory'])
  const filtered = crudActions.filter(action => !sdkCrudEntities.has(action.entity))
  return filtered.length > 0 ? filtered : undefined
}

function crudOutcomeNote(
  action: CrudAction,
  status: 'executed' | 'failed',
  error?: string,
): string {
  const summary = `crud ${action.operation} ${action.entity}`
  return status === 'failed'
    ? `${summary} failed${error ? `: ${error}` : '.'}`
    : `${summary} executed.`
}

async function loadManagedWorkingSet(adapter: StorageAdapter, conversationId: string): Promise<WorkingSet | null> {
  if (!adapter.loadWorkingSet || !adapter.saveWorkingSet || !adapter.clearWorkingSet) {
    throw new Error('This persona uses staging.model = "working-set", but the StorageAdapter does not implement loadWorkingSet/saveWorkingSet/clearWorkingSet.')
  }
  return adapter.loadWorkingSet(conversationId)
}

async function saveManagedWorkingSet(adapter: StorageAdapter, conversationId: string, workingSet: WorkingSet): Promise<void> {
  if (!adapter.saveWorkingSet) {
    throw new Error('This persona uses staging.model = "working-set", but the StorageAdapter does not implement saveWorkingSet.')
  }
  await adapter.saveWorkingSet(conversationId, workingSet)
}

/**
 * Build side-effect handlers for built-in memory actions.
 * These route saveMemory/updateMemory/deleteMemory to the StorageAdapter.
 */
function buildMemoryHandlers(adapter: StorageAdapter): Record<string, import('./engine/side-effects.js').SideEffectHandler> {
  return {
    saveMemory: async (params) => {
      const { content, category, source, stability, contextHint } = params as {
        content: string
        category: string
        source?: Memory['source']
        stability?: Memory['stability']
        contextHint?: string
      }
      await adapter.saveMemory({
        content,
        category,
        source,
        stability,
        contextHint,
        pinned: false,
        createdAt: new Date().toISOString(),
      })
      return { success: true }
    },
    updateMemory: async (params) => {
      const { id, content, category, source, stability, contextHint } = params as {
        id: string
        content?: string
        category?: string
        source?: Memory['source']
        stability?: Memory['stability']
        contextHint?: string
      }
      await adapter.updateMemory(id, { content, category, source, stability, contextHint })
      return { success: true }
    },
    deleteMemory: async (params) => {
      const { id } = params as { id: string }
      await adapter.deleteMemory(id)
      return { success: true }
    },
  }
}

function buildCraftMemoryHandlers(adapter: StorageAdapter): Record<string, import('./engine/side-effects.js').SideEffectHandler> {
  return {
    saveCraftMemory: async (params) => {
      if (!adapter.saveCraftMemory) throw new Error('StorageAdapter does not implement saveCraftMemory')
      const { content, category, source, stability, contextHint } = params as {
        content: string
        category: string
        source?: Memory['source']
        stability?: Memory['stability']
        contextHint?: string
      }
      await adapter.saveCraftMemory({
        content,
        category,
        scope: 'craft',
        source,
        stability,
        contextHint,
        pinned: false,
        createdAt: new Date().toISOString(),
      })
      return { success: true }
    },
    updateCraftMemory: async (params) => {
      if (!adapter.updateCraftMemory) throw new Error('StorageAdapter does not implement updateCraftMemory')
      const { id, content, category, source, stability, contextHint } = params as {
        id: string
        content?: string
        category?: string
        source?: Memory['source']
        stability?: Memory['stability']
        contextHint?: string
      }
      await adapter.updateCraftMemory(id, { content, category, source, stability, contextHint })
      return { success: true }
    },
    deleteCraftMemory: async (params) => {
      if (!adapter.deleteCraftMemory) throw new Error('StorageAdapter does not implement deleteCraftMemory')
      const { id } = params as { id: string }
      await adapter.deleteCraftMemory(id)
      return { success: true }
    },
  }
}

/**
 * CRUD handler for memory entity — routes create/update/delete to the StorageAdapter.
 */
function buildMemoryCrudHandler(adapter: StorageAdapter): (action: CrudAction) => Promise<void> {
  return async (action: CrudAction) => {
    if (action.operation === 'create') {
      const { content, category, source, stability, contextHint } = (action.params ?? {}) as {
        content: string
        category: string
        source?: Memory['source']
        stability?: Memory['stability']
        contextHint?: string
      }
      await adapter.saveMemory({
        content,
        category,
        source,
        stability,
        contextHint,
        pinned: false,
        createdAt: new Date().toISOString(),
      })
    } else if (action.operation === 'update' && action.id) {
      await adapter.updateMemory(action.id, action.params as Partial<Memory>)
    } else if (action.operation === 'delete' && action.id) {
      await adapter.deleteMemory(action.id)
    }
  }
}

/**
 * CRUD handler for craftMemory entity — routes create/update/delete to the StorageAdapter.
 */
function buildCraftMemoryCrudHandler(adapter: StorageAdapter): (action: CrudAction) => Promise<void> {
  return async (action: CrudAction) => {
    if (action.operation === 'create') {
      if (!adapter.saveCraftMemory) throw new Error('StorageAdapter does not implement saveCraftMemory')
      const { content, category, source, stability, contextHint } = (action.params ?? {}) as {
        content: string
        category: string
        source?: Memory['source']
        stability?: Memory['stability']
        contextHint?: string
      }
      await adapter.saveCraftMemory({
        content,
        category,
        scope: 'craft',
        source,
        stability,
        contextHint,
        pinned: false,
        createdAt: new Date().toISOString(),
      })
    } else if (action.operation === 'update' && action.id) {
      if (!adapter.updateCraftMemory) throw new Error('StorageAdapter does not implement updateCraftMemory')
      await adapter.updateCraftMemory(action.id, action.params as Partial<Memory>)
    } else if (action.operation === 'delete' && action.id) {
      if (!adapter.deleteCraftMemory) throw new Error('StorageAdapter does not implement deleteCraftMemory')
      await adapter.deleteCraftMemory(action.id)
    }
  }
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { Gemini, buildGeminiResponseSchema, buildGeminiActionOnlySchema, resolveFallbackChain } from './providers/gemini.js'
export { zodToGeminiSchema } from './providers/zod-to-gemini.js'
export { PersonaEngine } from './persona.js'
export { parseBrainMarkdown, loadBrainFile, resolvePersonaBrain, getBrainSection, resolvePersonaConfigBrain } from './brain.js'
export { buildSystemPrompt, buildGreetingPrompt, buildPromptedTurnPrompt, buildRetrospectPrompt } from './core/prompt-builder.js'
export { buildIdentityBlock } from './core/identity.js'
export { buildVoiceBlock } from './core/voice.js'
export { buildEQBlock } from './core/eq.js'
export { serializeAllContext, serializeContextBlock } from './core/context.js'
export { selectMemoriesForPrompt, buildMemoryBlock, inferMemoryCategory } from './core/memory.js'
export { buildActionsBlock, buildActionAnnotation, buildAnnotations, annotateMessage, stripActionAnnotations, stripAnnotationsForDisplay, buildPeerAnnotation } from './core/actions.js'
export { PEER_ACTION_NAME, PEER_ACTION_NAMES } from './core/peer-actions.js'
export { shouldGreet, buildGreetingHint } from './core/greeting.js'
export {
  executeSideEffects,
  getProposedActions,
  getExecutedAnnotations,
  buildAssistantHistoryMessage,
  confirmActions,
  summarizeSideEffects,
} from './engine/side-effects.js'
export { resolveActions, resolveEntities, resolveEffectiveConfig } from './core/effective-config.js'
export { buildChatLLMRequest, buildPromptedTurnLLMRequest } from './core/request-builder.js'
export { resolveConversation, loadHistory } from './managed/conversation.js'
export {
  buildAttachmentCarryForwardMessage,
  buildAttachmentCarryForwardSection,
  parseAttachmentCarryForwardMessage,
  collectAttachmentCarryForwardNotes,
} from './core/attachment-notes.js'
export { loadMemories } from './managed/memory-manager.js'
/** @deprecated Legacy exports — memory mutations now use the entity CRUD system. Kept for backward compat. */
export { MEMORY_ACTIONS, MEMORY_ACTION_NAMES, buildMemoryActions, CRAFT_MEMORY_ACTIONS, CRAFT_MEMORY_ACTION_NAMES, buildCraftMemoryActions } from './core/memory-actions.js'
export { buildMemoryEntityConfig, buildCraftMemoryEntityConfig } from './core/memory-actions.js'
export { buildFocusContextInputs, renderFocusWorkItem } from './core/focus-context.js'
export type { FocusContextInputLabels, FocusWorkItem } from './core/focus-context.js'
export {
  ENTER_FOCUS_MODE_ACTION_NAME,
  UPDATE_FOCUS_WORK_ITEM_ACTION_NAME,
  RETURN_TO_SESSION_ACTION_NAME,
  FOCUS_MODE_ACTIONS,
  buildFocusActionSets,
  enterFocusModeAction,
  enterFocusModeOutcomeNote,
  isEnterFocusModeAction,
  updateFocusWorkItemAction,
  updateFocusWorkItemOutcomeNote,
  isUpdateFocusWorkItemAction,
  returnToSessionAction,
  returnToSessionOutcomeNote,
  isReturnToSessionAction,
} from './core/focus-mode-actions.js'
export { resolveAddressedParticipantId, resolveSessionRecipientId } from './core/session-routing.js'
export type { AddressedParticipantInput, SessionRecipientInput } from './core/session-routing.js'
/** Advanced: defineEntity() and crud() for manual entity CRUD wiring. Most apps use `entities` on PersonaConfig instead. */
export { defineEntity, crud } from './core/entities.js'
export { buildEntityRegistry } from './core/entity-registry.js'
export { buildEntitiesBlock } from './core/crud-prompt.js'
export { buildCrudActionsSchema } from './core/crud-schema.js'
export { validateCrudActions, crudActionToAnnotation, resolveTempIds, separateCrudActions, validateAndTraceCrud, commitCrud } from './engine/crud.js'
export type { CrudEntityHandler, CrudCommitResult } from './engine/crud.js'
export {
  buildAssistantContinuityMessage,
  buildOutcomeNoteFromActionOutcome,
  collectOutcomeNotes,
  compactActionForHistory,
  compactActionSummary,
  compactValueForHistory,
  prepareTurnLedgerChatTurn,
  renderTurnLedgerEntryForModel,
  renderTurnLedgerForDisplay,
  renderTurnLedgerForModel,
} from './engine/continuity.js'
export type {
  BuildAssistantContinuityMessageInput,
  ContinuityActionOutcome,
  PrepareTurnLedgerChatTurnOptions,
  PreparedTurnLedgerChatTurn,
  RenderTurnLedgerOptions,
} from './engine/continuity.js'
export { parseActionName, actionLabel, getActionDisplayTitle, isEntityAction } from './core/entity-helpers.js'
export { reviewMemories, compactMemories } from './managed/memory-review.js'
export { runAutonomousLoop } from './managed/autonomous-loop.js'
export type {
  AutonomousLoopHooks,
  AutonomousLoopResult,
  BuiltChatRequest,
  LoopFinish,
  LoopState,
  LoopToolResult,
  LoopTurnContext,
  LoopTurnRecord,
  PersonaSource,
  RunAutonomousLoopInput,
} from './managed/autonomous-loop.js'
export { createBatch, updateActionStatus, editActionParams, commitBatch, summarizeBatch } from './engine/staging.js'
export {
  applyActionsToWorkingSet,
  buildWorkingSetSection,
  commitWorkingSet,
  reviewWorkingSetDelta,
  summarizeWorkingSet,
  usesWorkingSet,
} from './engine/working-set.js'
export {
  runEvalConversation,
  auditBrainBloat,
  auditOperationalPromptContract,
  auditPromptContent,
  auditCrossLayerDuplicates,
  auditActionContracts,
  auditBrainPrescriptions,
  auditEntityVisibility,
  judgeEvalTurn,
  judgeEvalConversation,
  judgePairwiseConversations,
  SAMPLE_PROJECTS,
} from './evals/index.js'
export {
  COACH_TEMPLATE,
  NUTRITION_TEMPLATE,
  FITNESS_TEMPLATE,
  LANGUAGE_TUTOR_TEMPLATE,
  CHIEF_OF_STAFF_TEMPLATE,
} from './playbook/templates.js'
export { auditPrompt } from './audit/prompt-audit.js'
export { auditConversation } from './audit/conversation-audit.js'
export { auditByBrainReflection } from './audit/brain-reflection.js'
export { configVersion } from './audit/version.js'
export {
  auditPersona,
  formatAuditReport,
  printAuditReport,
} from './audit/audit-persona.js'
export type {
  AuditPersonaInput,
  AuditPersonaResult,
  AuditFinding,
  AuditScope,
  AuditSeverity,
  LoadBearingInvariantsResult,
  ContextInputIntentAuditResult,
  FormatAuditReportOptions,
  PrintAuditReportOptions,
} from './audit/audit-persona.js'
export {
  dumpPromptForReview,
  createPromptTraceRecorder,
  formatAsArtifact,
} from './audit/prompt-dump.js'
export type {
  DumpedPrompt,
  DumpPromptOptions,
  PromptTraceRecorder,
  PromptTraceRecorderOptions,
} from './audit/prompt-dump.js'
export { auditTraceIntegrity } from './audit/trace-integrity.js'
export type { TraceIntegrityResult } from './audit/trace-integrity.js'
export {
  JUDGMENT_OVER_LITERALISM_NUDGE,
  PRECEDENCE_OF_SIGNALS_NUDGE,
  MATCH_MESSAGE_TO_ACTIONS_NUDGE,
  ACTION_RESULTS_ARE_WORLD_STATE_NUDGE,
  MEMORY_SELF_BOX_WARNING,
  CONTEXTHINT_CAPTURES_THE_WHY,
  EXPERT_AUTONOMY_NUDGE,
  LOAD_BEARING_INVARIANTS,
} from './playbook/invariants.js'
export type { LoadBearingInvariant } from './playbook/invariants.js'
export type {
  BrainReflectionInput,
  BrainReflectionResult,
  BrainReflectionFinding,
} from './audit/brain-reflection.js'
export { createMarkdownKnowledgeAdapter } from './managed/knowledge.js'

// Types
export type {
  PersonaConfig,
  PersonaIdentity,
  PersonaBrain,
  BrainFileReference,
  BrainMarkdownReference,
  LoadedBrainArtifact,
  VoiceConfig,
  VoiceTone,
  VoiceStyle,
  VoiceMedium,
  ActionDefinition,
  ActionConfidence,
  ActionLayer,
  ContextInputDefinition,
  ContextFormat,
  EQConfig,
  Memory,
  KnowledgeDocument,
  KnowledgeConfig,
  KnowledgeSearchInput,
  KnowledgeAdapter,
  MemoryConfig,
  CraftMemoryConfig,
  DiagnosticsConfig,
  ApprovalConfig,
  StagingConfig,
  StagingModel,
  Message,
  Conversation,
  ChatInput,
  ChatResult,
  TurnLedgerActionOutcome,
  TurnLedgerEntry,
  RetrospectResult,
  ParsedAction,
  ManagedChatInput,
  ManagedPromptedTurnInput,
  ManagedRetrospectInput,
  ManagedGreetingInput,
  PromptedTurnPromptInput,
  RetrospectPromptInput,
  PromptedTurnInput,
  RetrospectInput,
  GreetingInput,
  StorageAdapter,
  EntityConfig,
  CrudAction,
  ChatAttachment,
  LLMProvider,
  LLMProviderRequest,
  LLMProviderResponse,
  StagedBatch,
  StagedAction,
  StagedActionStatus,
  BatchSummary,
  WorkingDelta,
  WorkingSet,
  WorkingSetSummary,
  WorkingDeltaReviewState,
  WorkingDeltaCommitState,
  WorkingSetReviewDecision,
  TurnTrace,
  TracedAction,
  TracedCrudAction,
  TracedDomainAction,
  CrudValidationFn,
  PeerConfig,
  PeerConsultation,
} from './types.js'
export type { BatchCommitResult } from './engine/staging.js'
export type { WorkingSetCommitResult } from './engine/working-set.js'
export type { ReviewWorkingSetDeltaInput } from './engine/working-set.js'
export type {
  SideEffectHandler,
  SideEffectHandlerResult,
  SideEffectResult,
  SideEffectOutcome,
  SideEffectOutcomeStatus,
  ProposedAction,
  ExecuteSideEffectsOptions,
} from './engine/side-effects.js'
export type { GeminiConfig } from './providers/gemini.js'
export type { MemoryBlockOptions } from './core/memory.js'
export type {
  BrainBloatAuditInput,
  BrainBloatAuditIssue,
  BrainBloatAuditOptions,
  BrainBloatAuditResult,
  BrainBloatSectionMetric,
  EntityVisibilityAuditInput,
  EntityVisibilityIssue,
  EntityVisibilityResult,
  EvalState,
  EvalProject,
  EvalTurn,
  EvalTurnResult,
  EvalConversationResult,
  EvalActionRecord,
  EvalJudgeScenario,
  EvalJudgeCriterionScore,
  EvalJudgeVerdict,
  EvalPairwiseVerdict,
  CrudHandler,
} from './evals/index.js'
export type {
  EntityDefinitionInput,
  EntityDefinitionResult,
  EntityOperationConfig,
} from './core/entities.js'
export type { EntityRegistry, EntityRegistryEntry } from './core/entity-registry.js'
export type {
  MemoryReviewOptions,
  MemoryReviewResult,
  CompactMemoriesOptions,
  CompactMemoriesResult,
} from './managed/memory-review.js'
export type { MarkdownKnowledgeAdapterOptions } from './managed/knowledge.js'
export type {
  AuditInput,
  AuditResult,
  PromptAuditInput,
  PromptAuditResult,
  PromptAuditFailure,
  ConversationAuditInput,
  ConversationAuditResult,
  ConversationAuditFailure,
} from './audit/types.js'

// ─── Builder: coder-persona primitives ──────────────────────────────────────
// Action contracts for building code-writing agent personas. Pick from the
// `coderActions` dictionary. Implementations (Sandbox + BrowserHarness) land
// in follow-up promotion steps.
export {
  coderActions,
  readFileAction,
  applyPatchAction,
  writeFileAction,
  editFileAction,
  deleteFileAction,
  listFilesAction,
  searchInFilesAction,
  runInstallAction,
  runBuildAction,
  runTestsAction,
  runLintAction,
  runStartAction,
  runCommandAction,
  browserOpenAction,
  browserScreenshotAction,
  browserClickAction,
  browserTypeAction,
  browserKeyAction,
  browserConsoleAction,
  finishAttemptAction,
} from './builder/actions.js'
export type { CoderActionName } from './builder/actions.js'

// Builder runtime implementations are available from `archetype/builder`.
// The root entrypoint intentionally keeps Node/browser side-effect modules
// out of ordinary chat/memory consumers.
export type {
  Sandbox,
  SandboxCallOptions,
  SandboxSpawnOptions,
  SandboxExecResult,
  SandboxSpawnResult,
  SandboxRuntimeConfig,
  SrtSandboxOptions,
} from './builder/sandbox.js'

// Browser primitive types. The Playwright-backed implementation is available
// from `archetype/builder`; keeping the value export off the root entrypoint
// prevents ordinary chat/memory consumers from bundling optional browser deps.
export type {
  BrowserHarness,
  BrowserOpenResult,
  BrowserScreenshotResult,
  BrowserClickResult,
  BrowserTypeResult,
  BrowserKeyResult,
  BrowserConsoleEntry,
  PlaywrightBrowserOptions,
} from './builder/browser.js'

export type {
  ListWorkspaceFileEntriesOptions,
  WorkspaceFileEntry,
  WorkspaceMount,
  ResolvedWorkspaceMountPath,
} from './builder/workspace-files.js'
export {
  filterNodeTestFilePaths,
  isNodeTestFilePath,
} from './builder/node-test-discovery.js'
export type {
  CoderSandbox,
  CoderSandboxToolName,
  CoderSandboxToolResult,
  CoderExecutorContext,
  CoderActionResult,
  CoderActionKind,
  CoderActionExecution,
  CoderActionAttachment,
  CoderActionContinuity,
} from './builder/executor.js'

export {
  makeWorkHistoryEntry,
  renderWorkHistoryEntries,
  renderWorkHistoryEntry,
} from './managed/work-history.js'
export type {
  WorkHistoryEntry,
  WorkHistorySource,
  RenderWorkHistoryOptions,
} from './managed/work-history.js'

export {
  createPmSpecPersonaConfig,
  createPmSpecWorkItem,
  pmSpecContextInputs,
} from './samples/pm-spec-agent.js'
export type { PmSpecPersonaOptions } from './samples/pm-spec-agent.js'

// ─── Observability ──────────────────────────────────────────────────
// Shared telemetry: onTurn reporter (errors.jsonl + diagnostics.md)
// and a pure render-run-markdown renderer every autonomous-loop
// consumer can reuse.
export { createTurnReporter } from './observability/turn-reporter.js'
export type { TurnReporterOptions, TurnReporterHook } from './observability/turn-reporter.js'
export {
  renderRunMarkdown,
  tryParseAssistantPayload,
  summarizeAction,
} from './observability/render-run-markdown.js'
export type {
  RenderRunMarkdownInput,
  HistoryEntry,
  TracePacket,
  AssistantAction,
  AssistantPayload,
  RunErrorEntry,
  RunScoreSummary,
} from './observability/render-run-markdown.js'
