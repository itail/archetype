import { z } from 'zod'
import type { SideEffectHandler } from '../engine/side-effects.js'
import type { CrudHandler, EvalProject, EvalState } from './types.js'
import type { CrudAction } from '../types.js'
import {
  CHIEF_OF_STAFF_TEMPLATE,
  COACH_TEMPLATE,
  FITNESS_TEMPLATE,
  LANGUAGE_TUTOR_TEMPLATE,
  NUTRITION_TEMPLATE,
} from '../playbook/templates.js'

export interface CoachEvalState extends EvalState {
  threads: Array<{ id: string; title: string; status: string; owner: string; description?: string }>
  forcingFunctions: Array<{ id: string; title: string; owner: string; due: string; status: string; threadId?: string }>
  coachingNotes: Array<{ id: string; type: string; text: string }>
  profile: { name: string; role: string; company: string }
}

export interface NutritionEvalState extends EvalState {
  meals: Array<{ id: string; name: string; calories?: number; protein?: number }>
  recentDays: string[]
  profile: { name: string; goal: string; targetProtein: string }
}

export interface FitnessEvalState extends EvalState {
  injuries: string[]
  equipment: string[]
  recentWorkouts: Array<{ id: string; title: string; result: string }>
  generatedWorkouts: Array<{
    id: string
    exercises: Array<{ name: string; sets: number; reps: string; notes?: string }>
    warmup?: string
    cooldown?: string
  }>
  profile: { name: string; focus: string }
}

export interface LanguageTutorEvalState extends EvalState {
  currentGoal: { language: string; reason: string; correctionPreference: string }
  recentMistakes: Array<{ id: string; pattern: string; correction: string; example?: string }>
  phrasebook: Array<{ text: string; translation: string }>
  practiceQueue: Array<{ id: string; title: string; focus: string; prompt: string; durationMin?: number }>
  profile: { name: string; level: string }
}

export interface ChiefOfStaffEvalState extends EvalState {
  openTasks: Array<{
    id: string
    title: string
    owner?: string
    due?: string
    notes?: string
    definitionOfDone?: string
    priority?: 'low' | 'medium' | 'high'
    status: 'open' | 'done' | 'canceled'
  }>
  constraints: string[]
  profile: { name: string; role: string }
}

const taskPrioritySchema = z.enum(['low', 'medium', 'high'])
const taskStatusSchema = z.enum(['open', 'done', 'canceled'])

export const coachProject: EvalProject<CoachEvalState> = {
  id: 'coach',
  name: 'Executive Coach',
  description: 'Tests abstract reasoning, low-action default behavior, and durable pattern capture.',
  failureSurface: 'Should sound incisive without becoming robotic or prematurely operational.',
  userIdentity: 'Alex, CEO',
  timezone: 'America/Los_Angeles',
  persona: COACH_TEMPLATE,
  initialState() {
    return {
      memories: [
        { id: 'mem-1', content: 'Responds well to direct pattern-naming when it is specific and earned.', category: 'coaching_approach' },
      ],
      threads: [
        { id: 'thread-1', title: 'Roadmap prioritization', status: 'stuck', owner: 'VP Eng', description: 'Decision quality is soft and roadmap tradeoffs keep reopening.' },
        { id: 'thread-2', title: 'Hiring plan', status: 'active', owner: 'VP Eng', description: 'Need a staffing plan that matches the real roadmap, not the aspirational one.' },
      ],
      forcingFunctions: [],
      coachingNotes: [],
      profile: { name: 'Alex', role: 'CEO', company: 'Acme' },
    }
  },
  buildContext(state) {
    return {
      threads: state.threads,
      forcingFunctions: state.forcingFunctions,
      coachingNotes: state.coachingNotes,
      profile: state.profile,
    }
  },
  buildHandlers(state) {
    return {} satisfies Record<string, SideEffectHandler>
  },
  buildCrudHandlers(state) {
    return {
      thread: async (action: CrudAction) => {
        if (action.operation === 'update' && action.id) {
          const thread = state.threads.find(item => item.id === action.id)
          if (!thread) return
          const params = action.params ?? {}
          if (params.title != null) thread.title = String(params.title)
          if (params.status != null) thread.status = String(params.status)
          if (params.owner != null) thread.owner = String(params.owner)
          if (params.description != null) thread.description = String(params.description)
        }
      },
      forcingFunction: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.forcingFunctions.push({
            id: action.id!,
            title: String(params.title),
            owner: String(params.owner),
            due: String(params.due),
            status: String(params.status),
            threadId: params.threadId != null ? String(params.threadId) : undefined,
          })
        } else if (action.operation === 'update' && action.id) {
          const ff = state.forcingFunctions.find(item => item.id === action.id)
          if (!ff) return
          if (params.title != null) ff.title = String(params.title)
          if (params.owner != null) ff.owner = String(params.owner)
          if (params.due != null) ff.due = String(params.due)
          if (params.status != null) ff.status = String(params.status)
          if (params.threadId != null) ff.threadId = String(params.threadId)
        } else if (action.operation === 'delete' && action.id) {
          const index = state.forcingFunctions.findIndex(item => item.id === action.id)
          if (index !== -1) state.forcingFunctions.splice(index, 1)
        }
      },
      coachingNote: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.coachingNotes.push({
            id: action.id!,
            type: String(params.type),
            text: String(params.text),
          })
        } else if (action.operation === 'update' && action.id) {
          const note = state.coachingNotes.find(item => item.id === action.id)
          if (!note) return
          if (params.type != null) note.type = String(params.type)
          if (params.text != null) note.text = String(params.text)
        } else if (action.operation === 'delete' && action.id) {
          const index = state.coachingNotes.findIndex(item => item.id === action.id)
          if (index !== -1) state.coachingNotes.splice(index, 1)
        }
      },
    } satisfies Record<string, CrudHandler>
  },
  summarizeState(state) {
    return [
      `threads=${state.threads.map(item => `${item.id}:${item.status}`).join(', ')}`,
      `forcingFunctions=${state.forcingFunctions.map(item => `${item.id}:${item.status}`).join(', ') || '(none)'}`,
      `notes=${state.coachingNotes.map(item => item.type).join(', ') || '(none)'}`,
      `memories=${state.memories.length}`,
    ].join(' | ')
  },
}

export const nutritionProject: EvalProject<NutritionEvalState> = {
  id: 'nutrition',
  name: 'Nutrition Guide',
  description: 'Tests invisible meal logging, update-vs-duplicate behavior, and soft emotional warmth.',
  failureSurface: 'Should feel personal and fluid while doing precise ledger work behind the scenes.',
  userIdentity: 'Alex',
  timezone: 'America/Los_Angeles',
  persona: NUTRITION_TEMPLATE,
  initialState() {
    return {
      memories: [
        { id: 'mem-1', content: 'Likes savory breakfasts more than sweet ones.', category: 'preference' },
      ],
      meals: [],
      recentDays: [
        'Yesterday: 2200 cal, strong protein, dinner ran late.',
        '2 days ago: skipped breakfast, over-corrected at night.',
      ],
      profile: { name: 'Alex', goal: 'lean out without losing muscle', targetProtein: '180g' },
    }
  },
  buildContext(state) {
    const mealLines = state.meals.length === 0
      ? 'No meals logged yet today.'
      : state.meals.map(item => `- (id:${item.id}) ${item.name}${item.calories != null ? `, ${item.calories} cal` : ''}`).join('\n')
    return {
      todayStatus: `Meals logged today:\n${mealLines}`,
      recentDays: state.recentDays,
      profile: state.profile,
    }
  },
  buildHandlers(state) {
    return {} satisfies Record<string, SideEffectHandler>
  },
  buildCrudHandlers(state) {
    return {
      meal: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.meals.push({
            id: action.id!,
            name: String(params.name),
            calories: typeof params.calories === 'number' ? params.calories : undefined,
            protein: typeof params.protein === 'number' ? params.protein : undefined,
          })
        } else if (action.operation === 'update' && action.id) {
          const meal = state.meals.find(item => item.id === action.id)
          if (!meal) return
          if (params.name != null) meal.name = String(params.name)
          if (typeof params.calories === 'number') meal.calories = params.calories
          if (typeof params.protein === 'number') meal.protein = params.protein
        } else if (action.operation === 'delete' && action.id) {
          const index = state.meals.findIndex(item => item.id === action.id)
          if (index !== -1) state.meals.splice(index, 1)
        }
      },
    } satisfies Record<string, CrudHandler>
  },
  summarizeState(state) {
    return [
      `meals=${state.meals.map(item => `${item.id}:${item.name}`).join(', ') || '(none)'}`,
      `memories=${state.memories.length}`,
    ].join(' | ')
  },
}

export const fitnessProject: EvalProject<FitnessEvalState> = {
  id: 'fitness',
  name: 'Strength Coach',
  description: 'Tests concrete structured output, training constraints, and silent persistence of relevant context.',
  failureSurface: 'Should feel like a real coach, not a JSON-spewing workout machine.',
  userIdentity: 'Alex',
  timezone: 'America/Los_Angeles',
  persona: FITNESS_TEMPLATE,
  initialState() {
    return {
      memories: [],
      injuries: ['Left shoulder gets cranky with deep barbell pressing'],
      equipment: ['barbell', 'dumbbells', 'cables', 'pull-up bar'],
      recentWorkouts: [
        { id: 'rw-1', title: 'Upper Push', result: 'Bench stalled, incline DB felt strong' },
        { id: 'rw-2', title: 'Lower Body', result: 'Squat moved well, hamstrings still sore' },
      ],
      generatedWorkouts: [],
      profile: { name: 'Alex', focus: 'Strength with longevity' },
    }
  },
  buildContext(state) {
    return {
      injuries: state.injuries,
      equipment: state.equipment,
      recentWorkouts: state.recentWorkouts,
      profile: state.profile,
    }
  },
  buildHandlers(state) {
    return {} satisfies Record<string, SideEffectHandler>
  },
  buildCrudHandlers(state) {
    return {
      workout: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.generatedWorkouts.push({
            id: action.id!,
            exercises: [],
            warmup: params.warmup != null ? String(params.warmup) : undefined,
            cooldown: params.cooldown != null ? String(params.cooldown) : undefined,
          })
        }
      },
      exercise: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          // Find workout by cross-referenced ID (resolved from temp by SDK)
          const workoutId = String(params.workoutId ?? '')
          const workout = state.generatedWorkouts.find(w => w.id === workoutId)
          if (workout) {
            workout.exercises.push({
              name: String(params.name),
              sets: Number(params.sets ?? params.plannedSets ?? 3),
              reps: String(params.reps ?? params.plannedReps ?? '8'),
              notes: params.notes != null ? String(params.notes) : undefined,
            })
          }
        }
      },
    } satisfies Record<string, CrudHandler>
  },
  summarizeState(state) {
    return [
      `generated=${state.generatedWorkouts.length}`,
      `injuries=${state.injuries.join('; ') || '(none)'}`,
      `memories=${state.memories.length}`,
    ].join(' | ')
  },
}

export const languageTutorProject: EvalProject<LanguageTutorEvalState> = {
  id: 'language-tutor',
  name: 'Language Tutor',
  description: 'Tests high conversational fluency, adaptive correction, and compounding memory around learner patterns.',
  failureSurface: 'Should sound natural and helpful, not like a grammar worksheet with a smile.',
  userIdentity: 'Alex',
  timezone: 'America/Los_Angeles',
  persona: LANGUAGE_TUTOR_TEMPLATE,
  initialState() {
    return {
      memories: [],
      currentGoal: {
        language: 'Spanish',
        reason: 'Trip to Spain in 6 weeks',
        correctionPreference: 'Correct me immediately when I drift into unnatural phrasing',
      },
      recentMistakes: [],
      phrasebook: [
        { text: 'Quiero una mesa para dos.', translation: 'I want a table for two.' },
      ],
      practiceQueue: [],
      profile: { name: 'Alex', level: 'advanced beginner' },
    }
  },
  buildContext(state) {
    return {
      currentGoal: state.currentGoal,
      recentMistakes: state.recentMistakes,
      phrasebook: state.phrasebook.map(item => `${item.text} — ${item.translation}`),
      profile: state.profile,
    }
  },
  buildHandlers(state) {
    return {} satisfies Record<string, SideEffectHandler>
  },
  buildCrudHandlers(state) {
    return {
      mistake: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.recentMistakes.push({
            id: action.id!,
            pattern: String(params.pattern),
            correction: String(params.correction),
            example: params.example != null ? String(params.example) : undefined,
          })
        } else if (action.operation === 'update' && action.id) {
          const mistake = state.recentMistakes.find(item => item.id === action.id)
          if (!mistake) return
          if (params.pattern != null) mistake.pattern = String(params.pattern)
          if (params.correction != null) mistake.correction = String(params.correction)
          if (params.example != null) mistake.example = String(params.example)
        } else if (action.operation === 'delete' && action.id) {
          const index = state.recentMistakes.findIndex(item => item.id === action.id)
          if (index !== -1) state.recentMistakes.splice(index, 1)
        }
      },
      practice: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.practiceQueue.push({
            id: action.id!,
            title: String(params.title),
            focus: String(params.focus),
            prompt: String(params.prompt),
            durationMin: typeof params.durationMin === 'number' ? params.durationMin : undefined,
          })
        } else if (action.operation === 'update' && action.id) {
          const practice = state.practiceQueue.find(item => item.id === action.id)
          if (!practice) return
          if (params.title != null) practice.title = String(params.title)
          if (params.focus != null) practice.focus = String(params.focus)
          if (params.prompt != null) practice.prompt = String(params.prompt)
          if (typeof params.durationMin === 'number') practice.durationMin = params.durationMin
        } else if (action.operation === 'delete' && action.id) {
          const index = state.practiceQueue.findIndex(item => item.id === action.id)
          if (index !== -1) state.practiceQueue.splice(index, 1)
        }
      },
    } satisfies Record<string, CrudHandler>
  },
  summarizeState(state) {
    return [
      `mistakes=${state.recentMistakes.map(item => item.pattern).join(', ') || '(none)'}`,
      `practice=${state.practiceQueue.map(item => item.title).join(', ') || '(none)'}`,
      `memories=${state.memories.length}`,
    ].join(' | ')
  },
}

export const chiefOfStaffProject: EvalProject<ChiefOfStaffEvalState> = {
  id: 'chief-of-staff',
  name: 'Chief Of Staff',
  description: 'Tests utilitarian CRUD, preference memory, and operational crispness without sounding bureaucratic.',
  failureSurface: 'Should quietly reduce load and maintain a clean system rather than narrating tools.',
  userIdentity: 'Alex',
  timezone: 'America/Los_Angeles',
  persona: CHIEF_OF_STAFF_TEMPLATE,
  initialState() {
    return {
      memories: [],
      openTasks: [
        {
          id: 'task-1',
          title: 'Draft investor update',
          owner: 'Alex',
          due: '2026-03-21',
          priority: 'high',
          status: 'open',
          notes: 'Keep it tight and numbers-first.',
          definitionOfDone: 'A sendable draft exists with topline metrics up front.',
        },
      ],
      constraints: ['Deep work blocks are protected from 09:00-11:00.', 'Avoid Friday afternoon follow-ups if Thursday works.'],
      profile: { name: 'Alex', role: 'CEO' },
    }
  },
  buildContext(state) {
    return {
      openTasks: state.openTasks,
      constraints: state.constraints,
      profile: state.profile,
    }
  },
  buildHandlers(state) {
    return {} satisfies Record<string, SideEffectHandler>
  },
  buildCrudHandlers(state) {
    return {
      task: async (action: CrudAction) => {
        const params = action.params ?? {}
        if (action.operation === 'create') {
          state.openTasks.push({
            id: action.id!,
            title: String(params.title),
            owner: params.owner != null ? String(params.owner) : undefined,
            due: params.due != null ? String(params.due) : undefined,
            notes: params.notes != null ? String(params.notes) : undefined,
            definitionOfDone: params.definitionOfDone != null ? String(params.definitionOfDone) : undefined,
            priority: params.priority != null ? taskPrioritySchema.parse(params.priority) : undefined,
            status: params.status != null ? taskStatusSchema.parse(params.status) : 'open',
          })
        } else if (action.operation === 'update' && action.id) {
          const task = state.openTasks.find(item => item.id === action.id)
          if (!task) return
          if (params.title != null) task.title = String(params.title)
          if (params.owner != null) task.owner = String(params.owner)
          if (params.due != null) task.due = String(params.due)
          if (params.notes != null) task.notes = String(params.notes)
          if (params.definitionOfDone != null) task.definitionOfDone = String(params.definitionOfDone)
          if (params.priority != null) task.priority = taskPrioritySchema.parse(params.priority)
          if (params.status != null) task.status = taskStatusSchema.parse(params.status)
        } else if (action.operation === 'delete' && action.id) {
          const index = state.openTasks.findIndex(item => item.id === action.id)
          if (index !== -1) state.openTasks.splice(index, 1)
        }
      },
    } satisfies Record<string, CrudHandler>
  },
  summarizeState(state) {
    return [
      `tasks=${state.openTasks.map(item => {
        const owner = item.owner ?? '-'
        const due = item.due ?? '-'
        const priority = item.priority ?? '-'
        return `${item.id}:${item.status}:${item.title}:owner=${owner}:due=${due}:priority=${priority}`
      }).join(', ') || '(none)'}`,
      `memories=${state.memories.length}`,
    ].join(' | ')
  },
}

// ─── Savor Nutrition Coach (production persona eval) ────────────────────────

/**
 * Savor-specific eval: tests a production nutrition coaching persona
 * that has the user's full food diary, body composition data, and
 * accumulated relationship history. The key failure surfaces are:
 * 1. Ignoring established routines visible in recent days + memories
 * 2. Encyclopedic lecturing instead of grounded coaching
 * 3. Double-logging / arithmetic hallucinations
 */

export interface SavorEvalState extends EvalState {
  meals: Array<{ id: string; description: string; calories: number; proteinG: number; carbsG: number; fatG: number }>
  todayConsumed: { calories: number; proteinG: number; carbsG: number; fatG: number }
}

const savorFoodItemSchema = z.object({
  name: z.string(),
  quantity: z.string(),
  calories: z.number(),
  proteinG: z.number(),
  carbsG: z.number(),
  fatG: z.number(),
})

/**
 * Savor methodology — rewritten to follow scenario-first pattern (coach template model).
 * Describes the world and what the expert notices, not what to do.
 */
const SAVOR_METHODOLOGY = `The world you operate in:
- The daily ledger and recent days are this person's food diary — the clinical record a nutritionist reviews before every session. The memories are relationship history built over weeks of coaching together.
- A cut is math over weeks. The plan that sticks beats the plan that's perfect.
- The pre-calculated totals in the ledger are computed from the actual logged items. They are ground truth.
- Physical and mental health are both your concern.

What you notice:
- Established patterns in what they actually eat — these are data, not defaults to replace
- Where the macro math is working and where it's drifting across days
- The difference between a client who needs a creative idea and one who already has a working routine
- When the data tells a story the client hasn't articulated yet`

const SAVOR_ACTION_PROTOCOL = `ACTION PROTOCOL:
- When negotiating a meal, create it as a draft (status: "draft") via the crud action. When the user confirms eating (past tense), create with status "confirmed" or update the draft's status to "confirmed". Each dish/occasion is a separate entry.
- When correcting a logged meal, update it with its id via the crud action — don't create a duplicate. Delete meals that are errors.
- Weight: if given in kg, convert to lbs (×2.205).
- Profile settings (goal, tone, coaching style) use updateProfile — these aren't memories.`

export const savorProject: EvalProject<SavorEvalState> = {
  id: 'savor',
  name: 'Savor Nutrition Coach',
  description: 'Tests a production nutrition coach with full client history — should feel like a nutritionist who knows this specific person, not an encyclopedia.',
  failureSurface: 'Should ground advice in the client\'s actual data and established routines, not lecture generically. Should lead as the expert, not wait to be coached.',
  userIdentity: 'Alex',
  timezone: 'America/New_York',
  persona: {
    identity: {
      name: 'Savor',
      expertise: ['nutrition', 'cooking', 'food psychology'],
      relationship: 'a trusted companion who guides Alex toward health, wellbeing, and longevity',
      northStar: "Alex's long-term health: help them reach their goals, and when a goal seems misguided, gently nudge toward a healthier one — respect informed choices. An aggressive plan they commit to beats a perfect plan they abandon",
      keystone: 'What is the single most impactful thing you could say or offer right now? Sometimes that\'s a creative meal idea, sometimes it\'s noticing a pattern, sometimes it\'s a gentle challenge, sometimes it\'s just warmth. Lead with that.',
    },
    voice: {
      tone: 'warm',
      style: 'educator',
      medium: 'mobile-chat',
      formatting: 'Your responses are rendered as markdown. You can use **bold**, *italic*, bullet lists, emojis, and <span style="color:#hex">colored text</span> when it helps.\nThink of formatting as seasoning — use it to make responses feel warm, alive, and easy to scan, like a message from a knowledgeable friend. Don\'t overdo it.',
    },
    methodology: SAVOR_METHODOLOGY + '\n\n' + SAVOR_ACTION_PROTOCOL,
    entities: {
      meal: {
        schema: z.object({
          description: z.string(),
          time: z.string().describe('HH:MM (24h) when the meal was eaten'),
          items: z.array(savorFoodItemSchema),
          status: z.enum(['draft', 'confirmed']).optional().describe('Draft meals are being negotiated. Confirmed meals are logged.'),
        }),
        label: 'Meal',
        displayField: 'description',
      },
    },
    actions: {},
    contextInputs: {
      profile: { label: 'ABOUT Alex', format: 'block' as const },
      todayStatus: { label: "TODAY'S STATUS", format: 'block' as const },
      recentDays: { label: 'RECENT DAYS (notice patterns, give better advice. Never re-log these.)', format: 'block' as const },
    },
    eq: { frequencyRule: true, qualitativeFirst: true, coherence: true, expertJudgment: true },
    memory: { enabled: true, includeIds: true, budget: 5000, categories: {
      preference: 'Dietary preferences, food likes, cooking habits',
      aversion: 'Foods they dislike, allergies, dietary restrictions',
      routine: 'Eating patterns, meal timing, typical meals',
      health: 'Health conditions, body composition goals, energy patterns',
      motivation: 'What drives their food choices, relationship with food',
    }},
    craftMemory: { enabled: true, budget: 3000, categories: {
      approach: 'What works when coaching nutrition',
      pattern: 'Recurring patterns in how users relate to food',
      timing: 'When and how to surface insights or suggest meals',
      insight: 'Cross-user observations that sharpen guidance',
    }, purpose: 'Professional growth observations about being a better nutrition coach.' },
    diagnostics: { enabled: true },
    staging: { model: 'working-set' },
    followUpsDescription: 'Suggest what the user might naturally want to say or ask next. These appear as tappable bubbles in a mobile chat interface.',
  },
  initialState() {
    return {
      memories: [
        { id: 'mem-1', content: 'Standard breakfast: 60g smoked salmon, 1 egg + egg whites, broccoli, low-fat cottage cheese, tomato slices', category: 'routine' },
        { id: 'mem-2', content: 'Daily targets: 1900 cal, 160g protein, 170g carbs, 55g fat — on a cut to 78kg', category: 'health' },
        { id: 'mem-3', content: 'Usually rides Peloton Zone 2 around 6-7pm, has tea with collagen and creatine 30 min before', category: 'routine' },
        { id: 'mem-4', content: 'Interested in longevity nutrition — cruciferous vegetables, omega-3s, fermented foods, 30+ plants/week', category: 'preference' },
        { id: 'mem-5', content: 'Has low-fat cottage cheese, eggs, smoked salmon, broccoli, avocado, tomatoes in fridge', category: 'routine' },
        { id: 'mem-6', content: 'Evening routine: a small handful of almonds before bed for magnesium and sleep', category: 'routine' },
      ],
      meals: [],
      todayConsumed: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    }
  },
  buildContext(state) {
    const remaining = {
      cal: 1900 - state.todayConsumed.calories,
      protein: 160 - state.todayConsumed.proteinG,
      carbs: 170 - state.todayConsumed.carbsG,
      fat: 55 - state.todayConsumed.fatG,
    }
    const mealLines = state.meals.length === 0
      ? '\nNo meals logged today yet.'
      : '\nMeals so far today:\n' + state.meals.map(m => `- (id:${m.id}) ${m.description}`).join('\n')

    return {
      profile: `- Age: 41, Sex: male\n- Weight: 176.4 lbs, Height: 70 inches\n- Activity level: active\n- Goal: Lose weight\n- Journey context: Cutting to 78kg, last few KG. Zone 2 cardio + strength training.\n- Daily targets: 1900 cal, 160g protein, 170g carbs, 55g fat`,
      todayStatus: `2026-04-01, current time: 07:30\n- Consumed: ${state.todayConsumed.calories} cal, ${state.todayConsumed.proteinG}g protein, ${state.todayConsumed.carbsG}g carbs, ${state.todayConsumed.fatG}g fat\n- Remaining: ~${remaining.cal} cal, ~${remaining.protein}g protein, ~${remaining.carbs}g carbs, ~${remaining.fat}g fat\n- Weight: 176.4 lbs${mealLines}`,
      recentDays: `- 2026-03-31 (yesterday): 176 lbs | 1687 cal, 159g P, 140g C, 55g F | Salmon & Eggs Breakfast (salmon, eggs, cottage cheese, broccoli, tomato), Mexican Bowl lunch, Chocolate Yogurt Bowl dinner\n- 2026-03-30 (2 days ago): 176.8 lbs | 1750 cal, 162g P, 150g C, 49g F | Salmon & Eggs Breakfast, Grilled salmon with broccoli lunch, Yogurt + whey dinner\n- 2026-03-29 (3 days ago): 177.5 lbs | 1820 cal, 155g P, 165g C, 52g F | Salmon & Eggs Breakfast, Chicken salad lunch, Salmon + sweet potato dinner`,
    }
  },
  buildHandlers(state) {
    return {} satisfies Record<string, SideEffectHandler>
  },
  buildCrudHandlers(state) {
    return {
      meal: async (action: CrudAction) => {
        const params = typeof action.params === 'string' ? JSON.parse(action.params) : action.params ?? {}
        if (action.operation === 'create') {
          const items = params.items ?? []
          const cal = items.reduce((s: number, i: any) => s + (i.calories || 0), 0)
          const prot = items.reduce((s: number, i: any) => s + (i.proteinG || 0), 0)
          const carbs = items.reduce((s: number, i: any) => s + (i.carbsG || 0), 0)
          const fat = items.reduce((s: number, i: any) => s + (i.fatG || 0), 0)
          state.meals.push({
            id: action.id!,
            description: String(params.description ?? ''),
            calories: cal, proteinG: prot, carbsG: carbs, fatG: fat,
          })
          if (params.status !== 'draft') {
            state.todayConsumed.calories += cal
            state.todayConsumed.proteinG += prot
            state.todayConsumed.carbsG += carbs
            state.todayConsumed.fatG += fat
          }
        } else if (action.operation === 'update' && action.id) {
          const meal = state.meals.find(m => m.id === action.id)
          if (!meal) return
          if (params.description != null) meal.description = String(params.description)
          if (params.status === 'confirmed') {
            state.todayConsumed.calories += meal.calories
            state.todayConsumed.proteinG += meal.proteinG
            state.todayConsumed.carbsG += meal.carbsG
            state.todayConsumed.fatG += meal.fatG
          }
        } else if (action.operation === 'delete' && action.id) {
          const idx = state.meals.findIndex(m => m.id === action.id)
          if (idx !== -1) {
            const removed = state.meals.splice(idx, 1)[0]
            state.todayConsumed.calories -= removed.calories
            state.todayConsumed.proteinG -= removed.proteinG
          }
        }
      },
    } satisfies Record<string, CrudHandler>
  },
  summarizeState(state) {
    return [
      `meals=${state.meals.map(m => `${m.id}:${m.description}`).join(', ') || '(none)'}`,
      `consumed=${state.todayConsumed.calories}cal/${state.todayConsumed.proteinG}gP`,
      `memories=${state.memories.length}`,
    ].join(' | ')
  },
}

export const SAMPLE_PROJECTS = [
  coachProject,
  nutritionProject,
  fitnessProject,
  languageTutorProject,
  chiefOfStaffProject,
  savorProject,
] as const
