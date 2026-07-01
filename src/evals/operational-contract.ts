import type { LLMProviderRequest, PromptMode, TurnTrace } from '../types.js'

export interface OperationalPromptRequirement {
  label: string
  /**
   * Concrete tokens that should appear in the prompt when the surface is directly exposed.
   * Example: actual entity ids, role ids, enum values.
   */
  tokens: string[]
  /**
   * Tokens that must all survive into the prompt. Use this for continuity
   * contracts where "some mention happened" is not enough and the next turn
   * truly needs specific carried-forward information.
   */
  requiredTokens?: string[]
  /**
   * Alternative retrieval/documentation tokens that satisfy the requirement when the full
   * surface is intentionally not in working memory.
   */
  retrievalTokens?: string[]
}

export interface OperationalPromptContractInput {
  request: Pick<LLMProviderRequest, 'systemPrompt' | 'message'>
  trace?: TurnTrace
  expectedMode: PromptMode
  ids?: OperationalPromptRequirement[]
  enums?: OperationalPromptRequirement[]
  recipients?: OperationalPromptRequirement[]
  continuity?: OperationalPromptRequirement[]
  allowRepair?: boolean
}

export interface OperationalPromptContractIssue {
  severity: 'error' | 'warn'
  message: string
}

export interface OperationalPromptContractResult {
  pass: boolean
  issues: OperationalPromptContractIssue[]
}

const CONVERSATION_MARKERS = [
  'real person in front of you',
  'Momentum:',
  'This is a desktop side panel.',
  'This is a mobile chat interface.',
]

const FOCUS_OUTPUT_MARKER = 'Return one raw JSON object: { "message": "...", "actions": [...] }. No markdown.'

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some(needle => haystack.includes(needle))
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function checkSurface(
  issues: OperationalPromptContractIssue[],
  prompt: string,
  kind: 'ID' | 'enum' | 'recipient' | 'continuity',
  requirements?: OperationalPromptRequirement[],
) {
  for (const requirement of requirements ?? []) {
    const requiredTokensPresent = (requirement.requiredTokens ?? []).every(token => prompt.includes(token))
    const hasDirectSurface = containsAny(prompt, requirement.tokens)
    const hasRetrievalSurface = requirement.retrievalTokens?.length
      ? containsAny(prompt, requirement.retrievalTokens)
      : false

    if (!requiredTokensPresent || (!hasDirectSurface && !hasRetrievalSurface)) {
      issues.push({
        severity: 'error',
        message: `${kind} surface missing for ${requirement.label}`,
      })
    }
  }
}

export function auditOperationalPromptContract(
  input: OperationalPromptContractInput,
): OperationalPromptContractResult {
  const issues: OperationalPromptContractIssue[] = []
  const prompt = input.request.systemPrompt

  if (input.expectedMode === 'operational') {
    const hasActionContract = prompt.includes('--- ACTION RESPONSE CONTRACT ---')
    const hasEntityCrudContract = prompt.includes('--- ENTITY CRUD RESPONSE CONTRACT ---')
    if (!prompt.includes('Operational reality:')) {
      issues.push({ severity: 'error', message: 'Operational prompt is missing operational reality guidance' })
    }
    if (!hasActionContract && !hasEntityCrudContract) {
      issues.push({ severity: 'error', message: 'Operational prompt is missing the canonical action or entity response contract block' })
    } else if (hasActionContract && countOccurrences(prompt, '--- ACTION RESPONSE CONTRACT ---') > 1) {
      issues.push({ severity: 'warn', message: 'Operational prompt contains duplicate action API contract blocks' })
    }
    if (!prompt.includes('Return exactly one raw JSON object and nothing else.')) {
      issues.push({ severity: 'error', message: 'Operational prompt is missing the raw JSON output contract' })
    }
    if (!prompt.includes('Do not wrap the response in markdown code fences.')) {
      issues.push({ severity: 'error', message: 'Operational prompt is missing the no-code-fences output rule' })
    }
    for (const marker of CONVERSATION_MARKERS) {
      if (prompt.includes(marker)) {
        issues.push({ severity: 'error', message: `Operational prompt still contains conversational scaffold: ${marker}` })
      }
    }
  } else if (input.expectedMode === 'focus') {
    if (!prompt.includes(FOCUS_OUTPUT_MARKER)) {
      issues.push({ severity: 'error', message: 'Focus prompt is missing the focus JSON output contract' })
    }
    if (prompt.includes('Operational reality:')) {
      issues.push({ severity: 'error', message: 'Focus prompt still contains operational reality guidance' })
    }
    for (const marker of CONVERSATION_MARKERS) {
      if (prompt.includes(marker)) {
        issues.push({ severity: 'error', message: `Focus prompt still contains conversational scaffold: ${marker}` })
      }
    }
    if (prompt.includes('"followUps":')) {
      issues.push({ severity: 'warn', message: 'Focus prompt still contains follow-up guidance' })
    }
    if (prompt.includes('Outcome notes:')) {
      issues.push({ severity: 'warn', message: 'Focus prompt still contains outcome-notes guidance' })
    }
    const sequentialGuidanceCount = countOccurrences(prompt, 'actions is a list')
      + countOccurrences(prompt, '"actions" is a list')
    if (sequentialGuidanceCount > 1) {
      issues.push({ severity: 'warn', message: 'Focus prompt contains duplicate sequential action guidance' })
    }
  } else {
    if (!prompt.includes('"followUps":')) {
      issues.push({ severity: 'warn', message: 'Conversation prompt is missing follow-up guidance' })
    }
  }

  checkSurface(issues, prompt, 'ID', input.ids)
  checkSurface(issues, prompt, 'enum', input.enums)
  checkSurface(issues, prompt, 'recipient', input.recipients)
  checkSurface(issues, prompt, 'continuity', input.continuity)

  if (input.trace) {
    if (!input.trace.parseOk) {
      issues.push({ severity: 'error', message: 'Turn trace shows JSON parse failure' })
    }
    if (!input.allowRepair && input.trace.repairAttempted) {
      issues.push({ severity: 'warn', message: 'Turn trace needed repair to satisfy the action contract' })
    }
    for (const action of input.trace.actions) {
      if (action.status === 'unknown_action') {
        issues.push({ severity: 'error', message: `Turn trace contains unknown action: ${action.name}` })
      } else if (action.status === 'invalid') {
        issues.push({ severity: 'warn', message: `Turn trace contains invalid action params: ${action.name}` })
      }
    }
    for (const error of input.trace.errors) {
      issues.push({ severity: 'warn', message: `Turn trace error: ${error}` })
    }
  }

  return {
    pass: issues.every(issue => issue.severity !== 'error'),
    issues,
  }
}
