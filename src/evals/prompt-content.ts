export interface PromptContentAuditInput {
  prompt: string
  declaredEntities?: string[]
}

export interface PromptContentAuditIssue {
  severity: 'error' | 'warn'
  message: string
}

export interface PromptContentAuditResult {
  pass: boolean
  issues: PromptContentAuditIssue[]
}

const BANNED_DRIFT_MARKERS = [
  'Recovery yogurt bowl',
  'A lighter yogurt bowl makes sense here.',
  '"entity":"meal"',
  '"entity": "meal"',
  'meal_2',
]

// Markers that reference a specific entity name. When that entity is
// declared in the persona's config, the marker is legitimate domain
// vocabulary, not cross-domain drift.
const MARKER_ENTITY_NAMES: Record<string, string> = {
  'Recovery yogurt bowl': 'meal',
  'A lighter yogurt bowl makes sense here.': 'meal',
  '"entity":"meal"': 'meal',
  '"entity": "meal"': 'meal',
  'meal_2': 'meal',
}

const BOXING_SMELL_MARKERS = [
  'Don\'t pad, don\'t truncate.',
  'Before each response, silently review the full conversation.',
  'Frequency Rule:',
  "you're not a dashboard reading it out.",
]

const DUPLICATE_SCAFFOLD_MARKERS = [
  'single most impactful thing',
  'come back and think with me again',
  'trusted thinking partner',
] as const

export function auditPromptContent(input: PromptContentAuditInput): PromptContentAuditResult {
  const issues: PromptContentAuditIssue[] = []
  const prompt = input.prompt
  const declaredEntities = new Set(input.declaredEntities ?? [])

  for (const marker of BANNED_DRIFT_MARKERS) {
    if (!prompt.includes(marker)) continue
    // Skip markers whose associated entity is legitimately declared on
    // this persona — the vocabulary is native, not drift.
    const entityName = MARKER_ENTITY_NAMES[marker]
    if (entityName && declaredEntities.has(entityName)) continue
    issues.push({
      severity: 'error',
      message: `Prompt contains banned cross-domain example drift: ${marker}`,
    })
  }

  for (const marker of BOXING_SMELL_MARKERS) {
    if (prompt.includes(marker)) {
      issues.push({
        severity: 'warn',
        message: `Prompt contains likely boxing or instruction-theater language: ${marker}`,
      })
    }
  }

  for (const marker of DUPLICATE_SCAFFOLD_MARKERS) {
    const occurrences = prompt.toLowerCase().split(marker.toLowerCase()).length - 1
    if (occurrences > 1) {
      issues.push({
        severity: 'warn',
        message: `Prompt repeats scaffold phrase "${marker}" ${occurrences} times`,
      })
    }
  }

  if (prompt.includes('--- FILES ---') && prompt.includes('--- SPEC BUNDLE ---')) {
    issues.push({
      severity: 'warn',
      message: 'Prompt splits file context across FILES and SPEC BUNDLE; use one FILES surface with virtual roots such as spec/... and artifact/....',
    })
  }

  for (const marker of ['spec/spec/', 'artifact/artifact/']) {
    if (prompt.includes(marker)) {
      issues.push({
        severity: 'error',
        message: `Prompt contains nested virtual workspace mount path "${marker}"`,
      })
    }
  }

  if (prompt.includes('default for unprefixed file actions')) {
    issues.push({
      severity: 'error',
      message: 'Prompt exposes a hidden default workspace path alias; mounted workspaces must use one canonical visible path per file.',
    })
  }

  if (prompt.includes('- editFile:') && prompt.includes('How the tools behave here:') && prompt.includes("editFile: each entry's oldText")) {
    issues.push({
      severity: 'warn',
      message: 'Prompt documents editFile in both the action list and tool-behavior section; keep the contract in one place.',
    })
  }

  const exampleEntityMatches = [...prompt.matchAll(/example response item:\s*\{.*?"entity":"([^"]+)"/g)]
  for (const match of exampleEntityMatches) {
    const entityName = match[1]
    if (declaredEntities.size > 0 && !declaredEntities.has(entityName)) {
      issues.push({
        severity: 'error',
        message: `Prompt example references undeclared entity "${entityName}"`,
      })
    }
  }

  return {
    pass: issues.every(issue => issue.severity !== 'error'),
    issues,
  }
}
