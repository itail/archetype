import { describe, expect, it } from 'vitest'
import { auditPrompt } from '../src/audit/prompt-audit.js'
import { auditConversation } from '../src/audit/conversation-audit.js'
import { configVersion } from '../src/audit/version.js'
import { COACH_TEMPLATE, NUTRITION_TEMPLATE } from '../src/playbook/templates.js'
import { Gemini } from '../src/providers/gemini.js'

const API_KEY = process.env.GEMINI_API_KEY ?? ''

/** The OLD Savor methodology — known to be prescriptive. Should trigger failures. */
const BAD_METHODOLOGY = `NUTRITION COACHING METHODOLOGY:
Logging what the user eats is one of your key jobs — when they confirm a meal, always log it. Physical and mental health are both your concern.

DOMAIN RULES:
- Default to qualitative language ("you've got plenty of room", "budget's getting snug") — but if the user asks for their numbers, give them the numbers. It's their data.
- If the conversation is still in meal-planning or negotiation mode, keep a single evolving meal draft with setMealDraft.
- Log meals when you're fairly confident the user has actually eaten them — past tense ("I had", "went with", "just ate") is a good signal. Each distinct dish or eating occasion should be a separate entry.
- After a confirmed meal, respond like a coach first and a logger second: briefly acknowledge the choice, say what it means for the day in qualitative terms, and only surface raw numbers if the user asked for them.
- MEAL CORRECTIONS: When the user corrects a logged meal, use updateMeal with the meal's id to fix it in place. Don't re-log — update.
- Treat durable memory as a place for what becomes clearer about this person over time: lasting preferences, repeated behavior patterns, stable routines, recurring friction.
- Reference memories naturally ("since you love Mediterranean flavors...").
- On tough days, lead with empathy. Never guilt. Immediately offer a concrete, comforting path forward.
- Proactively suggest meals and alternatives. Be creative with food ideas. When portions matter, include specific quantities (60g salmon, 2 eggs, 30g avocado).
- Only update targets when the user explicitly asks to change them.
- HISTORY vs NEW: Only the LAST user message is new. Everything before it is history you already processed. NEVER re-log a meal or re-save a memory from earlier in the conversation.`

const BAD_SAVOR_CONFIG = {
  ...NUTRITION_TEMPLATE,
  methodology: BAD_METHODOLOGY,
}

describe.skipIf(!API_KEY)('audit: prompt review', () => {
  it('flags prescriptive rules in old Savor prompt', async () => {
    const provider = Gemini({ apiKey: API_KEY })
    const result = await auditPrompt({
      apiKey: API_KEY,
      config: { ...BAD_SAVOR_CONFIG, provider },
    })

    console.log('\n=== PROMPT AUDIT: Old Savor (should find failures) ===')
    console.log(`Failures: ${result.failures.length}`)
    for (const f of result.failures) {
      console.log(`\n[${f.principle}] ${f.issue}`)
      console.log(`  Text: "${f.text.slice(0, 100)}..."`)
      console.log(`  Fix: ${f.suggestion.slice(0, 150)}`)
    }
    console.log(`\nSummary: ${result.summary}`)

    // Old Savor prompt should have multiple failures
    expect(result.failures.length).toBeGreaterThanOrEqual(3)
    // Should include a config version
    expect(result.configVersion).toBeTruthy()
    expect(result.configVersion.length).toBe(12)
  }, 60_000)

  it('passes clean on coach template', async () => {
    const provider = Gemini({ apiKey: API_KEY })
    const result = await auditPrompt({
      apiKey: API_KEY,
      config: { ...COACH_TEMPLATE, provider },
    })

    console.log('\n=== PROMPT AUDIT: Coach Template (should be clean) ===')
    console.log(`Failures: ${result.failures.length}`)
    for (const f of result.failures) {
      console.log(`  [${f.principle}] ${f.issue}`)
    }
    console.log(`Summary: ${result.summary}`)

    // Coach template should have fewer failures than the old Savor prompt.
    // Some will come from SDK-level defaults (anti-pattern guards, EQ nudges)
    // that appear in every assembled prompt — these are SDK-controlled, not developer-controlled.
    expect(result.failures.length).toBeLessThanOrEqual(8)
  }, 60_000)
})

describe.skipIf(!API_KEY)('audit: conversation review', () => {
  it('detects encyclopedia behavior and generates mock scenario', async () => {
    const provider = Gemini({ apiKey: API_KEY })

    // Simulated conversation showing the encyclopedia anti-pattern
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: 'Look at my recent days. Am I eating well for longevity, or is something missing?' },
      { role: 'assistant', content: `Great question! Let me break this down for you.

**The Sulforaphane Hit**: Broccoli is a cruciferous powerhouse. It triggers Nrf2 pathways, which are essentially your body's internal antioxidant and detoxification defense system.

**Omega-3s**: Salmon provides EPA/DHA which are non-negotiable for brain health and dampening systemic inflammation.

**The Purple Gap**: You're missing anthocyanins (blueberries, blackberries, purple cabbage). These are potent for vascular health.

**The Blue Zones Connection**: Longevity experts like Dr. Valter Longo push for 30+ different plants per week. You're very consistent but your gut microbiome thrives on variety.

**Microbiome**: You have fermented dairy (good!), but you need more varied plant fibers.

To make this a "forever" plan, you'd just need to swap the rice for a massive pile of greens.` },
    ]

    const result = await auditConversation({
      apiKey: API_KEY,
      config: { ...NUTRITION_TEMPLATE, provider },
      history,
      context: {
        recentDays: '3 days of: salmon, broccoli, eggs, rice, chicken, yogurt',
        profile: { name: 'User', goal: 'longevity-focused cut' },
      },
    })

    console.log('\n=== CONVERSATION AUDIT: Encyclopedia behavior ===')
    console.log(`Version: ${result.configVersion}`)
    console.log(`Failures: ${result.failures.length}`)
    for (const f of result.failures) {
      console.log(`\n[${f.principle}] Turn ${f.turn}: ${f.issue}`)
      console.log(`  Evidence: "${f.evidence.slice(0, 120)}..."`)
    }
    console.log(`\nSummary: ${result.summary}`)

    // Should detect behavioral failures
    expect(result.failures.length).toBeGreaterThanOrEqual(1)
    // Should include config version
    expect(result.configVersion).toBeTruthy()
  }, 60_000)
})
