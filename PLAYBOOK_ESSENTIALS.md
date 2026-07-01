# Playbook Essentials — AI Persona Builder's Playbook (Condensed)

This is the condensed version of `AI_PERSONA_PLAYBOOK.md`. Read this first. Reference the full playbook when you need deeper reasoning or examples.

---

## Core Philosophy: Paint the Situation, Don't Prescribe

Modern LLMs reason about situations. Your job is to create the opportunity, paint the scene richly, and let the AI craft the approach. Hard rules are ONLY for mechanical logic (JSON format, dedup, schema compliance). Everything about being a good persona must be a thinking nudge.

**The anti-pattern** is prescribing behavior. **The pattern** is sharing the situation, intent, taste, and constraints — then trusting the model.

Prompts should hold the stable parts: relationship, north star, tone, mechanics, taste. The live scenario — context, history, memories, user message — does the real work turn by turn.

---

## 1. Identity

**Template**: `You are [NAME] — a [relationship] on [USER]'s journey toward [north star]. You bring deep expertise in [disciplines] and weave them together naturally.`

**Keystone instruction** (generates 80% of EQ): *"Before each response, silently review the full conversation. You are an expert sitting across from [relationship framing] — what is the single most impactful thing you could say right now?"*

**Relationship archetype** — match the domain's trust model:

| Domain | Archetype | Framing |
|--------|-----------|---------|
| Wellness | Warm companion | "Expert across from a dear client and friend" |
| Enterprise | Competent peer | "Senior colleague who's done this before" |
| Legal | Authoritative advisor | "Outside counsel who respects your time" |
| Creative | Collaborative partner | "Writing partner who gets your voice" |
| Tutor | Encouraging coach | "Patient tutor who celebrates progress" |

**Rules**: Define what the persona IS, not what it isn't. Boundaries are optional and minimal. The keystone must be present.

---

## 2. Voice

Two independent axes — must combine freely:

- **Tone** (how): direct, warm, balanced
- **Style** (what): educator (explains the why), quick (breezy, action-focused)

**Hard rule vs nudge heuristic**: If getting it wrong deletes data or actively annoys the user → hard rule. If it just makes the response slightly less optimal → nudge.

**Medium-aware length**: Don't hard-code token limits. Frame the medium: "text like a friend" (mobile), "brief memo" (desktop). Goal: *"Say what needs saying — don't pad, don't truncate."*

---

## 3. Context — Situational Awareness

Give the AI the same awareness a human advisor would have walking into the room.

**Eight essential inputs**:

1. **Time of day** — user's timezone, not server
2. **Session freshness** — new conversation vs continuation (staleness: >2hrs or new day)
3. **Today's status** — with computed/derived values (remaining budget, not just consumed)
4. **Recent patterns** — N-day lookback (7 days) to surface trends
5. **Accumulated knowledge** — memories with IDs so AI can update/delete
6. **Remaining capacity** — what's achievable given time/budget left
7. **Last interaction context** — action annotations prevent re-processing
8. **User preferences & profile** — tone, style, goal context in labeled block

**Assembly**: Load everything in parallel, THEN save user message. Never save before context loads.

---

## 4. Structured Responses — Actions & Schema

Schema is the API contract between AI and app.

**Full CRUD**: For every entity the AI can create, it must be able to update (with ID) and delete (with ID). Create-only leads to duplicates and stale data.

**ID validation**: Validate entity IDs against the database before every update/delete. AI will hallucinate IDs.

**Action descriptions ARE behavioral nudges**: `"Log meals the user has actually eaten — if still exploring, hold off"` — not just type documentation.

**Follow-ups**: Must read as things the USER would say. Good: "How's my protein looking?" Bad: "Tell me more."

**Entity CRUD**: Declare entities with Zod schemas on `entities` in the persona config. The SDK generates create/update/delete operations automatically — no per-entity action boilerplate needed.

```typescript
entities: {
  task: {
    schema: z.object({ title: z.string(), due: z.string().optional() }),
    label: 'Task',
    displayField: 'title',
  },
},
```

**Annotations**: After executing actions, append `---actions: logged: X | saved memory: Y` to stored assistant messages. Strip before display. Prevents re-processing.

---

## 5. Emotional Intelligence

The keystone instruction handles 80%. These are thinking postures, not prescriptive rules.

**Frequency Rule** — the most valuable calibration tool: One tough day gets warmth. A recurring pattern deserves honest conversation. Frequency, not severity, determines response.

**Autonomy respect**: *"An aggressive plan they commit to beats a perfect plan they abandon."* Respect informed choices — but lead with expertise when user intent conflicts with wellbeing.

**Expert judgment**: *"You are the domain expert. Your recommendations carry real weight — the user may follow them without question. That is a responsibility."*

**Qualitative-first**: Default to qualitative language ("you've got plenty of room," "budget's getting snug"). Give numbers when asked — it's their data.

**Show, don't announce**: Never "I can see you're having a rough day." Never "I've saved a memory." Just be warm. Weave knowledge naturally.

---

## 6. Proactivity

Build the trigger and context. Don't prescribe the script. The AI decides what to say.

- **Greeting trigger**: staleness check (>2hrs or new day)
- **Greeting context**: inject time, state, patterns, memories — AI connects the dots
- **Quick choices**: generated by CODE (time x state), not AI
- **Pattern detection**: inject N-day data, say "notice patterns" — AI surfaces trends naturally

---

## 7. User Agency

- **Configurable voice**: users adjust tone/style through settings AND conversation
- **Power prompts**: 4-6 evergreen conversation starters covering analytical, introspective, collaborative, and maintenance modes
- **Conversational onboarding**: chat flow, not forms. One question at a time.
- **Profile vs memory distinction**: Could the user set this in a settings screen? → Profile. Did AI learn it from conversation? → Memory. Will it matter in a week? No → Neither.

---

## 8. Anti-Patterns

| Anti-pattern | Fix |
|-------------|-----|
| Fixed length ("2-4 sentences") | "Say what needs saying" + medium framing |
| Absolute rules ("NEVER show numbers") | "Default qualitative, give numbers when asked" |
| Negative identity ("NOT a food logger") | Positive: "logging is one of your key jobs" |
| Announcing actions | Silent execution, weave knowledge naturally |
| Generic persona ("helpful assistant") | Specific: expertise + relationship + north star |
| Throttle on default ("max 2 recs") | Nudge: "Save recs for when they ask" |
| Create-only data ops | Full CRUD with IDs |
| No action annotations | Append `---actions:` to stored messages |
| No entity IDs in prompt | Include `(id:abc123)` for every entity |
| Form-based onboarding | Conversational onboarding |
| Generic follow-ups ("Tell me more") | First-person, specific to what was discussed |

---

## Cold Start

Day 1: no memories, no patterns, no history. Don't pretend otherwise.

- First message: warmth + ONE question. Not a feature list, not a question wall.
- Without data, lean on domain expertise. *"Based on what most people find helpful..."* is honest. *"Based on your patterns..."* with no data is a lie.

---

## The Come-Back Test

Every design decision: *Does this make the user want to come back and think with me again?*
