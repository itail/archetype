/**
 * auditTraceIntegrity tests — the floor of the three-tier audit.
 *
 * Each invariant gets a test that constructs a trace violating it and
 * confirms the audit catches it, plus a positive case that's clean.
 */
import { describe, it, expect } from 'vitest'
import { auditTraceIntegrity } from '../src/audit/trace-integrity.js'
import type { TurnTrace } from '../src/types.js'

function baseTrace(overrides?: Partial<TurnTrace>): TurnTrace {
  return {
    traceId: 'test-trace',
    startedAt: Date.now(),
    parseOk: true,
    repairAttempted: false,
    actions: [],
    crudActions: [],
    executionResults: [],
    domainActions: [],
    outcomeNotes: [],
    errors: [],
    ...overrides,
  }
}

describe('auditTraceIntegrity', () => {
  it('clean trace passes', () => {
    const r = auditTraceIntegrity(baseTrace())
    expect(r.pass).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('flags parseOk=false with no errors', () => {
    const r = auditTraceIntegrity(baseTrace({ parseOk: false }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'parse-failure-silent')).toBe(true)
  })

  it('passes parseOk=false when an error is recorded', () => {
    const r = auditTraceIntegrity(baseTrace({ parseOk: false, errors: ['bad json'] }))
    expect(r.findings.some(f => f.principle === 'parse-failure-silent')).toBe(false)
  })

  it('flags repairAttempted=true with repairSucceeded undefined', () => {
    const r = auditTraceIntegrity(baseTrace({ repairAttempted: true }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'repair-outcome-missing')).toBe(true)
  })

  it('flags failed repair without an error entry', () => {
    const r = auditTraceIntegrity(baseTrace({
      repairAttempted: true,
      repairSucceeded: false,
      errors: ['something unrelated'],
    }))
    expect(r.findings.some(f => f.principle === 'repair-failure-unexplained')).toBe(true)
  })

  it('passes failed repair when errors contain the word "repair"', () => {
    const r = auditTraceIntegrity(baseTrace({
      repairAttempted: true,
      repairSucceeded: false,
      errors: ['Repair attempt failed to produce a parsable response'],
    }))
    expect(r.findings.some(f => f.principle === 'repair-failure-unexplained')).toBe(false)
  })

  it('flags invalid action without an error', () => {
    const r = auditTraceIntegrity(baseTrace({
      actions: [{ name: 'doThing', params: {}, status: 'invalid' }],
    }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'invalid-action-no-error')).toBe(true)
  })

  it('flags invalid crud without an error', () => {
    const r = auditTraceIntegrity(baseTrace({
      crudActions: [{ operation: 'create', entity: 'meal', params: {}, status: 'invalid' }],
    }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'crud-failure-no-error')).toBe(true)
  })

  it('flags failed execution without an error', () => {
    const r = auditTraceIntegrity(baseTrace({
      executionResults: [{ operation: 'create', entity: 'meal', params: {}, status: 'failed' }],
    }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'crud-failure-no-error')).toBe(true)
  })

  it('flags bad execution status', () => {
    const r = auditTraceIntegrity(baseTrace({
      executionResults: [{ operation: 'create', entity: 'meal', params: {}, status: 'invalid' as unknown as 'executed' }],
    }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'bad-execution-status')).toBe(true)
  })

  it('flags failed domainAction without an error', () => {
    const r = auditTraceIntegrity(baseTrace({
      domainActions: [{ name: 'notifyOwner', params: {}, status: 'failed' }],
    }))
    expect(r.pass).toBe(false)
    expect(r.findings.some(f => f.principle === 'domain-failure-no-error')).toBe(true)
  })

  it('accepts skipped domainActions', () => {
    const r = auditTraceIntegrity(baseTrace({
      domainActions: [{ name: 'notifyOwner', params: {}, status: 'skipped' }],
    }))
    expect(r.pass).toBe(true)
  })

  it('unified finding shape matches AuditFinding', () => {
    const r = auditTraceIntegrity(baseTrace({ parseOk: false }))
    for (const f of r.findings) {
      expect(f.audit).toBe('trace-integrity')
      expect(typeof f.severity).toBe('string')
      expect(typeof f.principle).toBe('string')
      expect(typeof f.message).toBe('string')
    }
  })
})
