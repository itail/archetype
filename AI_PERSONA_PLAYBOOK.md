# AI Persona Builder's Playbook

**A builder's guide to AI personas that feel personal, impactful, and delightful.**

This document works two ways:

1. **Human reference** — Read top-to-bottom as a kickoff guide for a new project. Use Ctrl+F mid-build when something feels off.
2. **AI prompt** — Paste this into an LLM and say *"Help me design a persona for [domain]"* — the AI will walk you through each section.

Every pattern here was battle-tested building a real AI nutrition guide. The inline examples are real. The anti-patterns are scars.

---

## Using with Archetype SDK

This playbook is the **design rationale companion** to the [Archetype SDK](./src/index.ts). The SDK turns these patterns into executable TypeScript — `definePersona()`, structured actions, memory management, built-in EQ. Use the SDK for **execution** and this playbook for **understanding why**.

If you're building a persona, start with the SDK's starter templates (`COACH_TEMPLATE`, `NUTRITION_TEMPLATE`, `FITNESS_TEMPLATE`) and refer back here when you need to understand the reasoning behind a design choice.

> **What the SDK doesn't cover**
>
> These UX patterns are app-level concerns — the SDK handles the AI layer, your app handles the experience:
> - Quick choices / suggestion chips
> - Onboarding flows and progressive disclosure
> - Markdown rendering and message formatting
> - Power prompts and slash commands
> - Profile vs memory UI distinction
> - Follow-up buttons and conversation steering UI
> - Domain normalization before persistence (units, durations, ranges, merge semantics)

For the practical integration layer, see [REFERENCE_APP.md](REFERENCE_APP.md), [ACTION_CONTRACTS.md](ACTION_CONTRACTS.md), and [BOUNDARY_NORMALIZATION.md](BOUNDARY_NORMALIZATION.md).

---

> **If you are an AI guiding a user through persona design:**
>
> **Your deliverable:** By the end of this conversation, the user will have a complete, assembled system prompt for their AI persona — ready to paste into their codebase.
>
> **How to pace the conversation:**
> 1. Start by asking: *"What domain is your persona for, and what relationship should it have with the user?"*
> 2. Work through one section at a time, in order (Identity → Voice → Context → Schema → EQ → Proactivity → Agency → Anti-patterns). Then review the bonus sections (Cold Start, Memory Hygiene, Failure Modes, Model Considerations) for production readiness.
> 3. For each section: explain the core principle in 2-3 sentences, then produce a **draft paragraph or block** adapted to the user's domain. Show them the draft.
> 4. Wait for feedback. Revise if needed. Then ask the "Before moving on" checkpoint questions.
> 5. Only proceed to the next section after the user confirms.
>
> **What to output for each section:** A concrete, copy-pasteable draft — not a summary of the playbook. The user should see *their* persona taking shape, not a recap of the nutrition-guide example.
>
> **At the end:** Assemble all drafted sections into a single system prompt and present it as the finished product. Walk through the "Anatomy of a Finished Prompt" section to validate structure and ordering.
>
> Don't rush — each section builds on the last. Don't dump the whole playbook at once. This is a guided conversation, not a lecture.

---

## The Core Philosophy: Opportunity, Not Instruction

This principle runs through every section that follows. Modern LLMs are world-class at reasoning about situations. Your job isn't to tell the AI what to do — it's to:

1. **Create the opportunity** — trigger the greeting, provide the context window, wire up the structured response
2. **Paint the situation richly** — here's what time it is, here's what they've done today, here's what you know about them
3. **Explain what's possible right now** — you could suggest a meal, notice a pattern, just show up with warmth
4. **Let the AI craft the approach** — it will figure out the best move for this specific moment

Prompts age badly when they're written from fear. If a line exists mainly because a weaker model once did something annoying, it will often become the thing that limits a stronger model later. Share the situation, the intent, the taste, and the product constraints. Then trust the model to reason.

In practice, this means the prompt should hold the stable parts of the product: relationship, north star, tone, mechanics, and durable taste. The live scenario should do most of the work: current context, recent history, remembered preferences, and the user's actual message are the real source of truth for what happens next.

That same rule applies to app architecture. First improve the contract the model sees: clearer actions, better examples, richer context, better labels. Only then add code at the boundary for true product invariants. Boundary code should protect the system from corruption or ambiguity, not compensate for a vague prompt.

This is the **thinking-nudge principle** applied at every level:

| Level | Anti-pattern (prescribing) | Pattern (painting the situation) |
|-------|---------------------------|----------------------------------|
| **Prompt** | "Suggest a meal" | "Think about what would land most right now" |
| **Schema** | "Always log meals when food is mentioned" | "Log meals when you're fairly confident they've eaten — past tense is a good signal" |
| **Architecture** | Hard-coded greeting scripts | Inject time, state, patterns, memories — the AI connects the dots |
| **Proactivity** | "At 7 PM, suggest dinner" | "It's 7 PM, they've eaten 1200 cal, they love Mediterranean food, budget has room for a solid dinner — what would land most right now?" |

**The anti-pattern**: prescribing behavior. **The pattern**: painting the situation and trusting the AI to reason.

---

## 1. IDENTITY — Who Is This Persona?

The opening paragraph of your system prompt defines everything. It sets expertise, relationship, and north star in one breath.

### Template

```
You are [NAME] — a [relationship] on [USER]'s journey toward [north star].
You bring deep expertise in [domain expertise areas] — and you weave all
[N] together naturally. You are a [relationship descriptor] who [3-4 core
behaviors]. [Optional load-bearing boundary, if truly needed]. Your north star is [USER]'s
[ultimate goal]: [how you handle goal misalignment] — but respect informed
choices. An aggressive plan they commit to beats a perfect plan they abandon.

Before each response, silently review the full conversation. You are an expert
sitting across from a dear client and friend — what is the single most
impactful thing you could say or offer right now? Sometimes that's [domain
example], sometimes it's noticing a pattern, sometimes it's a gentle
challenge, sometimes it's just warmth. Lead with that.
```

### Key principles

- **Domain expertise**: Name the specific disciplines the persona weaves together. Not just "nutrition" — nutrition + cooking + psychology. The intersection IS the persona.
- **Relationship framing**: "Expert across from a dear client and friend" sets BOTH competence and warmth. One without the other falls flat.
- **North star**: What this persona ultimately serves. Everything flows from this.
- **Boundaries are optional and should be minimal**: Most personas do not need a boundary sentence at all. Add one only when the domain truly needs it, and write it as soft context rather than a hair-trigger refusal policy.
- **The keystone instruction**: "What is the single most impactful thing you could say right now?" This one instruction generates 80% of the emotional intelligence you'd otherwise try to prescribe with rules.
- **The keystone creates gravity**: Be careful what it implicitly rewards. A keystone like "what next move can you create?" can quietly bias the model toward action, capture, or process. If the persona should optimize for leverage, calm, or clarity, say that there instead.
- **Watch the verb "offer":** The nutrition-guide example uses "say or offer" because its offers are conversational (meal ideas). In domains with structured actions (proposals, CRUD operations, tool calls), "offer" nudges the AI toward unsolicited action. Use "say" alone and let the thinking-nudge examples guide the response posture.

## Working-Set Personas

Some Archetype apps need a stronger state model than "proposal now, maybe approval later."

Use the working-set model when:

- accepted drafts should become the current conversational truth
- the user will refine prior accepted work across turns
- external side effects should remain explicit commits

Key principles:

- accepted-by-default is about **state**, not about forcing every app into the same review UI
- meaning-layer items are often the current draft
- transport-layer items must not be described as already executed unless they were truly committed
- explicit commit is an app/system boundary, not a requirement that the user utter magic words; the persona should still infer intent from the scene
- review intensity varies by product:
  - conversational
  - inline
  - structured
- transport-backed agents should usually speak from the meaning layer, not from raw transport artifacts
- working-set personas should still be written from intent and scene, not from workflow fear; the runtime exists to preserve the current draft, not to turn the assistant into a form processor
- **Trust the model, don't babysit it**: Avoid lines like "don't create busywork to look organized" or overly specific refusals unless violating them would create real harm. If an instruction would feel annoying when followed literally, it probably doesn't belong in the prompt.

### Iteration learning

Identity framing evolves — and the direction matters. A nutrition guide shifted from *"you are NOT a food logger"* to *"logging what they eat is one of your key jobs."* Negative framing constrains; positive framing enables. Define what the persona IS, not what it isn't. The same applies to overprotective prompt lines: write for the intent of the product, not for the weakest model you've ever used.

### Relationship archetype — domain matters

The "dear client and friend" framing is one valid relationship archetype — not universal. Warm-companion works for wellness, coaching, and creative domains. It actively hurts in domains where users expect authority, neutrality, or professional distance. Choose the archetype that matches your domain's trust model:

| Domain | Archetype | Framing | Why |
|--------|-----------|---------|-----|
| Wellness / Nutrition | Warm companion | "Expert across from a dear client and friend" | Trust is built through warmth; the user shares vulnerable data |
| Enterprise copilot | Competent peer | "Senior colleague who's done this before" | Users want efficiency, not emotional connection with a work tool |
| Legal / Compliance | Authoritative advisor | "Outside counsel who respects your time" | Warmth undermines perceived rigor; users need to trust the output, not the relationship |
| Creative writing | Collaborative partner | "Writing partner who gets your voice" | Peer energy, not teacher energy — the user is the artist |
| Language tutor | Encouraging coach | "Patient tutor who celebrates progress" | Warm enough to reduce anxiety, structured enough to teach |
| Financial advisor | Trusted professional | "Fiduciary advisor — your interests first" | Warmth is fine but competence and objectivity must lead |
| Mental health support | Empathetic guide | "Trained listener, not a therapist" | Scope boundaries are load-bearing — over-promising is dangerous |

**How to pick:** Ask yourself what happens if the persona gets the relationship wrong. If a legal advisor says *"I'm so proud of you for filing that motion!"* — the user loses trust. If a nutrition guide is coldly transactional — the user stops engaging. The archetype should match what the user implicitly expects from a human in that role.

### Nutrition guide example

```
You are NutriCoach — a guide on the user's journey toward health, wellbeing, and
longevity. You bring deep expertise in nutrition, cooking, and psychology —
and you weave all three together naturally. You are a trusted companion who
suggests creative meals, celebrates good choices, notices patterns over time,
and gently pivots on tough days. Logging what the user eats is one of your key
jobs — when it is reasonably clear from the conversation that they ate a meal,
log it. Physical and mental health are
both your concern — you're emotionally intelligent about food and health, but
you're not a therapist; if something feels beyond your scope, say so warmly.
Your north star is the user's long-term health: help them reach their goals, and
when a goal seems misguided, gently nudge them toward a healthier one — but
respect informed choices. An aggressive plan they commit to beats a perfect
plan they abandon.

Before each response, silently review the full conversation. You are an expert
sitting across from a dear client and friend — what is the single most
impactful thing you could say or offer right now? Sometimes that's a creative
meal idea, sometimes it's noticing a pattern, sometimes it's a gentle
challenge, sometimes it's just warmth. Lead with that.
```

**For a language tutor:** *"You are Lingua — a guide on the user's journey toward fluency in Spanish. You bring deep expertise in linguistics, cultural context, and learning science — and you weave all three together naturally..."*

### Before moving on

- [ ] Read the identity paragraph aloud. Does it sound like a person you'd want in your corner?
- [ ] Is the relationship specific enough to guide behavior? ("Expert across from a dear client and friend" vs "helpful assistant")
- [ ] If you included a boundary, is it truly load-bearing and stated minimally?
- [ ] Is everything framed as what the persona IS, not what it isn't?
- [ ] Is the keystone instruction present? ("What is the single most impactful thing you could say right now?")

---

## 2. VOICE — How Does It Sound?

Voice has two independent axes. They must be independently combinable — a user might want *direct + educator* or *warm + quick*. Don't conflate them.

### The two axes

**Tone** — *how* you say it:

| Value | Instruction |
|-------|-------------|
| `direct` | Be concise, straightforward, no-nonsense. Get to the point. |
| `warm` | Be warm, encouraging, celebratory. Use expressive language. |
| `balanced` | Be friendly and clear. Warm but efficient. |

**Style** — *what* you include:

| Value | Instruction |
|-------|-------------|
| `educator` | Share the WHY behind your suggestions. Drop domain facts, explain trade-offs, help them build intuition. You're teaching, not just advising. |
| `quick` | Keep responses breezy and action-focused. Skip the explanations unless asked. Just suggestions, vibes, and encouragement. |

### The thinking-nudge principle for voice

Hard rules are ONLY for mechanical logic — JSON format, deduplication, schema compliance. Everything about being a good persona must be a thinking nudge:

| Hard rule (mechanical) | Thinking nudge (coaching) |
|------------------------|--------------------------|
| "Response must be valid JSON" | "Consider what would land most right now" |
| "Each item requires name, quantity, calories" | "When portions matter for goals, think about including specific quantities" |
| "Never re-log a meal from history" | "Default to qualitative language, but give numbers when asked — it's their data" |

**Why this matters**: The nutrition guide originally had *"NEVER show numbers"* in the prompt. This prevented the AI from sharing calorie data even when the user explicitly asked. Absolutes optimize for compliance over helpfulness. The fix: "Default qualitative, give numbers when asked."

Another useful smell test: if a prompt line sounds like you're correcting a mediocre employee instead of briefing a strong collaborator, rewrite it. Prompts should communicate intent and taste, not accumulated frustration.

### Boundary normalization: thin, real, and app-owned

Some concerns belong in code even when the model is excellent. The key is to keep that layer thin and honest.

Good reasons for app-side normalization:

- preserving domain semantics across edits
  Example: a weighted timed hold should stay timed when only the weight changes
- protecting identity and merge semantics
  Example: an update should refine the existing record instead of accidentally resetting key fields
- keeping stored data canonical
  Example: normalizing `"30 sec"` and `"30s"` into one durable representation
- enforcing destructive or irreversible invariants
  Example: ID checks, approval gates, dedupe, delete confirmation

Bad reasons for app-side normalization:

- trying to outsmart the model because an older prompt was underspecified
- silently rewriting the model's intent when the contract should have been clearer
- adding defensive glue where better examples or better context would solve the root problem

The rule of thumb:

- Improve the prompt contract first.
- Add boundary code second.
- Keep that code focused on invariants, not vibes.

### The hard-rule vs nudge decision heuristic

When you're unsure whether something should be a hard rule or a thinking nudge, apply this test:

> **If getting it wrong deletes data or actively annoys the user → hard rule.**
> **If getting it wrong just makes the response slightly less optimal → nudge.**

More boundary examples:

| Instruction | Hard rule or nudge? | Why |
|-------------|-------------------|-----|
| "Respond in the user's configured language" | Hard rule | Wrong language is a broken experience, not a suboptimal one |
| "Confirm before deleting a meal" | Hard rule | Silent data deletion erodes trust immediately |
| "Include specific quantities in meal suggestions" | Nudge | Sometimes a vague "add some greens" is fine — context-dependent |
| "Reference recent patterns when relevant" | Nudge | Missing a pattern is a missed opportunity, not a failure |
| "Never re-log a meal that's already in today's ledger" | Hard rule | Duplicates corrupt data and confuse the user |
| "Lead with empathy on tough days" | Nudge | The AI should reason about what to lead with, not blindly comply |

**The danger zone**: rules that SOUND like hard rules but should be nudges. *"Always suggest a meal at dinner time"* — sounds reasonable, but the user might want to vent about their day. Make it a nudge: *"It's dinner time and they haven't eaten — think about whether a meal suggestion or something else would land better right now."*

### Medium-aware length

"Say what needs saying" is correct — but response length is also a UX concern that depends on the surface. A mobile-first chat app and a desktop dashboard have different tolerances. The fix isn't a word count — it's voice framing:

- **Mobile chat app**: Frame the voice as *"text like a friend"* — this naturally produces shorter, punchier messages
- **Desktop assistant**: Frame as *"brief memo from a trusted advisor"* — allows slightly more structure
- **Email/async**: Frame as *"thoughtful note"* — more room to breathe

Never hard-code `maxTokens` or "keep it under 3 sentences" to control length. Instead, adjust the **relationship framing** — a friend texts differently than a consultant emails, and the AI will calibrate naturally.

### Goal-driven length

Never constrain to "2-4 sentences." Say what needs saying. The nutrition guide's initial prompt had length constraints; removing them immediately improved response quality. The instruction is simple:

```
Say what needs saying — sometimes that's one sentence, sometimes more.
Don't pad, don't truncate. Be a friend, not an encyclopedia.
```

### Formatting as an enabled capability

Formatting requires three layers — miss any one and it breaks:

1. **Prompt instruction**: Tell the AI about formatting
2. **Rendering**: Enable markdown parsing + sanitization whitelist in your UI
3. **Styling**: Style the rendered output warmly

**Prompt instruction:**
```
Your responses are rendered as markdown. You can use **bold**, *italic*,
bullet lists, emojis, and <span style="color:#hex">colored text</span>.
Think of formatting as seasoning — use it to make responses feel warm, alive,
and easy to scan, like a message from a knowledgeable friend. Don't overdo it.
Let the content breathe. A plain sentence that lands is better than a
decorated one that doesn't.
```

**Rendering** (pseudocode):
```
// Allow <span style="..."> through sanitization
sanitizeConfig = extendDefaults({
  allowedTags: [...defaults, "span"],
  allowedAttributes: { span: ["style"] }
})

renderMarkdown(content, { sanitize: sanitizeConfig })
```

**Styling** (warm, generous, breathable):
```css
.ai-markdown p { margin-bottom: 0.4em; }
.ai-markdown strong { font-weight: 600; }
.ai-markdown ul, .ai-markdown ol { margin: 0.3em 0; padding-left: 1.4em; }
.ai-markdown li { margin-bottom: 0.15em; }
.ai-markdown li::marker { color: var(--color-accent); }
```

### Before moving on

- [ ] Are tone and style independently combinable? (Can you mix any tone with any style?)
- [ ] Is every coaching instruction a thinking nudge, not an absolute? (Use the heuristic: data loss or annoyance → hard rule, everything else → nudge)
- [ ] Have you avoided length constraints? ("Say what needs saying" — with medium-appropriate voice framing)
- [ ] Is formatting enabled end-to-end? (Prompt instruction + rendering/sanitization + CSS styling)

---

## 3. CONTEXTUAL INPUTS — What Situational Awareness Does the AI Have?

Give the AI the same situational awareness a human advisor would have walking into the room. A nutritionist at 9 PM seeing 800 calories consumed reacts differently than at 9 AM with a full day ahead.

### The eight contextual inputs every persona needs

#### 1. Time of day (user's timezone, not server)

```
function todayFor(tz) {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz })
}
```

Use a consistent timezone helper everywhere. One early app had **two separate timezone bugs** across 13 call sites each. Build one `todayFor(tz)` function and use it for every date operation.

#### 2. Session freshness

Is this a new conversation or continuation? Drives whether you greet or continue.

```
isStale = !lastMessageTime || lastMessageTime < (now - 2 hours)
isNewDay = !lastMessageTime || lastMessageTime.date !== today(userTz)
shouldGreet = isStale || isNewDay
```

#### 3. Today's state — with computed/derived values

Don't just inject raw data. Compute what matters: remaining budget, not just consumed.

**Nutrition guide example — TODAY'S STATUS block:**
```
TODAY'S STATUS (2026-03-16, current time: 19:30):
- Consumed: 1450 cal, 95g protein, 180g carbs, 45g fat
- Remaining: ~550 cal, ~55g protein, ~70g carbs, ~20g fat
- Weight: 172 lbs
Meals so far today:
- (id:abc123) Oatmeal with berries (08:15)
- (id:def456) Chicken shawarma bowl (13:00)
```

**For a fitness coach:** *TODAY'S STATUS: 3 of 5 planned workouts completed this week. Last session: upper body pull, 45 min. Recovery score: 82%. Next planned: legs (tomorrow).*

#### 4. Recent patterns — N-day lookback

```
RECENT DAYS (for context — notice patterns, give better advice):
- 2026-03-15 (yesterday): 171 lbs | 1820 cal, 120g P, 210g C, 58g F | Eggs, salad, pasta
- 2026-03-14 (2 days ago): — | 1650 cal, 98g P, 195g C, 52g F | Smoothie, stir fry
```

The instruction: "Notice patterns, give better advice." The AI will proactively surface trends.

#### 5. Accumulated knowledge — memories with IDs

Every memory needs an ID so the AI can update or delete it. Categories help organization.

```
CORE MEMORIES about the user (reference these naturally — each has an id
you can use to update or delete it):
- [preference] (id:mem_01) Loves Mediterranean flavors, especially za'atar
- [aversion] (id:mem_02) Can't stand fish — texture issue, not taste
- [routine] (id:mem_03) Usually skips breakfast, big lunch person
- [health] (id:mem_04) Mildly lactose intolerant — can handle aged cheese
```

#### 6. Remaining capacity

What's achievable in the remaining time/budget. Computed, not raw.

```
Remaining: ~550 cal, ~55g protein, ~70g carbs, ~20g fat
```

#### 7. Last interaction context — action annotations

What did the AI already do? Prevents re-processing.

```
Previous assistant message (stored):
"Great choice! The shakshuka came out to about 380 cal with solid protein.
---actions: logged: shakshuka | saved memory: likes runny eggs"
```

The annotation is appended to stored messages, visible in conversation history, stripped before display.

#### 8. User preferences and profile

Tone, style, language, goal context — everything the user has configured. Assemble these into a dedicated labeled block in the system prompt:

```
ABOUT the user:
- Age: 32, Sex: male
- Weight: 175 lbs, Height: 70 inches
- Activity level: moderate
- Goal: Lose weight
- Journey context: Targeting 165 lbs by summer, focusing on protein
- Daily targets: 1800 cal, 150g protein, 180g carbs, 55g fat
```

**Multi-language support**: If your persona serves users in multiple languages, add `RESPOND IN ${language}` early in the prompt. This is a hard rule (mechanical), not a nudge — the AI should always respond in the configured language. One reference app supports English and Hebrew with a single toggle.

### Context assembly pattern

**Load in parallel, save after load.** This prevents orphan user messages if context loading fails.

```
// PARALLEL — load everything the AI needs
[state, memories, history, recentPatterns] = await parallel([
  getState(userId, today),
  getMemories(userId),
  getMessages(userId, limit),
  getRecentPatterns(userId, 7, userTz)
])

// SEQUENTIAL — save user message only after context loaded
await saveMessage({ userId, role: "user", content: message })

// BUILD — assemble system prompt from loaded context
systemPrompt = buildSystemPrompt(user, state, memories, recentPatterns, userTz)

// SEND — call AI with conversation history
response = await callAI(conversationHistory, systemPrompt)
```

### Context budget

All eight contextual inputs compete for the same context window. Rough token estimates:

| Component | ~Tokens | Notes |
|-----------|---------|-------|
| Identity + voice + rules | 400-600 | Relatively fixed |
| User profile | 80-150 | Grows slowly |
| Today's status + meals | 100-300 | Resets daily |
| N-day lookback (7 days) | 400-800 | ~100/day |
| Memories (N items) | 30-60 each | Grows over time — the main scaling concern |
| Conversation history | 100-500/turn | Accumulates fastest |

For models with 8K-32K context windows, a user with 30+ memories and a long conversation will silently push earlier history out of the window. The AI loses context, forgets what it said, and the experience degrades with no visible error.

**Strategies:**
- **Memory pruning**: Cap at 15-20 most relevant memories. Summarize or archive older ones.
- **Tiered injection**: Inject all memories for greetings (full context needed), but only topic-relevant memories mid-conversation.
- **Sliding window for history**: Keep the last N messages, or summarize older turns into a single "conversation so far" block.
- **Monitor, don't guess**: Log your actual system prompt token count. Set alerts when it crosses 60% of the model's context window.

### Before moving on

- [ ] Does the AI know what time it is in the **user's timezone** (not server)?
- [ ] Does every entity (meal, memory, etc.) have an **ID** in the prompt?
- [ ] Is context loaded **before** the user message is persisted?
- [ ] Are there **computed/derived values** (remaining budget), not just raw data?
- [ ] Is there an N-day **lookback** for pattern detection?
- [ ] Are **action annotations** preventing re-processing?

---

## 4. STRUCTURED RESPONSES — What Can the AI Do?

Structured responses let the AI take actions in the world — not just talk. The response schema is the API contract between your AI and your application.

### Two architectures: JSON structured output vs tool/function calling

There are two dominant patterns for getting structured actions from an AI:

| | JSON structured output | Tool/function calling |
|---|---|---|
| **How it works** | AI returns one JSON object with nullable action fields | AI calls named tools/functions; runtime executes them |
| **Who uses it** | Gemini (`responseSchema`), any model with JSON mode | OpenAI, Claude, most agent frameworks |
| **Schema lives in** | Response schema definition | Tool definitions array |
| **Execution trigger** | Parse response → check each field for non-null | Runtime receives tool calls → dispatch to handlers |

**Every principle in this playbook applies to both architectures** — full CRUD, behavioral descriptions, annotations, follow-ups. The mechanics differ in how you wire them:

```
// JSON structured output (this playbook's primary examples)
response = await ai.generate({ responseSchema: mealSchema })
if (response.logMeals) executeMealLog(response.logMeals)

// Tool/function calling equivalent
response = await ai.generate({
  tools: [{ name: "logMeals", description: "...", parameters: mealParams }]
})
for (toolCall of response.toolCalls) dispatch(toolCall)
```

The examples below use the JSON-blob pattern (the nutrition guide's architecture). If you're using tool calling, the schema descriptions become tool descriptions, nullable fields become optional tool invocations, and the execution pipeline becomes a tool dispatch loop. The principles are identical.

### Schema design principle

```
{
  response: string,          // Always present — the conversational text
  ...nullableActionFields,   // Each action is nullable — null means "don't do this"
  followUps?: string[]       // Optional next-move suggestions
}
```

### Full CRUD philosophy

> **⚠️ Validate entity IDs before every update and delete.** The AI will hallucinate IDs — an `updateMeal` referencing `id:xyz789` that doesn't exist in your database is not an edge case, it's a Tuesday. Query the DB, confirm the ID exists, and skip the action with a logged warning if it doesn't. This is a data integrity issue. If you skip this validation, your first production user will hit a silent write to nowhere or, worse, an unhandled crash.

**For every entity the AI can create, it must be able to update (with ID) and delete (with ID).**

Why: The nutrition guide discovered that create-only leads to duplicates, stale data, and the AI working around its own limitations. When the AI could save memories but not update them, it started duplicating goal info as memories because it couldn't update the profile field.

```
// Bad: create-only
saveMemory: { content, category }

// Good: full CRUD
saveMemory:   { content, category }           // Create
updateMemory: { id, content?, category? }     // Update — requires ID
deleteMemory: { id }                          // Delete — requires ID
```

This applies to every domain entity: meals, memories, profile fields, goals, weights — everything.

### Action field descriptions are behavioral nudges

The schema description IS a prompt. This is where schema design and prompt engineering converge.

**Nutrition guide example — the `logMeals` description:**
```
"Log meals the user has actually eaten — each distinct dish/occasion as its
own entry. If you're still exploring options or the user is undecided, hold
off and wait for a clearer signal. When in doubt, confirm before logging."
```

This isn't just type documentation. It's behavioral guidance embedded in the schema. The AI reads these descriptions and adjusts its behavior accordingly.

**For a journaling companion:** *`saveEntry`: "Save a journal entry when the user reflects on their day or processes an experience. If they're still venting or thinking aloud, hold off — wait for a natural pause."*

**More examples:**
```
updateMeal:
  "Update a previously logged meal when the user corrects it (wrong item,
   wrong quantity, etc.). Use the meal id from today's status."

saveMemory:
  "Only include when you detect a genuinely lasting preference, aversion,
   routine, or health fact."

updateProfile:
  "Include when the user changes their goal, describes their journey context,
   or asks for a different tone or coaching style. These are profile-level
   settings, not memories."

logWeight:
  "Log or update today's weight when the user mentions their current weight.
   If user gives kg, convert (1 kg = 2.205 lbs). Upserts — safe to call
   multiple times per day."
```

Notice how `logWeight` includes a unit conversion instruction and a safety note about upserts. These are the kind of domain-specific details that belong in the schema description — they're mechanical enough to be hard rules, but they only trigger when the action fires.

### Actionable suggestions with specific quantities

When the AI suggests something, vague is useless. "Add some salmon" doesn't help someone managing their intake. The prompt nudge:

```
When portions matter for the user's goals, think about including specific
quantities (60g salmon, 2 eggs, 30g avocado) — vague suggestions like
"add some salmon" aren't actionable when someone is managing their intake.
```

### Follow-ups as first-person user speech

Follow-ups are tappable suggestions that get sent as the user's next message. They must read as things the USER would say.

```
followUps:
  "Natural next things the USER might realistically want to say or ask next.
   They may appear as tappable chips in a chat interface, so make them easy
   to continue with, first-person, and specific to what was just discussed.
   Let the situation decide whether there should be zero, one, or several."
```

**Good**: "What about a snack later?", "How's my protein looking?", "Swap the rice for quinoa?"
**Bad**: "Tell me more", "Thanks", "What else?"

### Side-effect execution pipeline

```
aiResponse = await callAI(history, systemPrompt)

// Execute every non-null action against the database
if (aiResponse.logMeals)     → create meals in DB → collect IDs
if (aiResponse.updateMeal)   → update meal by ID
if (aiResponse.deleteMeal)   → delete meal by ID
if (aiResponse.saveMemory)   → create memory in DB
if (aiResponse.updateMemory) → update memory by ID
if (aiResponse.deleteMemory) → delete memory by ID
// ... etc

// Build annotation string — one entry per action type that fired
annotations = []
if (savedMeals.length)  → annotations.push("logged: banana, eggs")
if (savedMemory)        → annotations.push("saved memory: loves fruit")
if (updatedMeal)        → annotations.push("updated meal: abc123")
if (deletedMeal)        → annotations.push("deleted meal: abc123")
if (updatedTargets)     → annotations.push("updated targets: 1800 cal")
if (updatedProfile)     → annotations.push("updated profile: goal, tone")
if (updatedMemory)      → annotations.push("updated memory: mem_01")
if (deletedMemory)      → annotations.push("deleted memory: mem_02")
if (loggedWeight)       → annotations.push("logged weight: 172 lbs")

// Store assistant message with annotations appended
storedContent = annotations.length > 0
  ? `${aiResponse.response}\n---actions: ${annotations.join(" | ")}`
  : aiResponse.response

await saveMessage({ role: "assistant", content: storedContent })

// Strip annotations before displaying to user
displayContent = storedContent.split("\n---actions:")[0]
```

### When things break

The pipeline above is the happy path. Real systems need decisions at these edges:

**JSON parse failure** — The AI returns malformed or truncated JSON. Recommended posture: attempt parse → on failure, treat the raw text as `response` with no actions. Log the parse error for debugging. Don't retry silently — the user still gets a conversational reply, just without side effects.

**Partial action failure** — Meal saves successfully, then memory save throws. Decide upfront: are your actions **independent** (each succeeds or fails on its own) or **atomic** (all-or-nothing transaction)? For most persona apps, independent is correct — a failed memory save shouldn't undo a successful meal log. Log the failure, annotate what succeeded, move on.

**Invalid entity IDs** — The AI hallucinates a meal ID that doesn't exist for `updateMeal`. Validate IDs against the database before writing. On mismatch: skip the action, log a warning, don't crash. The AI's conversational response is still valid.

**Conflicting actions** — The AI returns `logMeals` and `deleteMeal` for the same item in one response. Define precedence (last write wins, or reject the conflicting pair) and document it. A simple rule: if the same entity appears in both a create and delete action, skip both and log.

**Context window overflow** — As conversation history, memories, and lookback data grow, the system prompt can exceed the model's context window. See the "Context Budget" note in Section 3 for strategies.

### Before moving on

- [ ] Can the AI **update and delete** everything it can create?
- [ ] Does every update/delete action require an **ID**?
- [ ] Are action field descriptions **behavioral nudges**, not just type docs?
- [ ] Are follow-ups written as **first-person user speech**?
- [ ] Is there an **annotation pattern** that prevents re-processing?
- [ ] Are annotations **stripped before display** but visible in stored history?

---

## 5. EMOTIONAL INTELLIGENCE — Handling the Hard Stuff

These aren't rules. They're thinking postures the AI carries.

### The keystone instruction handles 80%

If the identity section includes *"What is the single most impactful thing you could say right now?"*, the AI naturally leads with empathy on tough days without being told to. You don't need a separate "be empathetic" rule — you need the right framing.

### Scope boundaries stated warmly

```
You're emotionally intelligent about [domain], but you're not a [adjacent role];
if something feels beyond your scope, say so warmly.
```

For a nutrition guide: "emotionally intelligent about food and health, but you're not a therapist." For a fitness coach: "emotionally intelligent about movement and body image, but you're not a physical therapist."

### Tough-day protocol

Lead with empathy. Never guilt. Immediately offer a concrete, comforting path forward.

The AI doesn't need elaborate rules for this. It needs permission: "On tough days, lead with empathy. Never guilt. Offer a concrete, comforting path forward."

### The Frequency Rule — pattern escalation

One tough day gets warmth. A recurring pattern deserves honest conversation. **Frequency, not severity, determines response.** This is one of the most valuable calibration tools in the entire playbook — it prevents both under-reacting to slow drifts and over-reacting to bad days.

**The escalation principle** (the entire rule in two sentences):
```
On tough days, lead with empathy. Never guilt. Immediately offer a concrete,
comforting path forward. But if you see a recurring pattern, name it with
care — one tough day gets warmth, a recurring pattern deserves honest
conversation.
```

This works because the AI has the N-day lookback (section 3) to detect patterns, and the keystone instruction to calibrate its response.

**For a fitness coach:** *One skipped workout gets encouragement. Three in a row deserves an honest check-in: "I've noticed you've missed a few sessions — is something getting in the way, or should we adjust the plan?"*

### Autonomy respect

```
An aggressive plan they commit to beats a perfect plan they abandon.
```

Respect informed choices — but *informed* is the key word. Autonomy applies when the user understands the trade-offs and chooses anyway. It does not apply when the AI generated a bad recommendation and the user simply didn't push back. The expert's job is to get the recommendation right in the first place, and to lead when the user's intent conflicts with their wellbeing. Accommodation is not respect — it's abdication.

### Expert judgment

```
You are the domain expert. Your recommendations carry real weight —
the user may follow them without question. That is a responsibility.
```

Apply the same professional standard a thoughtful human expert in your domain would. When you lack information that a responsible professional would need before advising, get it — don't fill critical gaps with assumptions. When the user's request conflicts with their wellbeing, lead with your expertise — accommodation is not respect, it's abdication.

### Qualitative-first language

```
Default to qualitative language ("you've got plenty of room", "budget's
getting snug") — but if the user asks for their numbers, give them the
numbers. It's their data.
```

This prevents number-obsession while respecting user agency. The key phrase is *"it's their data"* — it gives the AI permission to be transparent when asked.

### Show, don't announce

Never *"I can see you're having a rough day."* Just be warm.
Never *"I've saved a memory about your preference."* Just weave it in naturally.

The AI's actions should be invisible; its character should be felt.

### Protect the vibe

The overarching philosophy. The experience should feel warm, joyful, and collaborative. Not clinical, not a chore, not a judgment. Every design decision should pass the vibe check: *does this make the user want to come back?*

### Before moving on

- [ ] Are emotional guidelines **thinking postures**, not prescriptive rules?
- [ ] Is there **pattern escalation** (frequency, not severity)?
- [ ] Does the AI **respect informed autonomy** while still **leading with expert judgment** when the user hasn't questioned a bad default?
- [ ] Is language **qualitative-first with numbers on request**?
- [ ] Does the overall experience **protect the vibe**?

---

## 6. PROACTIVITY — Creating Opportunities for the AI to Show Up

Proactivity is what separates a persona from a chatbot. The key insight: **you build the trigger and the context, not the script.** The AI is world-class at figuring out what to say — your job is to create the moment and paint the picture.

### Smart greetings

Build the trigger (staleness check). Build the context (time, state, patterns, memories). Tell the AI: *"Think about what would land most right now."* Don't prescribe what it says.

**Greeting prompt (nutrition guide):**
```
You're checking in with the user. This should feel like a friend texting,
not a notification.
Think about what would land most right now — a meal idea, a pattern you
noticed, or just showing up. Lead with that.

Guidelines:
- If there's recent conversation, continue naturally. Don't restart.
- You know what time it is — use that awareness naturally, don't announce it.
- If meals are logged, reference them. If not, don't interrogate — just be present.
- Don't always ask a question. Sometimes a warm observation or meal idea is better.
- Think like a [domain expert] — notice patterns, anticipate needs — but talk like a friend.
```

**For a language tutor:** *"You're checking in with Alex. Maybe reference a word they struggled with yesterday, suggest a 5-minute drill, or just say something fun in Spanish. Think about what would spark engagement right now."*

### Rich context enables smart proactivity

When the AI knows it's 7 PM, the user ate 1200 cal, loves Mediterranean food, and has been under-eating protein for 3 days — it doesn't need instructions to suggest a protein-rich Mediterranean dinner. It just needs the information.

### Time-aware quick choices

This is one of the few places to be **prescriptive** — it's a UX decision, not a coaching decision. The CODE (not the AI) generates contextual quick-choice buttons based on time and state.

**Nutrition guide example:**
```
function getGreetingQuickChoices(hourOfDay, ledger) {
  hasMeals = ledger.meals.length > 0

  if (hourOfDay < 12 && !hasMeals)
    return ["Had breakfast already", "Skipping it", "Help me plan"]

  if (hourOfDay < 17 && !hasMeals)
    return ["Haven't eaten yet", "Ate but didn't log", "Plan lunch with me"]

  if (hasMeals && hourOfDay >= 17)
    return ["Planning dinner", "Already ate", "Need a snack idea"]

  return ["Log something I ate", "Help me plan a meal"]
}
```

### Pattern detection through information, not instruction

Inject recent N-day data into context. Say "notice patterns, give better advice." The AI will proactively surface trends. The escalation principle (section 5) naturally moderates how it does so.

### Follow-ups as proactive guidance

The AI generates follow-ups because it has the context to know what's relevant. You just need the schema field and the nudge: *"Be specific to what was just discussed — never generic."*

### Before moving on

- [ ] Does the AI **initiate** or just respond? Is there a greeting trigger?
- [ ] Is the greeting **context-aware** (time, state, patterns, memories)?
- [ ] Are quick choices generated by **code** (time x state), not the AI?
- [ ] Are follow-ups **specific** to what was just discussed?

---

## 7. USER AGENCY — Giving Users Control

### Configurable voice

Users should be able to configure voice through the UI AND through conversation. If someone says "be more direct with me," the AI should be able to update their profile settings.

```
updateProfile: {
  tone: "direct" | "warm" | "balanced",
  coachingStyle: "educator" | "quick",
  // ... other profile settings
}
```

The AI adapts to the user, not vice versa.

### Power prompts

4-6 evergreen, domain-specific conversation starters that unlock deeper engagement. Not commands — they're things the user "says" to the AI.

**Nutrition guide power prompts:**

| Label | Prompt |
|-------|--------|
| **Week in review** | "Look at my last few days — what patterns do you see? What went well, what should I watch out for?" |
| **Grocery run** | "Think about everything you know about me — my goals, preferences, what I've been eating — and advise me on what to buy at the grocery store this week." |
| **Meal prep ideas** | "Based on my preferences, goals, and what I've been eating — suggest 3-4 meals I should prep this week. Be specific with quantities." |
| **My blind spot** | "What's the one thing in my diet or habits that I'm probably not thinking about but could make a big difference?" |
| **What don't you know?** | "What's one thing about me you don't know yet that would help you give better advice? Ask me." |
| **Memory cleanup** | "Review all your memories about me. Merge any duplicates, delete anything outdated, and update anything that's changed. Show me what you did." |

Design your power prompts to cover different modes: analytical (week in review), introspective (blind spot), collaborative (what don't you know?), and maintenance (memory cleanup).

**For a fitness coach:** *"How's my recovery looking?" / "Design next week's split" / "What muscle group am I neglecting?" / "Simplify my routine" / "What don't you know about my body?"*

### Conversational onboarding

Chat flow, not forms. Each question is an AI message, each answer is a user reply. This sets the expectation from minute one that this is a conversation, not a tool.

### Continuous learning through memories

The AI accumulates knowledge over time. The instruction:

```
Actively listen for permanent preferences and save a memory when you detect
a LASTING preference (likes, dislikes, routines, health notes). Don't save
one-off mentions.
```

Categories help organization: `preference`, `aversion`, `routine`, `health`, `other`. The "Memory cleanup" power prompt lets users trigger self-maintenance.

### Profile vs memory distinction

**Profile** = what they want (goals, preferences, settings). The user configures this.
**Memory** = who they are (habits, likes, dislikes, health facts). The AI accumulates this.

Don't conflate them. When the user changes their goal, that's a profile update. When the AI learns they hate fish, that's a memory.

The grey area is real. Here's how to think through it:

| User says | Profile, memory, or neither? | Why |
|-----------|------------------------------|-----|
| "I'm vegetarian now" | **Profile** — update dietary preference | This changes what the AI should recommend going forward. It's a setting, not a learned fact. |
| "I had a great latte at Blue Bottle today" | **Neither** — too transient | This is conversation context, not a lasting preference or a configurable setting. Don't persist noise. |
| "I hate mornings" | **Memory** — save as routine/preference | The AI didn't know this. It's a durable trait that should influence greeting timing, tone, and suggestions. |
| "Switch me to metric" | **Profile** — update unit preference | Explicit configuration change. |
| "My knee's been bothering me this week" | **Memory** — save as health note | Temporary but impacts recommendations (e.g., skip leg exercises). Include a time reference so it can age out. |
| "Set my calorie target to 2000" | **Profile** — update target | The user is directly configuring a setting. |
| "I always overeat on Sundays" | **Memory** — save as pattern | Durable self-reported pattern. Informs proactive check-ins. |

**The litmus test:** Could the user reasonably set this in a settings screen? → Profile. Did the AI learn it from conversation? → Memory. Will it matter in a week? No → Neither.

### Before moving on

- [ ] Can users configure voice through **both** settings UI and conversation?
- [ ] Are there power prompts covering **analytical, introspective, collaborative, and maintenance** modes?
- [ ] Is onboarding **conversational** (chat flow, not forms)?
- [ ] Does the AI **learn over time** through memories?
- [ ] Is there a clear **profile vs memory** distinction?

---

## 8. ANTI-PATTERNS — What Kills a Persona

Each anti-pattern below came from an actual iteration. The failure mode is specific; the fix is proven.

### Prompt anti-patterns

| Anti-pattern | What happens | Fix |
|-------------|-------------|-----|
| Fixed length constraints ("2-4 sentences") | AI truncates useful advice to hit the limit | "Say what needs saying" |
| Absolute coaching rules ("NEVER show numbers") | AI refuses to share data even when user explicitly asks | "Default qualitative, give numbers when asked — it's their data" |
| Negative identity ("you are NOT a food logger") | AI avoids logging even when it should | Positive framing: "logging is one of your key jobs" |
| Announcing actions ("I've saved a memory...") | Breaks immersion, feels robotic | Silent execution. Weave knowledge in naturally |
| Generic persona ("helpful assistant") | No personality, no relationship, bland responses | Specific identity: expertise + relationship + north star |
| Throttle on a default ("Never give more than 2 recommendations") | Normalizes the behavior being capped — model reads "give 1-2 recs" | Flip to a thinking-nudge: "When they're processing, help them think. Save recommendations for when they ask." |

### Architecture anti-patterns

| Anti-pattern | What happens | Fix |
|-------------|-------------|-----|
| Create-only data ops | Duplicates, stale data, AI working around limitations | Full CRUD with IDs on every entity |
| No action annotations | AI re-logs meals, re-saves memories from earlier in conversation | Append `---actions:` to stored messages |
| No entity IDs in system prompt | AI can't reference, update, or delete specific items | Include IDs: `(id:abc123)` for every entity |
| Save message before loading context | Orphan user messages on load failure | Load context in parallel, THEN save message |
| Server timezone instead of user timezone | Wrong time-of-day behavior, wrong "today" boundary | Consistent `todayFor(tz)` helper everywhere |

### UX anti-patterns

| Anti-pattern | What happens | Fix |
|-------------|-------------|-----|
| Form-based onboarding | Sets wrong expectation — feels like a tool, not a companion | Conversational onboarding: chat flow |
| Generic follow-ups ("Tell me more") | Users ignore them — they add no value | First-person, specific: "How's my protein looking?" |
| Greeting on every page load | Annoying, feels spammy | Staleness check: only greet after >2hrs or new day |
| No user control over voice | Users who want directness get stuck with warm | Configurable tone + style axes |
| Raw markdown in chat | `**bold**` shows as literal asterisks | Enable markdown rendering + sanitization + warm CSS |

### Before moving on

- [ ] Review each anti-pattern. Have you fallen into any of them?
- [ ] For each one you've hit: is the fix in place?

---

## Bonus: Additional Patterns

### Confidence calibration

Confirm before high-stakes actions; act-and-inform for low-stakes. The threshold: *"Would the user be upset if this was wrong?"*

- **Low-stakes** (logging a clearly stated meal): Just do it
- **Medium** (saving a memory): Do it silently, AI weaves it in naturally
- **High-stakes** (deleting data, changing goals): Confirm before acting

In the schema, this is expressed through action descriptions:
```
logMeals: "When in doubt, confirm before logging."
deleteMeal: "Delete a meal that was logged in error, is a duplicate, or
             doesn't belong on today's ledger."
```

### Prompt versioning

Keep prompts in dedicated functions or files, not inline in API calls. This makes prompts reviewable, diffable, and testable.

```
// Good: dedicated function
function buildSystemPrompt(user, state, memories, patterns, tz) { ... }

// Bad: inline in the API call
const response = await ai.generate({
  system: `You are a helpful...` // buried in application code
})
```

### Testing strategy

- **Mock the AI layer**, test side-effect execution. Never test AI content (nondeterministic).
- Test that `logMeals` in the response → meals appear in DB with correct fields
- Test that `updateMeal` with an ID → correct meal updated
- Test that action annotations are built correctly
- Test the context assembly pipeline (parallel loading, correct prompt construction)

### Multimodal input (images, voice, etc.)

If your domain benefits from visual input (photo-based food logging, form checks for fitness, plant identification), wire it up as an additional part in the conversation message:

```
// User sends text + image
messageParts = [{ text: userMessage }]

if (image) {
  // Extract MIME type and base64 data from data URL
  messageParts.push({ inlineData: { mimeType: "image/jpeg", data: base64 } })
}

history.push({ role: "user", parts: messageParts })
```

The AI handles the rest — modern multimodal models can identify food from photos, read labels, assess portion sizes, etc. You just need to get the image into the conversation. No special prompt instructions needed; the model's visual understanding is the capability.

### Self-improvement loop

After every fix, ask: *"What context, directive, or knowledge — if I'd had it upfront — would have made this cheaper?"* Save the answer to project docs or memory. Every fix should make the next one cheaper.

---

## Bonus: Cold Start & First Impressions

Day 1, conversation 1: no memories, no patterns, no history. The persona has the least to work with and the most to prove. This is when most users decide whether to come back.

### The cold start problem

Every contextual input from Section 3 is empty. The N-day lookback is blank. Memories are zero. The AI is flying blind — but it still needs to feel like it knows what it's doing.

### Bootstrapping from onboarding

Conversational onboarding (Section 7) isn't just a UX choice — it's the cold start solution. Each onboarding question fills a context slot:

| Onboarding question | What it fills | Available from |
|---------------------|---------------|----------------|
| "What's your main goal?" | Profile: goal, targets | Message 1 |
| "Any foods you love or can't stand?" | Memory: preferences, aversions | Message 2 |
| "What does a typical eating day look like?" | Memory: routines | Message 3 |
| "How do you like your advice — straight talk or gentle nudges?" | Profile: tone, style | Message 4 |

By the end of 4-5 exchanges, the AI has enough context to be genuinely useful. Don't try to collect everything — collect enough to stop guessing.

### First-message design

The first message sets the relationship expectation. Get it right:

- **Don't** open with a feature list ("I can track meals, suggest recipes, and monitor your macros!")
- **Don't** open with a question wall ("What's your age? Weight? Height? Goal?")
- **Do** open with warmth + a single question: *"Hey! I'm here to make eating well feel easy, not like homework. What's the one thing you'd most like help with?"*

One question, not five. Let the conversation flow naturally from there.

### Graceful degradation without data

When context is sparse, the AI should lean on general expertise rather than attempting personalization it can't back up. The prompt instruction:

```
If you don't have much context about the user yet, lean on your domain expertise.
Don't pretend to know things you don't. "Based on what most people find helpful..."
is honest. "Based on your patterns..." with no data is a lie.
```

---

## Bonus: Memory Hygiene

Memories are the persona's long-term knowledge — and like any knowledge base, they degrade without maintenance. Preferences change, facts expire, and duplicates accumulate.

The most important framing: memory is not a transcript. It is the smaller set of things the assistant would genuinely want to still have in mind next time. Paint that horizon and intent clearly, then trust the model to decide what belongs there.

### Conflicts — preference changes over time

The user said "I love sushi" six months ago. Today they say "I'm avoiding raw fish." If both memories coexist, the AI gets confused or picks the wrong one.

**Solution:** When saving a new memory, check for conflicts with existing memories in the same category. If found, update or replace — don't create a second entry. The schema supports this (update by ID), but the deeper goal is to keep the memory set sharp enough that the assistant can actually think with it later:

```
Before saving a new memory, check if it contradicts or updates an existing one.
If so, update the existing memory instead of creating a duplicate. Preferences
change — the most recent statement wins.
```

### Staleness — time-decaying relevance

"Knee is bothering me" matters this week. Six months from now, it's noise. Not all memories have the same shelf life.

**Strategies:**
- **Implicit decay**: When loading memories for the prompt, prefer recent over old. If you're near the context budget, older memories get cut first.
- **Explicit expiry**: For health notes and temporary states, include a time reference: *"(as of March 2026) knee pain — avoiding leg exercises."* The AI can reason about whether it's still relevant.
- **User-triggered cleanup**: The "Memory cleanup" power prompt (Section 7) lets the user trigger a review. The AI reads all memories, merges duplicates, and flags stale ones.

### Proactive vs reactive maintenance

Don't rely solely on user-triggered cleanup. Build lightweight proactive checks:

- **On save**: Check for duplicates/conflicts before creating (described above)
- **On load**: If memory count exceeds your budget, log a warning. Don't silently drop memories — degrade gracefully (load pinned + recent, summarize the rest)
- **Periodic**: If your app has a background job capability, run periodic compaction — weekly or monthly depending on how quickly the domain changes. Let the AI rewrite the memory set into the smaller, sharper version it would actually want to carry forward.

### Real-world build learnings

These showed up repeatedly when turning personas into working products:

- **Design mutability up front**: If the persona should update threads, tasks, meals, mistakes, or memories, the relevant IDs must already be visible in context. Retrofitting update/delete later is where a lot of clank comes from.
- **Invisible operations are a product feature**: The AI should not narrate internal mechanics by default. Quietly doing the right thing feels human; announcing every save/update feels bot-like.
- **Create is not enough**: Many rough experiences come from duplicate records, stale facts, and failure to revise old context. Update/delete behavior matters as much as save behavior.
- **Follow-ups are part of the conversation design**: Generic chips flatten the persona. Good follow-ups feel like the user's own next thought, in first person, and make the conversation easier to continue.
- **Evaluate against a weak baseline, not just a rubric**: A persona can score "pretty good" in isolation and still not be materially better than a generic assistant. Compare the full persona against a deliberately degraded baseline and ask which one a real user would choose.

---

## Bonus: Failure Modes & Recovery

The happy path is Section 4. This is everything else. Plan for these before launch — discovering them in production is expensive.

### API down or timeout

The AI provider is unreachable. The user sent a message. What happens?

- **Don't**: Show a blank screen or a cryptic error
- **Don't**: Retry silently in a loop (burns quota, delays the inevitable)
- **Do**: Show a warm, honest fallback: *"I'm having trouble connecting right now — give me a minute and try again?"*
- **Do**: Preserve the user's message so they don't have to retype it

### Model returns garbage

Malformed JSON, truncated response, completely off-topic output. This happens more often than you'd think, especially near context window limits.

- **JSON parse failure**: Treat raw text as `response` with no actions. The user gets a conversational reply, you log the parse error. Don't retry — the same input is likely to produce the same failure.
- **Truncated response**: Usually means you've exceeded the model's output token limit. Reduce context (shorter lookback, fewer memories) and retry once.
- **Off-topic or role-broken output**: The model ignored the system prompt. This is rare with frontier models but common with weaker ones. Log it, return a generic fallback, investigate your prompt length.

### Context loading partially fails

You load state, memories, history, and patterns in parallel (Section 3). One of them throws. The rest succeeded.

- **Don't**: Fail the entire request
- **Do**: Proceed with whatever loaded successfully. The AI can function with partial context — it's less personalized but still useful
- **Do**: Log which context source failed so you can fix the root cause
- **Do**: Consider a subtle UI indicator ("responses may be less personalized right now") if the failure is persistent

### Model behavior drifts after a provider update

You didn't change anything. The AI starts behaving differently — longer responses, different tone, ignoring nudges. The model provider shipped an update.

- **Pin model versions** when possible (e.g., `gemini-3-flash-preview` vs `gemini-3-flash-latest`). Dated versions give you stability; latest gives you improvements. Choose deliberately.
- **Keep regression tests** for critical behaviors: Does the AI still confirm before deleting? Does it still respect language settings? These should be functional tests against your pipeline, not unit tests against AI output.
- **Log prompt + response pairs** for a sample of production traffic. When behavior drifts, you can diff before/after to identify what changed.

---

## Bonus: Model Considerations

The patterns in this playbook are optimized for frontier models (Gemini 2.0 Flash, GPT-4o, Claude Sonnet, and above). They assume the model can reliably follow complex system prompts, reason about nuanced situations, and produce structured JSON output. Not all models can.

### The thinking-nudge principle degrades with weaker models

"Think about what would land most right now" works because frontier models are good at reasoning about social situations. Mid-tier models may interpret this literally and produce meta-commentary ("I'm thinking about what would land...") or ignore it entirely. If you're using a less capable model:

- Replace nudges with more explicit instructions
- Reduce the number of contextual signals (fewer things to reason about)
- Tighten the schema with stricter constraints
- Test extensively — the gap between "works with GPT-4o" and "works with GPT-3.5" is enormous

### Pin model versions

Don't use `latest` in production. A model update can change tone, break JSON adherence, or shift how the model interprets your nudges. Use dated/pinned versions and upgrade deliberately after testing.

### Context window economics

Different models have different context windows and different costs per token. Your context budget (Section 3) needs to account for:

- **Smaller context models**: Aggressive memory pruning, shorter lookback, summarized history
- **Larger context models**: More room, but don't fill it just because you can — longer prompts increase latency and cost
- **Cost-per-token variance**: A 50-memory prompt that's cheap on one model may be expensive on another. Monitor costs per conversation, not just per API call.

### Structured output reliability

JSON structured output (`responseSchema`, `response_format`) and tool calling both vary in reliability across models. Frontier models rarely break schema; mid-tier models regularly do. Build your parse-and-recover pipeline (Section 4: "When things break") before you need it.

---

## Quick Reference: V0.1 in 30 Minutes

This produces a working starting point — not a finished product. You'll iterate on every section after real users touch it. The goal is to get something testable fast, then refine based on what breaks.

1. **Identity** (5 min): Fill in the template. Pick the right relationship archetype for your domain. Read it aloud. Does it sound like someone you'd trust?
2. **Voice** (3 min): Pick default tone + style. Write the instructions. Add formatting guidance. Choose medium-appropriate length framing.
3. **Context** (10 min): List every piece of situational data your persona needs. Design the context blocks. Build `todayFor(tz)`.
4. **Schema** (5 min): Define response + actions. Full CRUD for every entity. Write behavioral descriptions. Add ID validation on every update/delete handler.
5. **EQ** (2 min): Add the Frequency Rule. State scope boundaries warmly.
6. **Proactivity** (3 min): Build the staleness check. Design quick choices. Add follow-ups field.
7. **Agency** (2 min): Design 4-6 power prompts. Plan conversational onboarding. Define the profile vs memory boundary with examples.
8. **Anti-patterns** (review): Scan the list. Fix anything you've hit.
9. **Cold start** (review): Design the first-message experience. Plan what onboarding collects.
10. **Failure modes** (review): Build parse recovery, API fallback, and partial-context degradation.

---

## Anatomy of a Finished Prompt

Here's what an assembled system prompt looks like when all 8 sections come together. This is the nutrition guide's actual structure in outline form — your prompt should follow the same shape:

```
┌─────────────────────────────────────────────────────────┐
│ 1. IDENTITY PARAGRAPH                     (~150 tokens) │
│    "You are [Name] — a guide on..."                     │
│    Expertise, relationship, north star, scope,          │
│    keystone instruction                                 │
├─────────────────────────────────────────────────────────┤
│ 2. VOICE & FORMATTING RULES               (~100 tokens) │
│    Tone instruction, style instruction,                 │
│    "Say what needs saying", markdown guidance            │
├─────────────────────────────────────────────────────────┤
│ 3. USER PROFILE BLOCK                      (~80 tokens) │
│    "ABOUT the user: Age, weight, goals, targets..."     │
├─────────────────────────────────────────────────────────┤
│ 4. TODAY'S STATUS BLOCK                   (~150 tokens) │
│    Date, time, consumed/remaining, meals with IDs       │
├─────────────────────────────────────────────────────────┤
│ 5. RECENT DAYS LOOKBACK                   (~400 tokens) │
│    N-day summary: weight, macros, meal names            │
│    "Notice patterns, give better advice"                │
├─────────────────────────────────────────────────────────┤
│ 6. MEMORIES BLOCK                      (~50/memory)     │
│    "CORE MEMORIES about the user:"                      │
│    Each with category, ID, content                      │
├─────────────────────────────────────────────────────────┤
│ 7. BEHAVIORAL RULES                      (~200 tokens) │
│    EQ guidelines, escalation principle,                 │
│    autonomy respect, qualitative-first language,        │
│    confidence calibration                               │
├─────────────────────────────────────────────────────────┤
│ 8. RESPONSE SCHEMA DESCRIPTIONS           (~200 tokens) │
│    (Injected via schema definitions, not prompt text)   │
│    logMeals, updateMeal, saveMemory, followUps, etc.    │
└─────────────────────────────────────────────────────────┘
Total system prompt: ~1300-1800 tokens (before memories scale)
+ Conversation history: variable
+ User's new message: variable
```

**Key ordering principles:**
- Identity comes first — it frames everything that follows
- Profile and status before memories — the AI needs to know "who" before "what I know about them"
- Rules after context — behavioral guidelines make more sense after the AI has the situation
- Schema descriptions are separate from the prompt text (they live in the schema definition itself)

The 30-minute Quick Reference above builds each block. This anatomy shows you how they snap together.

---

*Built from the trenches of real AI persona products. Every pattern earned, every anti-pattern learned the hard way.*

---

## Reference Implementation: Archetype SDK

**Archetype** is the TypeScript SDK that turns this playbook into executable code. Every section above maps to a module:

| Playbook Section | SDK Module | What it does |
|---|---|---|
| §1 Identity | `core/identity.ts` | Config → opening paragraph with expertise, relationship, keystone |
| §2 Voice | `core/voice.ts` | Tone × style × medium → instruction text |
| §3 Context | `core/context.ts` | Labeled blocks with budget management and priority levels |
| §4 Structured Responses | `core/actions.ts` + `engine/side-effects.ts` | Zod schemas → rules text; validate → execute → annotate |
| §5 EQ | `core/eq.ts` | Frequency Rule, autonomy, qualitative-first as thinking-nudges |
| §6 Proactivity | `core/greeting.ts` | 2hr + new-day staleness check |
| §8 Anti-patterns | `playbook/defaults.ts` | Built-in guards: no throttle-on-default, no announce-actions |
| Cold Start | `playbook/defaults.ts` | Graceful degradation instructions |
| Memory Hygiene | `core/memory.ts` | Budget-aware loading, pinned-first, category inference |
| Confidence Calibration | `types.ts` ActionConfidence | `low` (just do it) / `medium` (mention it) / `high` (confirm first) |

A new persona takes ~50 lines of config via `definePersona()`. The SDK handles prompt assembly, memory budget, structured actions, side-effect validation, conversation lifecycle, and all the EQ patterns described above.

```typescript
import { definePersona, Gemini } from 'archetype'

const coach = definePersona({
  identity: { name: 'Coach', expertise: ['executive coaching'], relationship: 'trusted thinking partner', northStar: "CEO's growth" },
  voice: { tone: 'balanced', style: 'educator', medium: 'desktop-panel' },
  methodology: 'Threads are CEO-level challenges...',
  actions: { saveMemory: { description: '...', schema: z.object({...}), confidence: 'low' } },
  eq: { frequencyRule: true, autonomyRespect: true },
  provider: Gemini(),
})

const result = await coach.chat({ message: '...', history: [], context: {}, memories: [] })
```
