/**
 * auditTraceIntegrity — the "Line 3" integrity floor.
 *
 * Every TurnTrace should be a complete, honest record of what happened
 * during a turn. If the pipeline silently dropped an action, swallowed an
 * error, or took a repair/retry path without surfacing it, this audit
 * catches it. Silent failures in the pipeline make every upper-layer
 * audit (auditPersona, auditPrompt, etc.) potentially look at a lie.
 *
 * Invariants checked:
 *
 *   1. parseOk=false implies errors is non-empty (parse failures named)
 *   2. repairAttempted=true implies repairSucceeded is defined (not
 *      undefined — the outcome must be recorded)
 *   3. Every action with status 'invalid' has a non-empty error
 *   4. Every crudAction with status 'invalid' or 'failed' has a non-empty
 *      error
 *   5. Every executionResult has status 'executed' or 'failed'
 *   6. Every domainAction has status 'executed', 'failed', or 'skipped'
 *   7. If repairSucceeded=false, errors array contains at least one
 *      entry explaining why
 *   8. unknown_action status implies the name is not empty
 *
 * Returns findings in the same shape as auditPersona for unified handling.
 */
import type { TurnTrace } from '../types.js'
import type { AuditFinding } from './audit-persona.js'

export interface TraceIntegrityResult {
  pass: boolean
  findings: AuditFinding[]
}

export function auditTraceIntegrity(trace: TurnTrace): TraceIntegrityResult {
  const findings: AuditFinding[] = []
  const traceId = trace.traceId

  // Invariant 1: parse failure must be explained.
  if (!trace.parseOk && trace.errors.length === 0) {
    findings.push({
      severity: 'error',
      audit: 'trace-integrity',
      principle: 'parse-failure-silent',
      message: `Trace ${traceId}: parseOk=false but errors array is empty. Parse failure was not explained.`,
    })
  }

  // Invariant 2: repair outcome must be recorded.
  if (trace.repairAttempted && trace.repairSucceeded === undefined) {
    findings.push({
      severity: 'error',
      audit: 'trace-integrity',
      principle: 'repair-outcome-missing',
      message: `Trace ${traceId}: repairAttempted=true but repairSucceeded is undefined. Repair took a path that didn't record its outcome.`,
    })
  }

  // Invariant 7: failed repair must leave an error trail.
  if (trace.repairAttempted && trace.repairSucceeded === false) {
    const hasRepairError = trace.errors.some(e => e.toLowerCase().includes('repair'))
    if (!hasRepairError) {
      findings.push({
        severity: 'warn',
        audit: 'trace-integrity',
        principle: 'repair-failure-unexplained',
        message: `Trace ${traceId}: repairSucceeded=false but no repair-related entry in errors. The reason the repair failed is not traceable.`,
      })
    }
  }

  // Invariant 3: invalid actions must have an error.
  for (const action of trace.actions) {
    if (action.status === 'invalid' && (!action.error || action.error.length === 0)) {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'invalid-action-no-error',
        message: `Trace ${traceId}: action "${action.name}" has status 'invalid' but no error explanation.`,
      })
    }
    // Invariant 8
    if (action.status === 'unknown_action' && (!action.name || action.name.length === 0)) {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'unknown-action-no-name',
        message: `Trace ${traceId}: action has status 'unknown_action' but name is empty.`,
      })
    }
  }

  // Invariant 4: invalid/failed crud must have an error.
  for (const crud of trace.crudActions) {
    if ((crud.status === 'invalid' || crud.status === 'failed') && (!crud.error || crud.error.length === 0)) {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'crud-failure-no-error',
        message: `Trace ${traceId}: crud ${crud.operation} ${crud.entity} has status '${crud.status}' but no error explanation.`,
      })
    }
  }

  // Invariant 5: execution results must have valid status.
  for (const result of trace.executionResults) {
    if (result.status !== 'executed' && result.status !== 'failed') {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'bad-execution-status',
        message: `Trace ${traceId}: executionResult for ${result.operation} ${result.entity} has unexpected status '${result.status}' (expected 'executed' or 'failed').`,
      })
    }
    if (result.status === 'failed' && (!result.error || result.error.length === 0)) {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'crud-failure-no-error',
        message: `Trace ${traceId}: executionResult ${result.operation} ${result.entity} failed but no error explanation.`,
      })
    }
  }

  // Invariant 6: domain actions must have valid status.
  const allowedDomainStatus = new Set(['executed', 'failed', 'skipped'])
  for (const domain of trace.domainActions) {
    if (!allowedDomainStatus.has(domain.status)) {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'bad-domain-status',
        message: `Trace ${traceId}: domainAction "${domain.name}" has unexpected status '${domain.status}'.`,
      })
    }
    if (domain.status === 'failed' && (!domain.error || domain.error.length === 0)) {
      findings.push({
        severity: 'error',
        audit: 'trace-integrity',
        principle: 'domain-failure-no-error',
        message: `Trace ${traceId}: domainAction "${domain.name}" failed but no error explanation.`,
      })
    }
  }

  return {
    pass: findings.every(f => f.severity !== 'error'),
    findings,
  }
}
