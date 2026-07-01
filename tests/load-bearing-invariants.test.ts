/**
 * Load-bearing invariants test — the counterweight to the audit stack.
 *
 * Each invariant in src/playbook/invariants.ts is asserted to:
 *   1. Have a non-empty constant in src/playbook/defaults.ts carrying its text.
 *   2. Still contain the key concepts it was written to carry (so softening
 *      the wording until it no longer teaches the principle fails the test).
 *   3. Render into the assembled prompt of a foundation config (so a
 *      prompt-builder refactor that drops the section entirely fails).
 *
 * If a future change strips any of these, this test fails with the doc
 * comment above the invariant explaining the failure mode it prevents —
 * along with the canary scenario the PR should run before deleting.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PersonaConfig } from '../src/types.js'
import { buildChatLLMRequest } from '../src/core/request-builder.js'
import {
  LOAD_BEARING_INVARIANTS,
  JUDGMENT_OVER_LITERALISM_NUDGE,
  PRECEDENCE_OF_SIGNALS_NUDGE,
  MATCH_MESSAGE_TO_ACTIONS_NUDGE,
  ACTION_RESULTS_ARE_WORLD_STATE_NUDGE,
  MEMORY_SELF_BOX_WARNING,
  CONTEXTHINT_CAPTURES_THE_WHY,
  EXPERT_AUTONOMY_NUDGE,
} from '../src/playbook/invariants.js'
import {
  CONVERSATION_REALITY,
  EXPERT_AUTONOMY,
  OUTCOME_NOTES_INSTRUCTION,
  MEMORY_ENTITY_RULES,
  MEMORY_METADATA_GUIDANCE,
} from '../src/playbook/defaults.js'

const INVARIANT_SOURCE_SECTION_TEXT: Record<string, string> = {
  CONVERSATION_REALITY,
  EXPERT_AUTONOMY,
  OUTCOME_NOTES_INSTRUCTION,
  MEMORY_ENTITY_RULES,
  MEMORY_METADATA_GUIDANCE,
}

function buildFoundationConfig(): PersonaConfig {
  return {
    identity: {
      name: 'Coach',
      expertise: ['executive coaching', 'organizational behavior'],
      relationship: 'trusted thinking partner',
      northStar: "the CEO's growth and the company's forward momentum",
    },
    voice: { tone: 'balanced', style: 'educator', medium: 'desktop-panel' },
    methodology: 'Threads are live company challenges.',
    directives: { default: 'Speak like a sharp executive coach.', editable: true },
    entities: {
      thread: {
        schema: z.object({ title: z.string(), status: z.enum(['active', 'done']), owner: z.string() }),
        label: 'Thread',
        displayField: 'title',
      },
    },
    contextInputs: {
      threads: { label: 'OPEN THREADS', format: 'list', includeIds: true },
    },
    memory: { enabled: true, includeIds: true },
    provider: { name: 'mock', chat: async () => ({ text: '' }) },
  }
}

describe('load-bearing invariants — the anti-prune counterweight', () => {
  for (const inv of LOAD_BEARING_INVARIANTS) {
    describe(`invariant: ${inv.id}`, () => {
      it(`${inv.constant} is non-empty`, () => {
        expect(inv.text.trim().length).toBeGreaterThan(0)
      })

      it(`carries its key concepts (softening the wording until it no longer teaches the principle fails this test)`, () => {
        for (const concept of inv.keyConcepts) {
          expect(
            inv.text.toLowerCase(),
            `invariant "${inv.id}" no longer mentions "${concept}" — see the doc comment in src/playbook/invariants.ts before weakening or removing`,
          ).toContain(concept.toLowerCase())
        }
      })

      it(`lives inside its source section (${inv.sourceSection}) in defaults.ts`, () => {
        const sectionText = INVARIANT_SOURCE_SECTION_TEXT[inv.sourceSection]
        expect(
          sectionText,
          `invariant "${inv.id}" references section "${inv.sourceSection}" which is not exported from defaults.ts`,
        ).toBeTruthy()
        expect(
          sectionText,
          `invariant "${inv.id}" text is not inside ${inv.sourceSection} — either the invariant was rewritten or the section was stripped. See the doc comment in src/playbook/invariants.ts before deleting.`,
        ).toContain(inv.text)
      })

      it(`renders into the assembled prompt of a foundation config`, () => {
        const config = buildFoundationConfig()
        const { request } = buildChatLLMRequest(config, {
          message: 'test',
          history: [],
          session: {
            actorId: 'coach',
            visibleTo: 'shared leadership session',
            participants: [
              { id: 'coach', label: 'Coach', description: 'sharpens leadership judgment' },
              { id: 'operator', label: 'Operator', description: 'moves company work forward' },
            ],
          },
          context: { threads: [{ id: 't1', title: 'example', status: 'active', owner: 'alex' }] },
          memories: [{ id: 'm1', content: 'example', category: 'general' }],
          timezone: 'UTC',
          userIdentity: 'Alex',
        })
        for (const concept of inv.keyConcepts) {
          expect(
            request.systemPrompt.toLowerCase(),
            `invariant "${inv.id}" key concept "${concept}" is not present in the assembled system prompt — a prompt-builder refactor may have dropped its section. See the doc comment in src/playbook/invariants.ts.`,
          ).toContain(concept.toLowerCase())
        }
      })
    })
  }

  it('exposes the load-bearing invariants by name from the public index', () => {
    expect(JUDGMENT_OVER_LITERALISM_NUDGE.length).toBeGreaterThan(0)
    expect(PRECEDENCE_OF_SIGNALS_NUDGE.length).toBeGreaterThan(0)
    expect(MATCH_MESSAGE_TO_ACTIONS_NUDGE.length).toBeGreaterThan(0)
    expect(ACTION_RESULTS_ARE_WORLD_STATE_NUDGE.length).toBeGreaterThan(0)
    expect(MEMORY_SELF_BOX_WARNING.length).toBeGreaterThan(0)
    expect(CONTEXTHINT_CAPTURES_THE_WHY.length).toBeGreaterThan(0)
    expect(EXPERT_AUTONOMY_NUDGE.length).toBeGreaterThan(0)
    expect(LOAD_BEARING_INVARIANTS).toHaveLength(7)
  })
})
