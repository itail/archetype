/**
 * Fitness Trainer example — shows how a strength coaching app would use Archetype.
 *
 * Run: npx tsx examples/fitness/index.ts
 * Requires: GEMINI_API_KEY env var
 */
import { definePersona, Gemini } from '../../src/index.js'
import { FITNESS_TEMPLATE } from '../../src/playbook/templates.js'

const iron = definePersona({
  ...FITNESS_TEMPLATE,
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

async function main() {
  console.log(`\n💪 ${iron.name} (${iron.providerName})\n`)

  const result = await iron.chat({
    message: "I want to do an upper body workout today. I've got about 45 minutes. My shoulder has been a bit sore from Monday's session.",
    history: [],
    context: {
      injuries: ['Right shoulder — mild impingement, avoid overhead pressing'],
      equipment: ['Barbell', 'Dumbbells (5-50 lbs)', 'Pull-up bar', 'Cable machine', 'Bench'],
      recentWorkouts: [
        { date: '2025-01-13', type: 'Upper Push', duration: '50 min', notes: 'Shoulder felt tight on OHP' },
        { date: '2025-01-11', type: 'Lower', duration: '45 min', notes: 'Good session' },
      ],
      profile: {
        name: 'Alex',
        experience: 'Intermediate (2 years)',
        goals: 'Build strength, maintain mobility',
      },
    },
    memories: [
      { id: 'm1', content: 'Prefers compound movements over isolation', category: 'preference', pinned: true },
      { id: 'm2', content: 'Responds well to RPE-based programming', category: 'preference' },
    ],
    timezone: 'America/Chicago',
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
}

main().catch(console.error)
