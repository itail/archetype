/**
 * Chief Of Staff example.
 *
 * Run: npx tsx examples/chief-of-staff/index.ts
 * Requires: GEMINI_API_KEY env var
 */
import { definePersona, Gemini, CHIEF_OF_STAFF_TEMPLATE } from '../../src/index.js'

const chief = definePersona({
  ...CHIEF_OF_STAFF_TEMPLATE,
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

async function main() {
  const result = await chief.chat({
    message: 'Remind me to send the investor update Thursday morning, and keep the draft blunt.',
    history: [],
    context: {
      openTasks: [
        { id: 'task-1', title: 'Draft board note', status: 'open', due: '2026-03-20', priority: 'medium' },
      ],
      constraints: [
        'Deep work blocks are protected from 09:00-11:00.',
        'Avoid Friday afternoon follow-ups if Thursday works.',
      ],
      profile: {
        name: 'Alex',
        role: 'CEO',
      },
    },
    memories: [
      { id: 'mem-1', content: 'Prefers blunt drafts over diplomatic softening.', category: 'working_style', pinned: true },
    ],
    timezone: 'America/Los_Angeles',
    userIdentity: 'Alex',
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
