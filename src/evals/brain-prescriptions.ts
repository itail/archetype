/**
 * Brain prescriptions detector — catches trigger-response rules, exception
 * rules, field-value prescription, and enum semantics that belong in schemas,
 * even when they don't name a specific entity.
 *
 * The cross-layer duplicate detector is entity-gated: it triggers only when
 * a brain line names a specific entity and looks prescriptive. That misses
 * the common shape where the brain prescribes behavior without naming the
 * entity — "if you are changing weight, preserve its duration" — which is
 * exactly the boxing pattern a scenario-first audit must catch.
 *
 * This audit catches those shapes structurally. It is necessarily partial —
 * pattern matching will never catch semantic issues. For full coverage, pair
 * with auditPrompt (LLM reviewer). Each finding has a `suggestion` that
 * points to where the rule should live (field describe, enum describe, or
 * deletion if the standard is already implicit in the persona).
 */
import { parseBrainMarkdown } from '../brain.js'
import type { LoadedBrainArtifact } from '../types.js'

export interface BrainPrescriptionsAuditInput {
  markdown?: string
  brain?: LoadedBrainArtifact
  sourcePath?: string
}

export interface BrainPrescription {
  severity: 'error' | 'warn'
  shape:
    | 'trigger-response'
    | 'exception-rule'
    | 'negative-contrast'
    | 'field-value-prescription'
    | 'enum-semantic-definition'
    | 'announce-actions'
  section: string
  brainText: string
  /** Why it's a problem. */
  issue: string
  /** Concrete next step — either move to a specific layer or delete. */
  suggestion: string
}

export interface BrainPrescriptionsAuditResult {
  pass: boolean
  prescriptions: BrainPrescription[]
  /** What this audit catches and what it cannot — always returned so callers
   *  know to pair with auditPrompt for full coverage. */
  scope: AuditScope
}

export interface AuditScope {
  catches: string[]
  misses: string[]
  recommendation: string
}

const PRESCRIPTIONS_SCOPE: AuditScope = {
  catches: [
    'explicit trigger-response shapes: "if you are X, Y", "when you X, Y", "after X, Y"',
    'exception rules: "do X unless Y"',
    'negative contrast: "X rather than Y"',
    'field-value prescription: "set X 0", "include Y", numeric field assignments in brain',
    'enum semantics baked into brain: "X-category are only for Y", "X is for Y"',
    'announce-action anti-patterns: "speak to", "narrate", explicit talk-about-action verbs',
  ],
  misses: [
    'semantic contradictions between sections (needs auditPrompt)',
    'underspecified / vague instructions (needs auditPrompt)',
    'trigger-response wrapped in indirect phrasing the patterns miss (needs auditPrompt)',
    'subtle boxing that uses domain vocabulary creatively (needs auditPrompt)',
  ],
  recommendation: 'Pair this with auditPrompt (LLM reviewer) for coverage of semantic issues this pattern-based audit cannot catch.',
}

// ─── Pattern definitions ────────────────────────────────────────────────────

type PatternDef = {
  shape: BrainPrescription['shape']
  regex: RegExp
  issue: string
  severity: BrainPrescription['severity']
  suggest: string
}

const PATTERNS: PatternDef[] = [
  // Trigger-response shapes
  {
    shape: 'trigger-response',
    regex: /\bif you (are |'re )?\w+ing\b/i,
    issue: '"if you are [verb]ing" is a classic trigger-response shape — it prescribes behavior for a specific situation the expert can judge.',
    severity: 'warn',
    suggest: 'Describe the standard or move the situational cue into field describe()s the AI can read at decision time.',
  },
  {
    shape: 'trigger-response',
    // Must be a sentence-level trigger (start of sentence or after punctuation),
    // so subordinate clauses like "use formatting when it helps" don't match.
    regex: /(^|[.!?;]\s+)\bwhen (you|the user|the athlete|the client|they) \w+.*,\s/i,
    issue: '"when [actor] [verb], [do X]" prescribes what to do in a specific scenario. The expert should decide.',
    severity: 'warn',
    suggest: 'Describe the standard. If the rule is real routing logic, move it to the entity/schema layer.',
  },
  {
    shape: 'trigger-response',
    regex: /\bafter (the |you |your )?\w+ing\b/i,
    issue: '"after [verb]ing" prescribes sequencing — classic announce-actions or step-ordering boxing.',
    severity: 'warn',
    suggest: 'Trust the expert to decide what comes next. If the constraint is real, describe it as a standard.',
  },

  // Exception rules
  {
    shape: 'exception-rule',
    regex: /\b(preserve|use|do|keep|hold)\b[^\.]{0,80}\bunless\b/i,
    issue: '"X unless Y" is an exception rule — prescribing default behavior plus an escape hatch. The expert knows when exceptions apply.',
    severity: 'warn',
    suggest: 'Describe the field\'s semantics (what it represents) so the AI can reason about it naturally.',
  },

  // Negative contrast
  {
    shape: 'negative-contrast',
    regex: /\brather than\b|\bnot.{0,30}\binstead\b/i,
    issue: '"X rather than Y" prescribes a specific choice over another — the expert should decide.',
    severity: 'warn',
    suggest: 'Describe why the standard matters or delete if the keystone/identity already implies it.',
  },

  // Field-value prescription
  {
    shape: 'field-value-prescription',
    regex: /\bset \w+ (?:to )?\d+\b/i,
    issue: 'Brain is prescribing a specific field value numerically. That\'s a mechanical rule, not persona guidance.',
    severity: 'error',
    suggest: 'Move the value into the relevant field describe() or the enum value that owns the semantics.',
  },
  {
    shape: 'field-value-prescription',
    regex: /\binclude \w+(Seconds|Ms|Lbs|Kg|Reps|Sets)\b/i,
    issue: 'Brain is prescribing which schema field to include. That\'s routing logic that belongs in the schema.',
    severity: 'warn',
    suggest: 'Move the inclusion rule to the field describe() or to the enum value\'s semantics.',
  },

  // Enum semantic definition
  {
    shape: 'enum-semantic-definition',
    regex: /\b\w+[- ]?category (are|is) (only )?(for|used)\b/i,
    issue: 'Brain is defining what a category/enum value means. That semantic belongs in the enum\'s describe() annotation.',
    severity: 'warn',
    suggest: 'Move this definition into the enum field\'s describe(): `z.enum([\'X\', ...]).describe(\'X is for ..., ...\')`',
  },
  {
    shape: 'enum-semantic-definition',
    regex: /\b(are only for|only for standalone|exclusively (for|used))\b/i,
    issue: 'Brain is narrowing the scope of a category — defining its semantic boundary. Belongs in the enum\'s describe().',
    severity: 'warn',
    suggest: 'Move the scope definition to the enum field\'s describe() so the schema carries the meaning.',
  },

  // Announce-actions
  {
    shape: 'announce-actions',
    regex: /\b(speak to|narrate|describe (the|your) action|mention (your )?action)\b/i,
    issue: 'Brain is directing the AI on how to talk about its own actions — a common boxing anti-pattern.',
    severity: 'warn',
    suggest: 'Delete. The keystone + identity handle this naturally when the AI is briefed, not micromanaged.',
  },
]

export function auditBrainPrescriptions(input: BrainPrescriptionsAuditInput): BrainPrescriptionsAuditResult {
  const brain = input.brain ?? parseBrainMarkdown(input.markdown ?? '', input.sourcePath)
  const prescriptions: BrainPrescription[] = []

  for (const [sectionName, sectionContent] of Object.entries(brain.sections)) {
    for (const line of extractMeaningfulLines(sectionContent)) {
      for (const pattern of PATTERNS) {
        if (!pattern.regex.test(line)) continue
        prescriptions.push({
          severity: pattern.severity,
          shape: pattern.shape,
          section: sectionName,
          brainText: line,
          issue: pattern.issue,
          suggestion: pattern.suggest,
        })
        // Continue — a single line can match multiple patterns and each is a distinct signal
      }
    }
  }

  return {
    pass: !prescriptions.some((p) => p.severity === 'error'),
    prescriptions,
    scope: PRESCRIPTIONS_SCOPE,
  }
}

function extractMeaningfulLines(content: string): string[] {
  return content
    .split('\n')
    .map((raw) => raw.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length >= 15 && !line.startsWith('#'))
}
