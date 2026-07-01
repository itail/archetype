import type { PersonaConfig, ChatInput, Memory, PromptMode } from '../types.js'

// ─── Prompt Audit ───────────────────────────────────────────────────────────

export interface PromptAuditInput {
  /** API key for the judge LLM (Gemini). */
  apiKey: string
  /** The persona config to audit. */
  config: PersonaConfig
  /** Optional context to assemble the full prompt (profile, todayStatus, etc.). */
  context?: Record<string, unknown>
  /** Optional memories to include in the assembled prompt. */
  memories?: Memory[]
  /**
   * Which prompt mode to assemble for the audit. Defaults to 'conversation'
   * (the chat-style assembly). Set to 'focus' or 'operational' to audit the
   * variant that the benchmark/runtime actually sends. Without this the
   * audit can pass while the real prompt has latent contradictions in a
   * mode the consumer is actively using.
   */
  promptMode?: PromptMode
  /** Optional primary Gemini model. Default: gemini-3.5-flash. */
  model?: string
  /** Optional fallback model chain. When the primary is unavailable (503/overload), the audit will try these in order. Default: ['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite']. */
  fallbackModels?: string[]
}

export interface PromptAuditFailure {
  /** Which keystone principle is violated. */
  principle: string
  /** The exact problematic text from the prompt. */
  text: string
  /** Why this is a problem — in terms the developer can act on. */
  issue: string
  /** A scenario-first rewrite suggestion. */
  suggestion: string
}

export interface PromptAuditResult {
  /** Config version hash — changes when the prompt-affecting config changes. */
  configVersion: string
  /** Explicit list of keystone violations found in the prompt. */
  failures: PromptAuditFailure[]
  /** One-paragraph summary for the developer. */
  summary: string
}

// ─── Conversation Audit ─────────────────────────────────────────────────────

export interface ConversationAuditInput {
  /** API key for the judge LLM (Gemini). */
  apiKey: string
  /** The persona config (for understanding intent). */
  config: PersonaConfig
  /** Recent conversation history to audit. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Optional context the persona had available. */
  context?: Record<string, unknown>
}

export interface ConversationAuditFailure {
  /** Which keystone principle the behavior violates. */
  principle: string
  /** Which turn (0-indexed) the failure occurs in. */
  turn: number
  /** What went wrong. */
  issue: string
  /** Direct quote from the conversation as evidence. */
  evidence: string
}

export interface ConversationAuditResult {
  /** Config version hash — changes when the prompt-affecting config changes. */
  configVersion: string
  /** Explicit list of behavioral failures. */
  failures: ConversationAuditFailure[]
  /** One-paragraph summary. */
  summary: string
}

// ─── Combined Audit ─────────────────────────────────────────────────────────

export interface AuditInput {
  /** API key for the judge LLM. */
  apiKey: string
  /** Optional conversation history — if provided, runs conversation audit too. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Optional context for prompt assembly. */
  context?: Record<string, unknown>
  /** Optional memories for prompt assembly. */
  memories?: Memory[]
}

export interface AuditResult {
  /** Prompt-level keystone failures. */
  prompt: PromptAuditResult
  /** Conversation-level behavioral failures (null if no history provided). */
  conversation: ConversationAuditResult | null
}
