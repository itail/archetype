import { describe, it, expect } from 'vitest'
import { auditBrainPrescriptions } from '../src/evals/brain-prescriptions.js'

/**
 * Encodes the iron-ai patterns the original cross-layer audit missed but a
 * scenario-first reviewer would catch immediately. Each of these is a real
 * failure pattern observed in production persona configs.
 */
describe('auditBrainPrescriptions — catches what the entity-gated audit misses', () => {
  it('catches "if you are [verb]ing" trigger-response with exception', () => {
    const markdown = `## Methodology
If you are changing weight, notes, or position on an existing timed hold, preserve its duration unless the athlete explicitly asks to change the time.`
    const result = auditBrainPrescriptions({ markdown })
    const shapes = result.prescriptions.map((p) => p.shape)
    expect(shapes).toContain('trigger-response')
    expect(shapes).toContain('exception-rule')
  })

  it('catches "after [verb]ing" + announce-actions + negative contrast', () => {
    const markdown = `## Methodology
After changing the workout, speak to the resulting session reality rather than narrating hidden system mechanics.`
    const result = auditBrainPrescriptions({ markdown })
    const shapes = result.prescriptions.map((p) => p.shape)
    expect(shapes).toContain('trigger-response')
    expect(shapes).toContain('announce-actions')
    expect(shapes).toContain('negative-contrast')
  })

  it('catches field-value prescription ("set X 0")', () => {
    const markdown = `## Methodology
Cooldown: set plannedWeight 0, restSeconds 0, and include durationSeconds (60-150 seconds per set).`
    const result = auditBrainPrescriptions({ markdown })
    const shapes = result.prescriptions.map((p) => p.shape)
    expect(shapes).toContain('field-value-prescription')
    expect(result.pass).toBe(false)
  })

  it('catches enum semantic definition baked into brain', () => {
    const markdown = `## Methodology
Warmup-category exercises are only for standalone mobility drills (band work, leg swings) that aren't building toward a loaded set.`
    const result = auditBrainPrescriptions({ markdown })
    const shapes = result.prescriptions.map((p) => p.shape)
    expect(shapes).toContain('enum-semantic-definition')
  })

  it('does not flag scenario-first painting', () => {
    const markdown = `## Methodology
You're standing next to your athlete in the gym — phone in hand, between sets. The athlete always has the workout card in front of them — every exercise, weight, and rep count is visible, and changes render instantly.`
    const result = auditBrainPrescriptions({ markdown })
    expect(result.prescriptions).toHaveLength(0)
  })

  it('advertises scope so callers know its limits', () => {
    const result = auditBrainPrescriptions({ markdown: '' })
    expect(result.scope.catches.length).toBeGreaterThan(0)
    expect(result.scope.misses.length).toBeGreaterThan(0)
    expect(result.scope.recommendation).toMatch(/auditPrompt/)
  })
})
