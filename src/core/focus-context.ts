import type { ContextInputDefinition } from '../types.js'

export interface FocusWorkItem {
  artifactName?: string
  primaryGoal: string
  goodOutcome?: string
  constraints?: readonly string[]
  mandatoryOutputs?: readonly string[]
  followUpAssignment?: string
}

export interface FocusContextInputLabels {
  workItem?: string
  sourceContext?: string
  workHistory?: string
  files?: string
  environment?: string
}

export function buildFocusContextInputs(labels: FocusContextInputLabels = {}): Record<string, ContextInputDefinition> {
  return {
    workItem: {
      label: labels.workItem ?? 'WORK ITEM',
      intent: 'Persona-authored future operating context for this focus turn: expert judgment lens, work/product spine, success picture, and manageable reasoning decomposition. It is layered on source truth, visible conversation, durable files, and tool outcomes; it does not replace them or another expert\'s ownership.',
      format: 'block',
    },
    sourceContext: {
      label: labels.sourceContext ?? 'SOURCE CONTEXT',
      intent: 'Exact compact contents of small source-truth files that define success for the current work. Use this as durable grounding when planning, making tradeoffs, handing off work, and judging completeness; use readFile when relevant source truth is absent, too large, or stale.',
      format: 'block',
    },
    workHistory: {
      label: labels.workHistory ?? 'WORK HISTORY',
      intent: 'Chronological private work continuity: self-notes, this persona\'s action outcomes, and world changes not already visible in chat.',
      format: 'list',
    },
    files: {
      label: labels.files ?? 'FILES',
      intent: 'Factual workspace tree with size signals. Files are durable artifacts; WORK ITEM is private operating context layered on top of source truth and durable files. Use the relevant read/list/search action when contents matter.',
      format: 'list',
    },
    environment: {
      label: labels.environment ?? 'ENVIRONMENT',
      intent: 'Factual runtime and workspace constraints. Use these facts when choosing tools, paths, dependencies, build strategy, or verification steps.',
      format: 'list',
    },
  }
}

export function renderFocusWorkItem(input: FocusWorkItem): string {
  return [
    input.artifactName ? `Artifact: ${input.artifactName}` : null,
    `Primary goal: ${input.primaryGoal}`,
    input.goodOutcome ? `What good looks like: ${input.goodOutcome}` : null,
    renderList('Hard constraints:', input.constraints),
    renderList('Mandatory outputs:', input.mandatoryOutputs),
    input.followUpAssignment ? 'Follow-up assignment:' : null,
    input.followUpAssignment ? `- ${input.followUpAssignment}` : null,
  ].filter(Boolean).join('\n')
}

function renderList(label: string, items?: readonly string[]): string | null {
  if (!items || items.length === 0) return null
  return [label, ...items.map(item => `- ${item}`)].join('\n')
}
