/**
 * Language Tutor example.
 *
 * Run: npx tsx examples/language-tutor/index.ts
 * Requires: GEMINI_API_KEY env var
 */
import { definePersona, Gemini, LANGUAGE_TUTOR_TEMPLATE } from '../../src/index.js'

const tutor = definePersona({
  ...LANGUAGE_TUTOR_TEMPLATE,
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

async function main() {
  const result = await tutor.chat({
    message: 'Correct me immediately: how would I naturally say "I want to book a table for two tomorrow night" in Spanish?',
    history: [],
    context: {
      currentGoal: {
        language: 'Spanish',
        reason: 'Trip to Barcelona in 6 weeks',
        correctionPreference: 'Immediate corrections, not end-of-message notes',
      },
      recentMistakes: [
        { id: 'mistake-1', pattern: 'Too literal with English word order', correction: 'Prefer natural Spanish phrasing over direct translation' },
      ],
      phrasebook: [
        'Quiero reservar una mesa para dos. — I want to book a table for two.',
      ],
      profile: {
        name: 'Alex',
        level: 'advanced beginner',
      },
    },
    memories: [
      { id: 'mem-1', content: 'Learner wants immediate correction, not delayed notes.', category: 'preference', pinned: true },
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
