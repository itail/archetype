/**
 * Nutrition Guide example — shows how a nutrition app would use Archetype.
 *
 * Run: npx tsx examples/nutrition/index.ts
 * Requires: GEMINI_API_KEY env var
 */
import { definePersona, Gemini } from '../../src/index.js'
import { NUTRITION_TEMPLATE } from '../../src/playbook/templates.js'

const guide = definePersona({
  ...NUTRITION_TEMPLATE,
  provider: Gemini({ model: 'gemini-3.5-flash' }),
})

async function main() {
  console.log(`\n🥗 ${guide.name} (${guide.providerName})\n`)

  const result = await guide.chat({
    message: "I just had a big lunch — chicken shawarma bowl with rice and hummus. Probably around 800 calories. What should I aim for at dinner to stay on track?",
    history: [],
    context: {
      todayStatus: {
        date: new Date().toISOString().slice(0, 10),
        consumed: '1200 cal, 80g protein, 140g carbs, 35g fat',
        remaining: '600 cal, 70g protein, 40g carbs, 20g fat',
      },
      profile: {
        name: 'Jamie',
        goal: 'Lose weight',
        dailyTargets: '1800 cal, 150g protein, 180g carbs, 55g fat',
      },
    },
    memories: [
      { id: 'm1', content: 'Loves Mediterranean flavors, especially za\'atar', category: 'preference', pinned: true },
      { id: 'm2', content: 'Mildly lactose intolerant — can handle aged cheese', category: 'health' },
    ],
    timezone: 'America/New_York',
    userIdentity: 'Jamie',
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
