/**
 * auditPersona — unified audit entry point.
 *
 * Composes every audit Archetype knows about, applied to one persona,
 * producing one report. Replaces the per-persona audit-v3.ts pattern where
 * each project hand-composes a subset of audits and silently lags whenever
 * a new audit lands.
 *
 * Default debugging loop (documented in EVALS.md):
 *   1. auditPersona({ config, ... })  ← this function. Runs everything
 *      applicable to the input you provide. Start here.
 *   2. If findings are unclear, dumpPromptForReview({ config, ... }) to
 *      eyeball the exact assembled prompt.
 *   3. If runtime traces look wrong, auditTraceIntegrity(trace) to confirm
 *      the pipeline isn't silently dropping or repairing anything.
 *
 * Scope gating:
 *   - 'static' — audits that only need the config. Always safe to run.
 *   - 'static-plus-scenario' — adds audits that need a representative
 *     context + memories. Skipped cleanly if those inputs aren't provided.
 *   - 'full' — adds LLM meta-judges (auditPrompt, auditByBrainReflection).
 *     Requires apiKey.
 */
import type { PersonaConfig, Memory, PromptMode, LoadedBrainArtifact } from '../types.js'
import { auditBrainBloat } from '../evals/brain-bloat.js'
import { auditBrainPrescriptions } from '../evals/brain-prescriptions.js'
import { auditCrossLayerDuplicates } from '../evals/cross-layer-duplicates.js'
import { auditActionContracts } from '../evals/action-contracts.js'
import { auditEntityVisibility } from '../evals/entity-visibility.js'
import { auditPromptContent } from '../evals/prompt-content.js'
import { auditPrompt } from './prompt-audit.js'
import { auditByBrainReflection } from './brain-reflection.js'
import { buildChatLLMRequest } from '../core/request-builder.js'
import { LOAD_BEARING_INVARIANTS } from '../playbook/invariants.js'
import type {
  BrainBloatAuditResult,
  BrainPrescriptionsAuditResult,
  CrossLayerAuditResult,
  ActionContractAuditResult,
  EntityVisibilityResult,
  PromptContentAuditResult,
} from '../evals/index.js'
import type { PromptAuditResult } from './types.js'
import type { BrainReflectionResult } from './brain-reflection.js'

export type AuditScope = 'static' | 'static-plus-scenario' | 'full'
export type AuditSeverity = 'error' | 'warn' | 'info'

/**
 * A unified finding shape every audit flattens into. Lets callers iterate
 * issues across audits, sort by severity, filter by audit name, without
 * having to know each audit's native result shape. The native results are
 * still available via `raw` for deep inspection.
 */
export interface AuditFinding {
  severity: AuditSeverity
  /** Which audit produced this finding (e.g., 'brain-bloat'). */
  audit: string
  /** Name of the failure mode inside that audit (e.g., 'section-size'). */
  principle: string
  /** Human-readable issue. */
  message: string
  /** Concrete suggestion (when the audit offers one). */
  suggestion?: string
  /** The offending text when applicable. */
  text?: string
  /** Location in the config/brain/prompt when applicable. */
  location?: string
}

export interface AuditPersonaInput {
  config: PersonaConfig
  /**
   * Optional representative context the app passes to chat(). Unlocks
   * scenario-shaped audits (entity-visibility, prompt-content, invariants-
   * present). Without it those audits skip with an explanation.
   */
  context?: Record<string, unknown>
  /** Optional memories the persona would receive at chat time. */
  memories?: Memory[]
  /** Optional craft memories for personas using the craftMemory entity. */
  craftMemories?: Memory[]
  /** Optional brain markdown or loaded brain. Unlocks brain-* audits. */
  brain?: LoadedBrainArtifact | string
  /**
   * Optional source path for brain (only used for diagnostics on
   * brain-bloat findings).
   */
  brainSourcePath?: string
  /** API key for LLM judges. Required for scope: 'full'. */
  apiKey?: string
  /** Which prompt mode to assemble for scenario-shaped audits. */
  promptMode?: PromptMode
  /** Filter the scope. Default 'static-plus-scenario'. */
  scope?: AuditScope
  /** Optional primary Gemini model for LLM judges. */
  model?: string
  /** Optional fallback chain for LLM judges. */
  fallbackModels?: string[]
}

export interface AuditPersonaResult {
  /** True when zero `error`-severity findings across all audits that ran. */
  pass: boolean
  /** All findings across all audits, unified shape, sorted by severity. */
  findings: AuditFinding[]
  /** Which audits actually ran. */
  auditsRun: string[]
  /**
   * Audits that didn't run and why (e.g., "entity-visibility: no context
   * provided"). Helps callers expand their inputs to get more coverage.
   */
  auditsSkipped: Array<{ audit: string; reason: string }>
  /** One-line human-readable summary. */
  summary: string
  /**
   * Native per-audit results for callers that want deep structured access.
   * Audits that didn't run are absent from this object.
   */
  raw: {
    brainBloat?: BrainBloatAuditResult
    brainPrescriptions?: BrainPrescriptionsAuditResult
    crossLayerDuplicates?: CrossLayerAuditResult
    actionContracts?: ActionContractAuditResult
    entityVisibility?: EntityVisibilityResult
    promptContent?: PromptContentAuditResult
    loadBearingInvariants?: LoadBearingInvariantsResult
    contextInputIntents?: ContextInputIntentAuditResult
    prompt?: PromptAuditResult
    brainReflection?: BrainReflectionResult
  }
}

/**
 * Load-bearing invariants presence check. A static audit that asserts
 * the prompt this persona actually assembles contains each invariant's
 * text. If a refactor (intentional or accidental) drops an invariant
 * from the assembled prompt, this surfaces it at audit time.
 *
 * This is new — promoted from tests/load-bearing-invariants.test.ts so
 * it catches issues in user personas too, not just the foundation config.
 */
export interface LoadBearingInvariantsResult {
  pass: boolean
  missing: Array<{ id: string; constant: string; sourceSection: string }>
}

export interface ContextInputIntentAuditResult {
  pass: boolean
  missing: Array<{ key: string; label: string }>
}

function auditContextInputIntents(config: PersonaConfig): ContextInputIntentAuditResult {
  const missing = Object.entries(config.contextInputs ?? {})
    .filter(([, definition]) => !definition.intent?.trim())
    .map(([key, definition]) => ({ key, label: definition.label }))
  return { pass: missing.length === 0, missing }
}

function auditLoadBearingInvariants(
  config: PersonaConfig,
  context?: Record<string, unknown>,
  memories?: Memory[],
  promptMode?: PromptMode,
): LoadBearingInvariantsResult {
  const applicableInvariants = LOAD_BEARING_INVARIANTS.filter(inv =>
    isLoadBearingInvariantApplicable(inv, config, promptMode),
  )

  const { request } = buildChatLLMRequest(config, {
    message: '(audit)',
    context: context ?? {},
    memories: memories ?? [],
    timezone: 'UTC',
    promptMode,
  })

  const missing: LoadBearingInvariantsResult['missing'] = []
  for (const inv of applicableInvariants) {
    // Check against assembled system prompt with key concepts. Text match
    // is brittle across minor wording drift; concept presence is what
    // actually matters for the failure mode each invariant protects.
    const prompt = request.systemPrompt.toLowerCase()
    const allConceptsPresent = inv.keyConcepts.every(c => prompt.includes(c.toLowerCase()))
    if (!allConceptsPresent) {
      missing.push({ id: inv.id, constant: inv.constant, sourceSection: inv.sourceSection })
    }
  }

  return { pass: missing.length === 0, missing }
}

function isLoadBearingInvariantApplicable(
  invariant: typeof LOAD_BEARING_INVARIANTS[number],
  config: PersonaConfig,
  promptMode?: PromptMode,
): boolean {
  const mode = promptMode ?? 'conversation'
  const hasMutableSurface = Boolean(
    (config.actions && Object.keys(config.actions).length > 0)
    || (config.entities && Object.keys(config.entities).length > 0),
  )

  switch (invariant.id) {
    case 'judgment-over-literalism':
    case 'precedence-of-signals':
      return mode === 'conversation'
    case 'match-message-to-actions':
      return mode !== 'focus' && hasMutableSurface
    case 'memory-self-box':
    case 'contexthint-captures-why':
      return config.memory?.enabled === true
    default:
      return true
  }
}

// ─── flatteners: native audit results → AuditFinding[] ──────────────────────

function flattenBrainBloat(r: BrainBloatAuditResult): AuditFinding[] {
  return r.issues.map(i => ({
    severity: i.severity,
    audit: 'brain-bloat',
    principle: i.kind,
    message: i.message,
    location: i.section,
  }))
}

function flattenBrainPrescriptions(r: BrainPrescriptionsAuditResult): AuditFinding[] {
  return r.prescriptions.map(p => ({
    severity: p.severity,
    audit: 'brain-prescriptions',
    principle: p.shape,
    message: p.issue,
    suggestion: p.suggestion,
    text: p.brainText,
    location: p.section,
  }))
}

function flattenCrossLayer(r: CrossLayerAuditResult): AuditFinding[] {
  return r.duplicates.map(d => ({
    severity: 'warn' as const,
    audit: 'cross-layer-duplicates',
    principle: d.targetLayer,
    message: `brain restates ${d.targetLayer}:${d.target}`,
    suggestion: d.suggestion,
    text: d.brainText,
    location: d.section,
  }))
}

function flattenActionContracts(r: ActionContractAuditResult): AuditFinding[] {
  return r.issues.map(i => ({
    severity: i.severity,
    audit: 'action-contracts',
    principle: i.principle,
    message: i.message,
    suggestion: i.suggestion,
    location: `${i.surface}:${i.name}`,
  }))
}

function flattenEntityVisibility(r: EntityVisibilityResult): AuditFinding[] {
  return r.issues.map(i => ({
    severity: i.severity,
    audit: 'entity-visibility',
    principle: i.principle,
    message: i.message,
    suggestion: i.suggestion,
    location: i.entity,
  }))
}

function flattenPromptContent(r: PromptContentAuditResult): AuditFinding[] {
  return r.issues.map(i => ({
    severity: i.severity,
    audit: 'prompt-content',
    principle: 'prompt-content',
    message: i.message,
  }))
}

function flattenLoadBearing(r: LoadBearingInvariantsResult): AuditFinding[] {
  return r.missing.map(m => ({
    severity: 'error' as const,
    audit: 'load-bearing-invariants',
    principle: 'invariant-missing',
    message: `Invariant "${m.id}" missing from assembled prompt. Its source constant is ${m.constant} (section: ${m.sourceSection}). See src/playbook/invariants.ts for why this line is load-bearing and which scenario regressed when it was last removed.`,
    location: m.sourceSection,
  }))
}

function flattenContextInputIntents(r: ContextInputIntentAuditResult): AuditFinding[] {
  return r.missing.map(m => ({
    severity: 'warn' as const,
    audit: 'context-input-intents',
    principle: 'missing-intent',
    message: `Context block "${m.label}" has no intent line. Add a short scenario/use explanation so the agent knows how to read this surface.`,
    suggestion: 'Set contextInputs.<key>.intent to explain the block purpose, not just the data type.',
    location: `contextInputs:${m.key}`,
  }))
}

function flattenPromptAudit(r: PromptAuditResult): AuditFinding[] {
  return r.failures.map(f => ({
    severity: 'warn' as const,
    audit: 'prompt-audit',
    principle: f.principle,
    message: f.issue,
    suggestion: f.suggestion,
    text: f.text,
  }))
}

function flattenBrainReflection(r: BrainReflectionResult): AuditFinding[] {
  return r.findings.map(f => ({
    severity: 'warn' as const,
    audit: 'brain-reflection',
    principle: f.category,
    message: f.howItFeels,
    suggestion: f.whatIdWantInstead,
    text: f.quotedText,
  }))
}

// ─── main ──────────────────────────────────────────────────────────────────

export async function auditPersona(input: AuditPersonaInput): Promise<AuditPersonaResult> {
  const scope = input.scope ?? 'static-plus-scenario'
  const runLLM = scope === 'full'

  const findings: AuditFinding[] = []
  const auditsRun: string[] = []
  const auditsSkipped: Array<{ audit: string; reason: string }> = []
  const raw: AuditPersonaResult['raw'] = {}

  const brainArtifact = typeof input.brain === 'object' ? input.brain : undefined
  const explicitBrainMarkdown = typeof input.brain === 'string'
    ? input.brain
    : brainArtifact?.markdown

  // Inline-brain fallback: when the persona carries its prose in config.methodology /
  // config.directives / config.voice.formatting rather than a separate brain file,
  // synthesize a markdown view so brain-* audits can still catch prescription,
  // bloat, and cross-layer duplication issues against that prose. Apps used to
  // reimplement this helper locally; owning it here removes the scaffolding.
  const brainMarkdown = explicitBrainMarkdown ?? synthesizeInlineBrain(input.config)
  const brainSourceIsInline = !explicitBrainMarkdown && !!brainMarkdown

  // ─── Static: config-only audits ──────────────────────────────────────────

  raw.actionContracts = auditActionContracts({ config: input.config })
  findings.push(...flattenActionContracts(raw.actionContracts))
  auditsRun.push('action-contracts')

  raw.contextInputIntents = auditContextInputIntents(input.config)
  findings.push(...flattenContextInputIntents(raw.contextInputIntents))
  auditsRun.push('context-input-intents')

  if (brainMarkdown || brainArtifact) {
    const sourcePath = brainSourceIsInline
      ? 'generated://config-inline-brain.md'
      : input.brainSourcePath
    raw.brainBloat = auditBrainBloat({
      markdown: brainMarkdown,
      brain: brainArtifact,
      sourcePath,
    })
    findings.push(...flattenBrainBloat(raw.brainBloat))
    auditsRun.push(brainSourceIsInline ? 'brain-bloat (inline)' : 'brain-bloat')

    raw.brainPrescriptions = auditBrainPrescriptions({
      markdown: brainMarkdown,
      brain: brainArtifact,
      sourcePath,
    })
    findings.push(...flattenBrainPrescriptions(raw.brainPrescriptions))
    auditsRun.push(brainSourceIsInline ? 'brain-prescriptions (inline)' : 'brain-prescriptions')

    // Cross-layer checks brain prose against config prose; running it on
    // synthesized-from-config markdown would trivially report every line
    // as a duplicate of itself. Skip cleanly in the inline case.
    if (!brainSourceIsInline) {
      raw.crossLayerDuplicates = auditCrossLayerDuplicates({
        config: input.config,
        markdown: brainMarkdown,
        brain: brainArtifact,
      })
      findings.push(...flattenCrossLayer(raw.crossLayerDuplicates))
      auditsRun.push('cross-layer-duplicates')
    } else {
      auditsSkipped.push({
        audit: 'cross-layer-duplicates',
        reason: 'brain is synthesized from config — cross-layer comparison is trivial',
      })
    }
  } else {
    auditsSkipped.push({ audit: 'brain-bloat', reason: 'no brain markdown or inline methodology/directives provided' })
    auditsSkipped.push({ audit: 'brain-prescriptions', reason: 'no brain markdown or inline methodology/directives provided' })
    auditsSkipped.push({ audit: 'cross-layer-duplicates', reason: 'no brain markdown provided' })
  }

  // ─── Scenario-shaped audits (need context + memories) ───────────────────

  if (scope !== 'static') {
    // entity-visibility needs context. Runs even with empty context (flags
    // every entity as not-visible, which surfaces the config gap) but the
    // result is more actionable with real context.
    raw.entityVisibility = auditEntityVisibility({
      config: input.config,
      context: input.context ?? {},
      memories: input.memories,
      craftMemories: input.craftMemories,
    })
    findings.push(...flattenEntityVisibility(raw.entityVisibility))
    auditsRun.push('entity-visibility')

    // prompt-content and load-bearing-invariants check the assembled prompt,
    // so need enough input to assemble one. Use empty defaults where safe.
    try {
      const { request } = buildChatLLMRequest(input.config, {
        message: '(audit)',
        context: input.context ?? {},
        memories: input.memories ?? [],
        craftMemories: input.craftMemories,
        timezone: 'UTC',
        promptMode: input.promptMode,
      })

      raw.promptContent = auditPromptContent({
        prompt: request.systemPrompt,
        declaredEntities: Object.keys(input.config.entities ?? {}),
      })
      findings.push(...flattenPromptContent(raw.promptContent))
      auditsRun.push('prompt-content')

      raw.loadBearingInvariants = auditLoadBearingInvariants(
        input.config,
        input.context,
        input.memories,
        input.promptMode,
      )
      findings.push(...flattenLoadBearing(raw.loadBearingInvariants))
      auditsRun.push('load-bearing-invariants')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      auditsSkipped.push({ audit: 'prompt-content', reason: `prompt assembly failed: ${msg}` })
      auditsSkipped.push({ audit: 'load-bearing-invariants', reason: `prompt assembly failed: ${msg}` })
    }
  } else {
    auditsSkipped.push({ audit: 'entity-visibility', reason: 'scope is static' })
    auditsSkipped.push({ audit: 'prompt-content', reason: 'scope is static' })
    auditsSkipped.push({ audit: 'load-bearing-invariants', reason: 'scope is static' })
  }

  // ─── LLM judges (scope: 'full', needs apiKey) ────────────────────────────

  if (runLLM) {
    if (!input.apiKey) {
      auditsSkipped.push({ audit: 'prompt-audit', reason: 'scope is full but no apiKey' })
      auditsSkipped.push({ audit: 'brain-reflection', reason: 'scope is full but no apiKey' })
    } else {
      try {
        raw.prompt = await auditPrompt({
          apiKey: input.apiKey,
          config: input.config,
          context: input.context,
          memories: input.memories,
          promptMode: input.promptMode,
          model: input.model,
          fallbackModels: input.fallbackModels,
        })
        findings.push(...flattenPromptAudit(raw.prompt))
        auditsRun.push('prompt-audit')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        auditsSkipped.push({ audit: 'prompt-audit', reason: `LLM call failed: ${msg}` })
      }

      try {
        raw.brainReflection = await auditByBrainReflection({
          apiKey: input.apiKey,
          config: input.config,
          context: input.context,
          memories: input.memories,
          model: input.model,
          fallbackModels: input.fallbackModels,
        })
        findings.push(...flattenBrainReflection(raw.brainReflection))
        auditsRun.push('brain-reflection')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        auditsSkipped.push({ audit: 'brain-reflection', reason: `LLM call failed: ${msg}` })
      }
    }
  } else {
    auditsSkipped.push({ audit: 'prompt-audit', reason: `scope is ${scope}` })
    auditsSkipped.push({ audit: 'brain-reflection', reason: `scope is ${scope}` })
  }

  // ─── finalize ────────────────────────────────────────────────────────────

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))

  const errorCount = findings.filter(f => f.severity === 'error').length
  const warnCount = findings.filter(f => f.severity === 'warn').length
  const pass = errorCount === 0

  const summary = buildSummary(pass, errorCount, warnCount, auditsRun.length, auditsSkipped.length)

  return { pass, findings, auditsRun, auditsSkipped, summary, raw }
}

/**
 * Synthesize a brain-markdown view of a config's inline prose. Used when
 * the persona carries its methodology/directives/voice.formatting in the
 * config object rather than a separate brain file. Returns undefined if
 * the config has no inline prose — caller will skip brain-* audits.
 */
function synthesizeInlineBrain(config: PersonaConfig): string | undefined {
  const sections: string[] = []
  if (config.voice?.formatting) {
    sections.push(`## Voice Formatting\n${config.voice.formatting}`)
  }
  if (config.methodology) {
    sections.push(`## Methodology\n${config.methodology}`)
  }
  const directives = typeof config.directives === 'string'
    ? config.directives
    : config.directives?.default
  if (directives) {
    sections.push(`## Directives\n${directives}`)
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

function severityRank(s: AuditSeverity): number {
  if (s === 'error') return 0
  if (s === 'warn') return 1
  return 2
}

function buildSummary(
  pass: boolean,
  errorCount: number,
  warnCount: number,
  ranCount: number,
  skippedCount: number,
): string {
  const verdict = pass ? 'PASS' : 'FAIL'
  const counts = `${errorCount} error${errorCount === 1 ? '' : 's'}, ${warnCount} warn${warnCount === 1 ? '' : 's'}`
  const coverage = `${ranCount} audit${ranCount === 1 ? '' : 's'} ran${skippedCount ? `, ${skippedCount} skipped` : ''}`
  return `${verdict} — ${counts} (${coverage})`
}

// ─── Report formatting ───────────────────────────────────────────────────────
// Standard renderer for AuditPersonaResult. Every app produced the same
// ~40-line formatter; owning it here keeps audit scripts at ~10 lines.

export interface FormatAuditReportOptions {
  /** Title shown at the top (e.g., "Savor structural audit"). */
  title?: string
  /** Char limit before truncating `text` / `suggestion` lines. Default 160. */
  maxTextChars?: number
  /** Include findings with severity 'info'. Default true. */
  includeInfo?: boolean
}

/**
 * Render an AuditPersonaResult as a human-readable multi-line string.
 * Use `printAuditReport` for the common "log + set exit code" path.
 */
export function formatAuditReport(
  result: AuditPersonaResult,
  options: FormatAuditReportOptions = {},
): string {
  const title = options.title ?? 'Persona audit'
  const maxTextChars = options.maxTextChars ?? 160
  const includeInfo = options.includeInfo ?? true
  const bar = '═'.repeat(70)
  const lines: string[] = []

  lines.push(bar)
  lines.push(`${title} — ${result.pass ? 'PASS ✓' : 'FAIL ✗'}`)
  lines.push(result.summary)
  lines.push(bar)

  if (result.auditsRun.length > 0) {
    lines.push('')
    lines.push(`Audits run: ${result.auditsRun.join(', ')}`)
  }
  if (result.auditsSkipped.length > 0) {
    lines.push('')
    lines.push('Audits skipped:')
    for (const s of result.auditsSkipped) lines.push(`  • ${s.audit}: ${s.reason}`)
  }

  const findings = includeInfo
    ? result.findings
    : result.findings.filter(f => f.severity !== 'info')

  if (findings.length > 0) {
    lines.push('')
    lines.push(`Findings (${findings.length}):`)
    for (const f of findings) {
      const head = `[${f.severity}] ${f.audit}:${f.principle}${f.location ? ` (${f.location})` : ''}`
      lines.push('')
      lines.push(head)
      lines.push(`  ${f.message}`)
      if (f.text) lines.push(`  text: "${truncate(f.text, maxTextChars)}"`)
      if (f.suggestion) lines.push(`  → ${truncate(f.suggestion, maxTextChars)}`)
    }
  }

  return lines.join('\n')
}

export interface PrintAuditReportOptions extends FormatAuditReportOptions {
  /** Call process.exit with 0 (pass) or 1 (fail). Default false. */
  exitOnFail?: boolean
}

/**
 * Print the formatted report to stdout. When `exitOnFail` is true, sets
 * the process exit code based on `result.pass`. Returns the formatted
 * string for callers that also want to persist it.
 */
export function printAuditReport(
  result: AuditPersonaResult,
  options: PrintAuditReportOptions = {},
): string {
  const formatted = formatAuditReport(result, options)
  console.log(formatted)
  if (options.exitOnFail) process.exit(result.pass ? 0 : 1)
  return formatted
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
