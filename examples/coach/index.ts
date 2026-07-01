/**
 * CEO Coach example — shows how a coaching app would use Archetype.
 *
 * Run: npx tsx examples/coach/index.ts
 * Requires: GEMINI_API_KEY env var
 */
import { definePersona, Gemini } from '../../src/index.js'
import { COACH_TEMPLATE } from '../../src/playbook/templates.js'

const coach = definePersona({
  ...COACH_TEMPLATE,
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

async function main() {
  console.log(`\n🎯 ${coach.name} (${coach.providerName})\n`)

  const result = await coach.chat({
    message: "I just had a tough 1:1 with my VP of Engineering. He keeps saying he needs more headcount, but I think the real issue is prioritization. How should I think about this?",
    history: [],
    context: {
      threads: [
        { id: 't1', title: 'Engineering velocity', status: 'stuck', description: 'Shipping has slowed 40% quarter-over-quarter' },
        { id: 't2', title: 'Product-market fit for enterprise', status: 'active', description: 'Need to close 3 enterprise deals by Q3' },
      ],
    },
    memories: [
      { id: 'm1', content: 'CEO tends to over-index on headcount discussions', category: 'coaching_approach', pinned: true },
      { id: 'm2', content: 'VP Eng responds well to data-driven framing', category: 'preference' },
    ],
    timezone: 'America/Los_Angeles',
    userIdentity: 'Alex, CEO',
  })

  console.log('Response:', result.message)

  // Entity CRUD — the primary output
  if (result.crudActions?.length) {
    console.log('\nEntity changes:')
    for (const crud of result.crudActions) {
      console.log(`  ${crud.operation} ${crud.entity}: ${JSON.stringify(crud.params).slice(0, 80)}`)
    }
  }

  console.log('\nActions:', JSON.stringify(result.actions, null, 2))
  console.log('Outcome notes:', result.outcomeNotes)
  console.log('Follow-ups:', result.followUps)
}

main().catch(console.error)
