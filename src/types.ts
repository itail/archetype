import type { z } from 'zod'

// ─── Peer Consultation ─────────────────────────────────────────────────────

/** Configuration for a peer persona that this persona can consult mid-turn */
export interface PeerConfig {
  /** The peer persona — any object with a chat() method (managed or raw engine wrapper) */
  persona: { chat: (input: ManagedChatInput | ChatInput) => Promise<ChatResult & { conversationId?: string }> }
  /** Build context for the peer based on the consulting persona's query and current context */
  contextBuilder: (query: string, parentContext: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Human-readable description of what this peer does (injected into consultPeer action description) */
  expertise?: string
  /** Resolve which conversation to use for the peer (default: auto from peer's adapter) */
  conversationResolver?: () => Promise<string | undefined>
}

/** Record of a single peer consultation that occurred mid-turn */
export interface PeerConsultation {
  peer: string
  query: string
  response: string
  trace: TurnTrace
  durationMs: number
}

// ─── TurnTrace ──────────────────────────────────────────────────────────────

/** Trace of a single action through the validation pipeline */
export interface TracedAction {
  name: string
  params: Record<string, unknown>
  status: 'valid' | 'invalid' | 'repaired' | 'unknown_action'
  error?: string
}

/** Trace of a single CRUD action through validation and execution */
export interface TracedCrudAction {
  operation: 'create' | 'update' | 'delete'
  entity: string
  id?: string
  params: Record<string, unknown>
  status: 'valid' | 'invalid' | 'executed' | 'failed'
  error?: string
}

/** Trace of a domain action executed by app code */
export interface TracedDomainAction {
  name: string
  params: Record<string, unknown>
  status: 'executed' | 'failed' | 'skipped'
  error?: string
  durationMs?: number
}

/**
 * Structured trace of a single turn through the Archetype pipeline.
 * Built incrementally: Layer 1 (parse/validate) fills parse + validation fields,
 * Layer 2 (managed mode) fills execution fields, app code fills domainActions.
 *
 * Always present on ChatResult — structural, not opt-in.
 */
export interface TurnTrace {
  traceId: string
  /** Which persona generated this trace */
  personaId?: string
  /** Links traces across personas in one user interaction */
  correlationId?: string
  /** Provider/model that actually produced this turn. */
  provider?: {
    name: string
    requestedModel?: string
    model?: string
  }
  startedAt: number
  completedAt?: number

  // Layer 1: Parse & Validate
  parseOk: boolean
  repairAttempted: boolean
  repairSucceeded?: boolean
  actions: TracedAction[]
  crudActions: TracedCrudAction[]

  // Layer 2: Execution
  executionResults: TracedCrudAction[]
  domainActions: TracedDomainAction[]

  /** Peer consultations that occurred mid-turn */
  peerConsultations?: PeerConsultation[]

  /** AI-written outcome notes (human-readable, for admin display) */
  outcomeNotes: string[]

  /** Errors from the SDK pipeline and app-level domain validation. Both push here. */
  errors: string[]
}

// ─── Entity CRUD ────────────────────────────────────────────────────────────

export interface EntityConfig {
  /** Zod schema for entity fields */
  schema: z.ZodType
  /** Human-readable name (e.g., "Thread", "Forcing Function"). Defaults to capitalize(key). */
  label?: string
  /** Which field to use as display title in annotations */
  displayField?: string
  /** Description of what this entity represents — helps the AI understand when to create/update/delete */
  description?: string
  /**
   * When true, only `create` is expected for this entity — no update/delete.
   * The entity-visibility audit skips the "must be visible in context with id"
   * check since there is nothing to update or delete.
   * Shorthand for `operations: ['create']`.
   */
  createOnly?: boolean
  /**
   * The operations the host app actually implements for this entity.
   * The prompt only advertises these, and validation rejects the rest —
   * so the model can't be led into mutations that would fail at commit.
   * Defaults to all three (or to ['create'] when createOnly is set).
   */
  operations?: ReadonlyArray<'create' | 'update' | 'delete'>
}

export interface CrudAction {
  operation: 'create' | 'update' | 'delete'
  entity: string
  id?: string       // required for update/delete
  params?: Record<string, unknown>  // required for create, optional for update
}

// ─── Identity ────────────────────────────────────────────────────────────────

export interface PersonaIdentity {
  /** Display name of the persona (e.g. "Coach", "Guide") */
  name: string
  /** Domain expertise areas the persona weaves together */
  expertise: string[]
  /** Relationship descriptor (e.g. "trusted thinking partner", "warm companion") */
  relationship: string
  /** What this persona ultimately serves */
  northStar: string
  /** Optional, minimal boundary. Use sparingly; omit unless truly load-bearing. */
  scopeBoundary?: string
  /**
   * The keystone instruction — "What is the single most impactful thing
   * you could say right now?" Customizable per domain.
   */
  keystone?: string
}

// ─── Prompt Scaffold ────────────────────────────────────────────────────────

export interface PromptScaffoldConfig {
  /**
   * Optional relationship/presence hook appended to the identity block.
   * Set to false to omit it entirely, or provide a custom string.
   */
  relationalPreamble?: string | false
  /**
   * Optional momentum block appended near the end of the prompt.
   * Set to false to omit it entirely, or provide a custom string.
   */
  momentumBlock?: string | false
  /**
   * Optional come-back test appended near the end of the prompt.
   * Set to false to omit it entirely, or provide a custom string.
   */
  comeBackTest?: string | false
}

export type PromptMode = 'conversation' | 'operational' | 'focus'
export type PromptedTurnKind = 'operational' | 'proactive-conversation'
export type PromptOrigin = 'user' | 'app'
export type PromptContractStyle = 'full' | 'lean'

// ─── Brains ────────────────────────────────────────────────────────────────

export interface BrainFileReference {
  source: 'file'
  path: string
}

export interface BrainMarkdownReference {
  source: 'markdown'
  markdown: string
  path?: string
}

export interface LoadedBrainArtifact {
  source: 'loaded'
  markdown: string
  metadata: Record<string, string>
  sections: Record<string, string>
  sourcePath?: string
}

export type PersonaBrain = BrainFileReference | BrainMarkdownReference | LoadedBrainArtifact

// ─── Voice ───────────────────────────────────────────────────────────────────

export type VoiceTone = 'direct' | 'warm' | 'balanced'
export type VoiceStyle = 'educator' | 'quick'
export type VoiceMedium = 'mobile-chat' | 'desktop-panel' | 'email-async'

export interface VoiceConfig {
  tone: VoiceTone
  style: VoiceStyle
  medium?: VoiceMedium
  /** Custom formatting instructions (markdown, emoji, etc.) — appended to voice block */
  formatting?: string
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type ActionConfidence = 'low' | 'medium' | 'high'
export type ActionLayer = 'meaning' | 'transport'
export type WorkingDeltaReviewState = 'accepted' | 'pending' | 'rejected' | 'superseded'
export type WorkingDeltaCommitState = 'not_required' | 'ready' | 'committed' | 'failed'
export type WorkingSetReviewDecision = 'accept' | 'reject'
export type StagingModel = 'legacy-batch' | 'working-set'

export interface ActionDefinition {
  /** Behavioral description — this IS a prompt (guides when to use) */
  description: string
  /** Zod schema for the action's parameters */
  schema: z.ZodType
  /** Optional model-facing example params when schema-derived examples would be misleading. */
  exampleParams?: unknown
  /** Confidence threshold: low = just do it, medium = mention, high = confirm */
  confidence: ActionConfidence
  /** Meaning-layer deltas become the current draft; transport-layer deltas require commit */
  layer?: ActionLayer
  /** Default working-set review state when this action is staged */
  defaultReviewState?: Extract<WorkingDeltaReviewState, 'accepted' | 'pending'>
  /** Commit behavior when this action is staged */
  commitMode?: WorkingDeltaCommitState | 'explicit' | 'immediate'
  /** Optional identity for supersession; same target replaces the prior accepted delta */
  targetKey?: (validatedParams: Record<string, unknown>) => string | null
}

// ─── Context Inputs ──────────────────────────────────────────────────────────

export type ContextFormat = 'list' | 'block' | 'kv'

export interface ContextInputDefinition {
  /** Label shown in the prompt (e.g. "OPEN THREADS") */
  label: string
  /** One-line explanation of what this block is for and how the model should use it. */
  intent?: string
  /** How to format the data */
  format?: ContextFormat
  /** Character budget for this block (memory uses this) */
  budget?: number
  /** Priority strategy for budget-constrained blocks */
  prioritize?: 'pinned-first' | 'recent-first'
  /** Priority level — 'critical' items get emphasized in prompt */
  priority?: 'normal' | 'critical'
  /** When true, include entity IDs in the prompt for AI-driven update/delete */
  includeIds?: boolean
}

// ─── EQ ──────────────────────────────────────────────────────────────────────

export interface EQConfig {
  /** Continuity: trust what already landed and look for the next layer unless repetition is genuinely needed */
  frequencyRule?: boolean
  /** Autonomy respect: let the user lead, don't over-prescribe */
  autonomyRespect?: boolean
  /** Qualitative first: default to qualitative language, give numbers when asked */
  qualitativeFirst?: boolean
  /** Coherence: flag contradictions with earlier statements, lead with the shift */
  coherence?: boolean
  /** Expert judgment: own the responsibility of expert recommendations, don't fill gaps with assumptions */
  expertJudgment?: boolean
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface Memory {
  id: string
  content: string
  category: string
  pinned?: boolean
  createdAt?: string
  /** Memory scope: 'user' for user-specific, 'craft' for professional growth */
  scope?: 'user' | 'craft'
  /** Where this memory came from: user-stated, agent-inferred, or agent-suggested */
  source?: 'user' | 'inferred' | 'suggested'
  /** Time horizon: 'durable' for reliable truths, 'tentative' for still-forming patterns, 'temporary' for situation-bound facts. */
  stability?: 'durable' | 'tentative' | 'temporary'
  /** Compact situational frame when the memory needs just enough context to stay interpretable */
  contextHint?: string
}

export interface MemoryConfig {
  /** Enable memory prompt injection + extraction (default: true when present) */
  enabled?: boolean
  /** Include memory IDs in prompt so AI can reference them for update/delete */
  includeIds?: boolean
  /** Character budget for memory block in prompt */
  budget?: number
  /**
   * Domain-specific memory categories with descriptions.
   * Keys are category names, values are human-readable descriptions.
   * Injected into saveMemory action description and retrospective prompts
   * so the LLM categorizes memories using domain-aware language.
   *
   * Example: { preference: 'Dietary preferences, food likes/dislikes', routine: 'Eating patterns, meal timing' }
   */
  categories?: Record<string, string>
  /**
   * Explain what this persona's memory is for across future conversations.
   * This should paint the horizon and intent, not prescribe brittle extraction rules.
   */
  purpose?: string
}

// ─── Knowledge ──────────────────────────────────────────────────────────────

export interface KnowledgeDocument {
  id: string
  title: string
  content: string
  summary?: string
  tags?: string[]
  status?: 'approved' | 'provisional' | 'draft' | 'archived'
  updatedAt?: string
  path?: string
}

export interface KnowledgeConfig {
  /** Enable knowledge prompt injection when knowledge documents are provided */
  enabled?: boolean
  /** Character budget for the knowledge block in prompt */
  budget?: number
  /** Soft cap on retrieved documents for one turn */
  maxDocuments?: number
  /** Optional prompt label override */
  label?: string
  /** Explain what this persona should use shared knowledge for */
  purpose?: string
}

export interface KnowledgeSearchInput {
  query: string
  budget?: number
  maxDocuments?: number
}

export interface KnowledgeAdapter {
  searchDocuments(input: KnowledgeSearchInput): Promise<KnowledgeDocument[]>
  getDocument?(id: string): Promise<KnowledgeDocument | null>
}

// ─── Craft Memory ───────────────────────────────────────────────────────────

export interface CraftMemoryConfig {
  /** Enable craft memory — professional growth observations scoped to the persona */
  enabled?: boolean
  /** Character budget for craft memory block in prompt (default: 3000) */
  budget?: number
  /** Domain-specific categories for craft observations */
  categories?: Record<string, string>
  /** Explain what craft memory captures for this persona */
  purpose?: string
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export interface DiagnosticsConfig {
  /** Enable the diagnostics channel — surfaces setup tensions to the developer */
  enabled?: boolean
}

// ─── Approval ────────────────────────────────────────────────────────────────

export interface ApprovalConfig {
  /**
   * 'propose' — AI proposes actions, user confirms before execution.
   * 'yolo' — actions execute immediately (current default behavior).
   *
   * ActionConfidence interacts with mode:
   * - 'low' always auto-executes (even in propose mode)
   * - 'medium' follows the mode setting
   * - 'high' always proposes (even in yolo mode)
   */
  mode: 'propose' | 'yolo'
}

export interface StagingConfig {
  /** Legacy batch review or working-set semantics */
  model?: StagingModel
}

// ─── Staging ────────────────────────────────────────────────────────────────

export type StagedActionStatus = 'pending' | 'accepted' | 'rejected'

export interface StagedAction {
  index: number
  action: ParsedAction
  validatedParams: Record<string, unknown>
  annotation: string
  status: StagedActionStatus
}

export interface StagedBatch {
  id: string
  actions: StagedAction[]
  createdAt: string
}

export interface BatchSummary {
  total: number
  accepted: number
  rejected: number
  pending: number
  acceptedLabels: string[]
  rejectedLabels: string[]
}

export interface WorkingDelta {
  id: string
  action: ParsedAction
  validatedParams: Record<string, unknown>
  annotation: string
  layer: ActionLayer
  reviewState: WorkingDeltaReviewState
  commitState: WorkingDeltaCommitState
  targetKey?: string | null
  supersedes?: string
  createdAt: string
  updatedAt: string
  error?: string
}

export interface WorkingSet {
  id: string
  deltas: WorkingDelta[]
  createdAt: string
  updatedAt: string
}

export interface WorkingSetSummary {
  total: number
  accepted: number
  pending: number
  rejected: number
  superseded: number
  ready: number
  committed: number
  failed: number
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Stringified JSON of actions taken (for annotation in history) */
  actionsJson?: string | null
  /** Whether this is a note/divider (not sent to LLM) */
  isNote?: boolean
  /** App-specific metadata (e.g. userId, mealId). Carried through by the SDK, not interpreted. */
  metadata?: Record<string, unknown>
  createdAt?: string
}

// ─── Conversation ────────────────────────────────────────────────────────────

export interface Conversation {
  id: string
  trigger: string
  metadata?: Record<string, unknown>
  createdAt: string
  endedAt?: string | null
}

// ─── Persona Config ──────────────────────────────────────────────────────────

export interface PersonaConfig {
  identity: PersonaIdentity
  voice: VoiceConfig
  /** Optional portable role brain loaded from markdown. */
  brain?: PersonaBrain
  /** Optional prompt scaffold overrides for identity/playbook framing. */
  promptScaffold?: PromptScaffoldConfig

  /** Domain-specific methodology — locked, not user-editable */
  methodology?: string
  /** Personal directives — editable by the user */
  directives?: { default: string; editable?: boolean }

  /** First-meeting scene — paints the situation for discovery, no prescriptions */
  discovery?: string

  /** Entity definitions — each entity gets full CRUD (create/update/delete) automatically */
  entities?: Record<string, EntityConfig>
  /** Structured actions the persona can take */
  actions?: Record<string, ActionDefinition>
  /** Context inputs injected into the system prompt */
  contextInputs?: Record<string, ContextInputDefinition>
  /** EQ configuration */
  eq?: EQConfig
  /** Memory configuration — controls extraction, CRUD, and prompt injection */
  memory?: MemoryConfig
  /** Queryable durable reference material — capabilities, posture, policies, docs */
  knowledge?: KnowledgeConfig
  /** Craft memory — professional growth observations scoped to the persona, not the user */
  craftMemory?: CraftMemoryConfig
  /** Diagnostics channel — surfaces setup tensions to the developer */
  diagnostics?: DiagnosticsConfig

  /** Approval model for side-effect execution */
  approval?: ApprovalConfig
  /** Staging model for multi-turn working drafts */
  staging?: StagingConfig

  /** LLM provider to use */
  provider: LLMProvider

  /** Override description for the followUps field in the response schema */
  followUpsDescription?: string
}

// ─── Multimodal ─────────────────────────────────────────────────────────────

export interface ChatAttachment {
  type: 'image'
  mimeType: string   // "image/jpeg", "image/png", "image/webp"
  data: string       // base64-encoded
}

export interface ChatParticipant {
  /** Stable id used by ledgers/apps, e.g. "pm", "builder", "user". */
  id: string
  /** Human-readable participant label shown to the model. */
  label: string
  /** Compact factual role in this interaction. */
  description?: string
}

export interface ChatSessionFrame {
  /** Stable actor id for the persona producing this turn. */
  actorId?: string
  /** Where this turn's visible message will land. */
  visibleTo?: string
  /** Other relevant participants in this interaction. */
  participants?: ChatParticipant[]
  /** Compact factual reason this interaction exists. */
  purpose?: string
}

// ─── Chat Input / Output ─────────────────────────────────────────────────────

/** Pre-commit validation for CRUD proposals. Return error strings to reject, null to accept. */
export type CrudValidationFn = (actions: CrudAction[]) => string[] | null

export interface ChatInput {
  /** The user's message */
  message: string
  /** Conversation history (legacy app-managed path). Prefer turnLedger when turns have action outcomes. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * Archetype-owned turn ledger. When provided, Archetype renders model
   * history from visible messages plus hidden factual outcomes, so apps do
   * not have to manually stitch action results into chat history.
   */
  turnLedger?: TurnLedgerEntry[]
  /** Actor id/name of the persona making this call; used to map ledger turns to assistant/user roles. */
  turnLedgerActorId?: string
  /** Current turn number for rendering time-decaying turn-ledger action results. */
  turnLedgerCurrentTurn?: number
  /** Context data keyed by contextInput name */
  context?: Record<string, unknown>
  /** Which persona is making this call (for trace correlation) */
  personaId?: string
  /** Links traces across personas in one user interaction */
  correlationId?: string
  /** Memories to inject */
  memories?: Memory[]
  /** Durable knowledge documents to inject */
  knowledgeDocuments?: KnowledgeDocument[]
  /** Craft memories (persona-scoped professional growth) */
  craftMemories?: Memory[]
  /** User's timezone (IANA) */
  timezone?: string
  /** Optional explicit timestamp for prompt rendering and deterministic reviews */
  promptNow?: Date | string
  /** Override directives for this call */
  directives?: string | null
  /** Additional system prompt sections */
  extraSystemSections?: string[]
  /** Final system prompt sections appended after the standard close. */
  tailSystemSections?: string[]
  /** Which prompt scaffold to use for this turn. */
  promptMode?: PromptMode
  /** Whether this turn was initiated by a person or by the app/runtime. */
  promptOrigin?: PromptOrigin
  /** Optional per-turn prompt scaffold overrides. */
  promptScaffold?: PromptScaffoldConfig
  /** User identity string (e.g. "Alex, CEO of Acme") */
  userIdentity?: string
  /** Last message timestamp — for greeting/staleness detection */
  lastMessageAt?: Date | null
  /** Multimodal attachments (e.g. images) */
  attachments?: ChatAttachment[]
  /** Archetype-rendered interaction frame: who is speaking, who can see the message, and why this session exists. */
  session?: ChatSessionFrame
  /** Locale code (e.g. 'he', 'en') — injected as language instruction in prompt */
  locale?: string
  /** Current conversation-scoped working set for stateless integrations */
  workingSet?: WorkingSet | null
  /** Prompt-facing action/entity contract verbosity. */
  contractStyle?: PromptContractStyle
  /** Pre-commit CRUD validation. If provided, the SDK validates proposals and retries once on failure. */
  crudValidation?: CrudValidationFn
  /** Max CRUD validation retries (default: 1) */
  crudValidationRetries?: number
}

export interface ParsedAction {
  name: string
  params: Record<string, unknown>
  confidence: ActionConfidence
}

export interface TurnLedgerActionOutcome {
  /** Executor metadata used to build compact narration; do not raw-dump params into model continuity. */
  action?: Pick<ParsedAction, 'name' | 'params'>
  /** Factual note shown to future model turns. */
  outcomeNote?: string | null
  /** Full result text shown while the outcome is still fresh. */
  resultText?: string | null
  /** Number of future turns that should continue seeing resultText. */
  resultTurns?: number
  /** Replacement text after resultText ages out. */
  staleText?: string | null
  /** Short raw result fallback. Large payloads should not be placed here. */
  text?: string | null
  status?: string
  success?: boolean
  error?: string
  annotation?: string
}

export interface TurnLedgerEntry {
  /** Monotonic turn number used to age action outcomes. */
  turn?: number
  /** Stable actor id/name, e.g. "pm", "builder", "user". */
  actorId?: string
  /** Fallback role when no perspective actor is available. */
  role?: 'user' | 'assistant'
  /** User-visible text for this turn. */
  message: string
  /** AI-written outcome notes from the model response. */
  outcomeNotes?: string[]
  /** Executor/action outcomes. Archetype renders these into hidden model continuity. */
  actionOutcomes?: TurnLedgerActionOutcome[]
  /** Debug/UI action annotations. Stripped before future model turns. */
  actionAnnotations?: string[]
  /** Compact function-call references for native function-calling history. */
  actionsForHistory?: Array<Pick<ParsedAction, 'name' | 'params'>>
}

export interface ChatResult {
  /** The persona's conversational response */
  message: string
  /** Structured actions proposed/taken */
  actions: ParsedAction[]
  /** CRUD actions on declared entities */
  crudActions?: CrudAction[]
  /** Optional compact carry-forward notes about uploaded attachments */
  attachmentNotes?: string[]
  /** Follow-up suggestions */
  followUps?: string[]
  /** Action annotations for history storage */
  annotations?: string[]
  /** Raw LLM response (for debugging) */
  raw?: string
  /** Updated working set when staging.model = 'working-set' */
  workingSet?: WorkingSet
  /** Summary counts for the working set */
  workingSetSummary?: WorkingSetSummary
  /** Diagnostics surfaced by the AI about setup tensions (developer-facing) */
  diagnostics?: string[]
  /** AI-written outcome notes for history awareness (injected as ---outcomes: marker) */
  outcomeNotes?: string[]
  /** Pipeline trace for this turn — always present */
  trace: TurnTrace
}

export interface RetrospectActionResult {
  name: string
  status: 'executed' | 'proposed' | 'failed' | 'no_op'
  error?: string
}

export interface RetrospectResult {
  /** @deprecated Legacy action-based memory mutations. Use crudActions instead. */
  actions: ParsedAction[]
  /** Memory CRUD actions inferred from recent behavior */
  crudActions?: CrudAction[]
  /** Managed mode may attach execution outcomes */
  results?: RetrospectActionResult[]
  /** Raw LLM response (for debugging) */
  raw?: string
  /** Diagnostics surfaced by the AI about setup tensions (developer-facing) */
  diagnostics?: string[]
  /** Pipeline trace for this turn — always present */
  trace: TurnTrace
}

// ─── LLM Provider ────────────────────────────────────────────────────────────

export interface LLMProviderRequest {
  systemPrompt: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  message: string
  responseSchema?: Record<string, unknown>
  temperature?: number
  /** Multimodal attachments (e.g. images) */
  attachments?: ChatAttachment[]
}

export interface LLMProviderResponse {
  text: string
  /** Actual model that returned this response, when the provider exposes it. */
  model?: string
  /** Requested primary model, when different from the provider name or useful for fallback traces. */
  requestedModel?: string
}

export interface LLMProvider {
  name: string
  /**
   * How assistant history should be transported back into the provider on
   * future turns. Most providers consume plain text history. Providers that
   * reconstruct native tool/function-call parts from assistant history can
   * opt into compact JSON transport.
   */
  historyTransport?: 'text' | 'compact-function-calls'
  chat(request: LLMProviderRequest): Promise<LLMProviderResponse>
}

// ─── Managed Mode ────────────────────────────────────────────────────────────

export interface ManagedChatInput {
  message: string
  conversationId?: string | null
  context?: Record<string, unknown>
  /** Which persona is making this call (for trace correlation) */
  personaId?: string
  /** Links traces across personas in one user interaction */
  correlationId?: string
  timezone?: string
  promptNow?: Date | string
  directives?: string | null
  extraSystemSections?: string[]
  knowledgeDocuments?: KnowledgeDocument[]
  promptMode?: PromptMode
  promptOrigin?: PromptOrigin
  promptScaffold?: PromptScaffoldConfig
  userIdentity?: string
  trigger?: string
  metadata?: Record<string, unknown>
  /** Locale code (e.g. 'he', 'en') */
  locale?: string
  /** Multimodal attachments (e.g. images) */
  attachments?: ChatAttachment[]
  /** Pre-commit CRUD validation. SDK validates proposals and retries once on failure. */
  crudValidation?: CrudValidationFn
  /** Max CRUD validation retries (default: 1) */
  crudValidationRetries?: number
  /** Prompt-facing action/entity contract verbosity. */
  contractStyle?: PromptContractStyle
  /**
   * Optional app-owned CRUD commit boundary.
   * When provided, managed mode executes non-SDK CRUD actions before saving the
   * assistant message, then stores compact factual outcomes in future history.
   */
  domainCrud?: ManagedDomainCrudConfig
}

// ─── Prompted Turns ─────────────────────────────────────────────────────────

export interface ManagedDomainCrudEntityHandler {
  create?: (id: string, params: Record<string, unknown>) => Promise<ManagedDomainCrudCommitResult>
  update?: (id: string, params: Record<string, unknown>) => Promise<ManagedDomainCrudCommitResult>
  delete?: (id: string) => Promise<ManagedDomainCrudCommitResult>
}

export interface ManagedDomainCrudCommitResult {
  success: boolean
  error?: string
  data?: unknown
}

export interface ManagedDomainCrudSummaryInput {
  actions: CrudAction[]
  results: ManagedDomainCrudCommitResult[]
}

export interface ManagedDomainCrudConfig {
  handlers: Record<string, ManagedDomainCrudEntityHandler>
  /** Optional app-owned normalization before commit, such as deduping or ID repointing. */
  prepare?: (actions: CrudAction[]) => CrudAction[] | Promise<CrudAction[]>
  summarize?: (input: ManagedDomainCrudSummaryInput) => string[] | Promise<string[]>
}

export interface PromptedTurnPromptInput {
  config: PersonaConfig
  input: Pick<ChatInput, 'timezone' | 'promptNow' | 'userIdentity' | 'locale' | 'memories' | 'knowledgeDocuments' | 'craftMemories' | 'context' | 'directives' | 'extraSystemSections' | 'tailSystemSections' | 'promptMode' | 'promptScaffold' | 'workingSet' | 'contractStyle'>
  /** Classifies app-initiated turns that should still read like a conversation */
  turnKind?: PromptedTurnKind
  /** What the app is trying to accomplish with this initiated turn */
  intent: string
  /** Optional short label for debugging and prompt clarity */
  label?: string
  /** App-provided prompted-turn guidelines */
  guidelines?: string
  /** Recent conversation history for continuity */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface RetrospectPromptInput {
  config: PersonaConfig
  input: Pick<ChatInput, 'timezone' | 'promptNow' | 'userIdentity' | 'locale' | 'memories' | 'knowledgeDocuments' | 'craftMemories' | 'context' | 'directives' | 'extraSystemSections' | 'tailSystemSections' | 'promptMode' | 'promptScaffold' | 'workingSet' | 'contractStyle'>
  /** Optional app-provided retrospective guidelines */
  guidelines?: string
  /** Recent conversation history for pattern inference */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface PromptedTurnInput {
  intent: string
  label?: string
  timezone?: string
  promptNow?: Date | string
  userIdentity?: string
  locale?: string
  memories?: Memory[]
  knowledgeDocuments?: KnowledgeDocument[]
  craftMemories?: Memory[]
  context?: Record<string, unknown>
  directives?: string | null
  extraSystemSections?: string[]
  tailSystemSections?: string[]
  turnKind?: PromptedTurnKind
  promptMode?: PromptMode
  promptScaffold?: PromptScaffoldConfig
  contractStyle?: PromptContractStyle
  guidelines?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  workingSet?: WorkingSet | null
  /** Pre-commit CRUD validation. If provided, the SDK validates proposals and retries once on failure. */
  crudValidation?: CrudValidationFn
  /** Max CRUD validation retries (default: 1) */
  crudValidationRetries?: number
}

export interface GreetingInput extends Omit<PromptedTurnInput, 'intent' | 'label' | 'directives'> {}

export interface RetrospectInput {
  timezone?: string
  promptNow?: Date | string
  userIdentity?: string
  locale?: string
  memories?: Memory[]
  knowledgeDocuments?: KnowledgeDocument[]
  craftMemories?: Memory[]
  context?: Record<string, unknown>
  directives?: string | null
  extraSystemSections?: string[]
  tailSystemSections?: string[]
  promptMode?: PromptMode
  promptScaffold?: PromptScaffoldConfig
  contractStyle?: PromptContractStyle
  guidelines?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  workingSet?: WorkingSet | null
}

export interface ManagedPromptedTurnInput {
  intent: string
  label?: string
  conversationId?: string | null
  context?: Record<string, unknown>
  /** Which persona is making this call (for trace correlation) */
  personaId?: string
  /** Links traces across personas in one user interaction */
  correlationId?: string
  timezone?: string
  promptNow?: Date | string
  userIdentity?: string
  locale?: string
  knowledgeDocuments?: KnowledgeDocument[]
  directives?: string | null
  extraSystemSections?: string[]
  turnKind?: PromptedTurnKind
  promptMode?: PromptMode
  contractStyle?: PromptContractStyle
  promptScaffold?: PromptScaffoldConfig
  guidelines?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  trigger?: string
  metadata?: Record<string, unknown>
  /** Pre-commit CRUD validation. SDK validates proposals and retries once on failure. */
  crudValidation?: CrudValidationFn
  /** Max CRUD validation retries (default: 1) */
  crudValidationRetries?: number
  /**
   * Optional app-owned CRUD commit boundary.
   * When provided, managed mode executes non-SDK CRUD actions before saving the
   * assistant message, then stores compact factual outcomes in future history.
   */
  domainCrud?: ManagedDomainCrudConfig
}

export interface ManagedGreetingInput extends Omit<ManagedPromptedTurnInput, 'intent' | 'label' | 'directives'> {}

export interface ManagedRetrospectInput {
  conversationId?: string | null
  context?: Record<string, unknown>
  timezone?: string
  promptNow?: Date | string
  userIdentity?: string
  locale?: string
  knowledgeDocuments?: KnowledgeDocument[]
  directives?: string | null
  extraSystemSections?: string[]
  promptMode?: PromptMode
  promptScaffold?: PromptScaffoldConfig
  guidelines?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface StorageAdapter {
  getActiveConversation(): Promise<Conversation | null>
  createConversation(trigger: string, metadata?: Record<string, unknown>): Promise<string>
  endConversation(id: string): Promise<void>
  getMessages(conversationId: string, limit: number): Promise<Message[]>
  saveMessage(conversationId: string, msg: Omit<Message, 'createdAt'>): Promise<void>
  /**
   * Load a candidate set of memories for prompt injection.
   * `budget` is a soft loading budget, not the final prompt crop. Adapters should
   * avoid doing the last-mile trim too aggressively because Archetype applies the
   * final salience-aware selection itself.
   */
  loadMemories(options: { budget: number; pinnedFirst: boolean }): Promise<Memory[]>
  saveMemory(memory: Omit<Memory, 'id'>): Promise<string>
  updateMemory(id: string, updates: Partial<Memory>): Promise<void>
  deleteMemory(id: string): Promise<void>
  loadWorkingSet?(conversationId: string): Promise<WorkingSet | null>
  saveWorkingSet?(conversationId: string, workingSet: WorkingSet): Promise<void>
  clearWorkingSet?(conversationId: string): Promise<void>
  /** Load craft memories (persona-scoped professional growth). Same soft-budget guidance as loadMemories. */
  loadCraftMemories?(options: { budget: number }): Promise<Memory[]>
  /** Save a craft memory */
  saveCraftMemory?(memory: Omit<Memory, 'id'>): Promise<string>
  /** Update a craft memory */
  updateCraftMemory?(id: string, updates: Partial<Memory>): Promise<void>
  /** Delete a craft memory */
  deleteCraftMemory?(id: string): Promise<void>
  /** Save a turn trace for debugging */
  saveTrace?(conversationId: string, trace: TurnTrace): Promise<void>
  /** Load turn traces for a conversation */
  getTraces?(conversationId: string, options?: { limit?: number }): Promise<TurnTrace[]>
}
