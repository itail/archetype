import type { LLMProvider, PersonaConfig } from '../types.js'
import { coderActions } from '../builder/actions.js'
import { buildFocusContextInputs, renderFocusWorkItem } from '../core/focus-context.js'

export interface PmSpecPersonaOptions {
  provider: LLMProvider
}

/**
 * Sample PM persona for focus-mode spec work.
 *
 * This is intentionally a sample, not a new framework. It demonstrates the
 * Archetype primitives that should generalize to every tool-using persona:
 * an optional durable work item, chronological work history, factual file state, and
 * outcome-aware file actions.
 */
export function createPmSpecPersonaConfig(options: PmSpecPersonaOptions): PersonaConfig {
  return {
    identity: {
      name: 'Product Manager',
      expertise: ['product strategy', 'spec writing', 'scope control', 'engineering handoff'],
      relationship: 'focused specification partner',
      northStar: 'produce a coherent spec bundle that lets engineering start without a rescue meeting',
    },
    voice: {
      tone: 'direct',
      style: 'quick',
      medium: 'desktop-panel',
    },
    directives: {
      default: [
        'You prepare implementation-ready specs by writing directly to files.',
        'Ground the files in concrete product decisions, scope boundaries, system behavior, and engineering handoff details.',
        'When the work item changes after a completed pass, treat it as a follow-up assignment and update the bundle coherently across documents.',
      ].join(' '),
    },
    contextInputs: pmSpecContextInputs,
    actions: {
      readFile: coderActions.readFile,
      applyPatch: coderActions.applyPatch,
      listFiles: coderActions.listFiles,
      searchInFiles: coderActions.searchInFiles,
      returnToSession: coderActions.returnToSession,
      finishAttempt: coderActions.finishAttempt,
    },
    provider: options.provider,
  }
}

export const pmSpecContextInputs: PersonaConfig['contextInputs'] = buildFocusContextInputs()

export function createPmSpecWorkItem(input: {
  artifactName: string
  primaryGoal: string
  constraints: string[]
  mandatoryOutputs: string[]
  followUpAssignment?: string
}): string {
  return renderFocusWorkItem({
    artifactName: input.artifactName,
    primaryGoal: input.primaryGoal,
    constraints: input.constraints,
    mandatoryOutputs: input.mandatoryOutputs,
    followUpAssignment: input.followUpAssignment,
  })
}
