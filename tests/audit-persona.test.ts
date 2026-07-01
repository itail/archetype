/**
 * auditPersona — unified entry point tests.
 *
 * Covers scope gating, input-driven audit activation, unified finding
 * shape, and the per-audit skipping with reasons. Live LLM audits
 * (scope: 'full') are NOT invoked here — those have their own live
 * tests in audit-live.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { auditPersona, formatAuditReport } from '../src/audit/audit-persona.js'
import { COACH_TEMPLATE } from '../src/playbook/templates.js'
import type { PersonaConfig } from '../src/types.js'

const mockProvider = { name: 'mock', chat: async () => ({ text: '' }) }

function cleanCoach(): PersonaConfig {
  return { ...COACH_TEMPLATE, provider: mockProvider }
}

describe('auditPersona — composition', () => {
  it('runs config-only audits at scope: static', async () => {
    const result = await auditPersona({ config: cleanCoach(), scope: 'static' })
    expect(result.auditsRun).toContain('action-contracts')
    expect(result.auditsSkipped.map(s => s.audit)).toContain('entity-visibility')
    expect(result.auditsSkipped.map(s => s.audit)).toContain('prompt-audit')
    expect(result.raw.actionContracts).toBeDefined()
  })

  it('adds scenario-shaped audits at scope: static-plus-scenario', async () => {
    const result = await auditPersona({
      config: cleanCoach(),
      scope: 'static-plus-scenario',
      context: { threads: [{ id: 't1', title: 'x', status: 'active', owner: 'alex' }] },
      memories: [{ id: 'm1', content: 'example', category: 'general' }],
    })
    expect(result.auditsRun).toContain('entity-visibility')
    expect(result.auditsRun).toContain('prompt-content')
    expect(result.auditsRun).toContain('load-bearing-invariants')
    expect(result.auditsSkipped.map(s => s.audit)).toContain('prompt-audit')
  })

  it('skips LLM judges at scope: full when apiKey missing', async () => {
    const result = await auditPersona({ config: cleanCoach(), scope: 'full' })
    const skipped = result.auditsSkipped.map(s => s.audit)
    expect(skipped).toContain('prompt-audit')
    expect(skipped).toContain('brain-reflection')
  })

  it('activates brain-* audits when brain markdown provided', async () => {
    const brain = `## Methodology\nWhat matters: clarity over noise.\n\n## Action Protocol\nUse declared actions.\n`
    const result = await auditPersona({ config: cleanCoach(), brain, scope: 'static' })
    expect(result.auditsRun).toContain('brain-bloat')
    expect(result.auditsRun).toContain('brain-prescriptions')
    expect(result.auditsRun).toContain('cross-layer-duplicates')
  })

  it('skips brain-* audits cleanly when config has no inline prose either', async () => {
    const bareConfig: PersonaConfig = {
      ...cleanCoach(),
      methodology: undefined,
      directives: undefined,
      voice: { ...cleanCoach().voice, formatting: undefined },
    }
    const result = await auditPersona({ config: bareConfig, scope: 'static' })
    const skipped = result.auditsSkipped.map(s => s.audit)
    expect(skipped).toContain('brain-bloat')
    expect(skipped).toContain('brain-prescriptions')
    expect(skipped).toContain('cross-layer-duplicates')
  })

  it('synthesizes brain from config.methodology/directives when no brain file provided', async () => {
    // Iron-AI pattern: inline methodology, no brain.md. Brain-* audits should
    // still run against the inline prose rather than silently skipping.
    const inlineConfig: PersonaConfig = {
      ...cleanCoach(),
      methodology: 'Teach users to think in systems, not hacks.',
      directives: { default: 'Lead with the why before the how.', editable: false },
    }
    const result = await auditPersona({ config: inlineConfig, scope: 'static' })
    expect(result.auditsRun).toContain('brain-bloat (inline)')
    expect(result.auditsRun).toContain('brain-prescriptions (inline)')
    // Cross-layer comparison against self-synthesized markdown is trivial.
    expect(result.auditsSkipped.map(s => s.audit)).toContain('cross-layer-duplicates')
  })
})

describe('auditPersona — unified findings', () => {
  it('produces uniform AuditFinding shape across audits', async () => {
    // Force at least one finding by passing an entity with no context.
    const config: PersonaConfig = {
      ...cleanCoach(),
      entities: {
        profile: {
          schema: z.object({ goal: z.string() }),
          description: 'User profile.',
        },
      },
      // No contextInputs declared → entity-visibility flags profile as
      // not-visible. Predictable error.
    }

    const result = await auditPersona({
      config,
      scope: 'static-plus-scenario',
      context: {},
    })
    const evFinding = result.findings.find(f => f.audit === 'entity-visibility')
    expect(evFinding).toBeDefined()
    expect(evFinding?.severity).toBe('error')
    expect(evFinding?.audit).toBe('entity-visibility')
    expect(typeof evFinding?.principle).toBe('string')
    expect(typeof evFinding?.message).toBe('string')
  })

  it('sorts findings by severity (error → warn → info)', async () => {
    const config: PersonaConfig = {
      ...cleanCoach(),
      entities: {
        profile: {
          schema: z.object({ goal: z.string() }),
          description: 'User profile.',
        },
      },
    }
    const result = await auditPersona({
      config,
      scope: 'static-plus-scenario',
      context: {},
    })
    const severities = result.findings.map(f => f.severity)
    // Errors should appear before warns in the array.
    const firstWarn = severities.indexOf('warn')
    const lastError = severities.lastIndexOf('error')
    if (firstWarn !== -1 && lastError !== -1) {
      expect(lastError).toBeLessThan(firstWarn)
    }
  })

  it('pass=true when zero errors, false otherwise', async () => {
    const clean = await auditPersona({
      config: cleanCoach(),
      scope: 'static-plus-scenario',
      context: { threads: [{ id: 't1', title: 'x', status: 'active', owner: 'alex' }] },
    })
    // Clean coach config should have no error-level findings. Warnings ok.
    const errs = clean.findings.filter(f => f.severity === 'error')
    expect(clean.pass).toBe(errs.length === 0)
  })

  it('scopes load-bearing invariants to the active prompt surface', async () => {
    const focusConfig: PersonaConfig = {
      identity: {
        name: 'Focused PM',
        expertise: ['product'],
        relationship: 'working session',
        northStar: 'ship a coherent spec bundle',
      },
      voice: { tone: 'balanced', style: 'quick', medium: 'desktop-panel' },
      actions: {
        writeFile: {
          description: 'Write a markdown file.',
          confidence: 'low',
          schema: z.object({
            path: z.string(),
            content: z.string(),
          }),
        },
      },
      provider: mockProvider,
    }

    const result = await auditPersona({
      config: focusConfig,
      scope: 'static-plus-scenario',
      context: {},
      promptMode: 'focus',
    })

    expect(result.raw.loadBearingInvariants?.pass).toBe(true)
    expect(result.raw.loadBearingInvariants?.missing).toEqual([])
  })

  it('warns when context inputs omit their intent', async () => {
    const config: PersonaConfig = {
      ...cleanCoach(),
      contextInputs: {
        threads: { label: 'THREADS', format: 'list' },
        workItem: {
          label: 'WORK ITEM',
          intent: 'The full assignment the agent is responsible for.',
          format: 'block',
        },
      },
    }

    const result = await auditPersona({ config, scope: 'static' })

    expect(result.auditsRun).toContain('context-input-intents')
    expect(result.raw.contextInputIntents?.missing).toEqual([
      { key: 'threads', label: 'THREADS' },
    ])
    expect(result.findings).toContainEqual(expect.objectContaining({
      audit: 'context-input-intents',
      principle: 'missing-intent',
      location: 'contextInputs:threads',
    }))
  })
})

describe('auditPersona — skip reasons are actionable', () => {
  it('each skipped audit has a non-empty reason', async () => {
    const result = await auditPersona({ config: cleanCoach(), scope: 'static' })
    for (const s of result.auditsSkipped) {
      expect(s.reason.length).toBeGreaterThan(0)
      // Reason shouldn't be just "skipped" — should explain.
      expect(s.reason).not.toBe('skipped')
    }
  })
})

describe('auditPersona — summary', () => {
  it('summary describes counts and coverage', async () => {
    const result = await auditPersona({ config: cleanCoach(), scope: 'static' })
    expect(result.summary).toMatch(/PASS|FAIL/)
    expect(result.summary).toMatch(/audit/)
  })
})

describe('formatAuditReport — consumer formatting', () => {
  it('renders verdict, summary, audits run, skipped, and findings', async () => {
    const result = await auditPersona({
      config: {
        ...cleanCoach(),
        entities: {
          profile: {
            schema: z.object({ goal: z.string() }),
            description: 'User profile.',
          },
        },
      },
      scope: 'static-plus-scenario',
      context: {},
    })
    const report = formatAuditReport(result, { title: 'Test persona audit' })
    expect(report).toContain('Test persona audit')
    expect(report).toMatch(/PASS|FAIL/)
    expect(report).toContain('Audits run:')
    expect(report).toContain('Audits skipped:')
    expect(report).toContain('entity-visibility')
  })

  it('includeInfo:false hides info findings', async () => {
    const result = await auditPersona({ config: cleanCoach(), scope: 'static' })
    const infoFindings = result.findings.filter(f => f.severity === 'info')
    const withInfo = formatAuditReport(result, { includeInfo: true })
    const withoutInfo = formatAuditReport(result, { includeInfo: false })
    if (infoFindings.length > 0) {
      expect(withInfo.length).toBeGreaterThan(withoutInfo.length)
    } else {
      expect(withInfo).toBe(withoutInfo)
    }
  })
})
