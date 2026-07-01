import type { PersonaConfig, ChatInput, ChatSessionFrame, Memory, PromptMode, PromptOrigin, PromptScaffoldConfig, PromptedTurnPromptInput, RetrospectPromptInput } from '../types.js'
import { buildConversationKeystone, buildIdentityBlock } from './identity.js'
import { buildVoiceBlock } from './voice.js'
import { buildEQBlock } from './eq.js'
import { serializeAllContext } from './context.js'
import { buildMemoryBlock } from './memory.js'
import { buildKnowledgeBlock } from './knowledge.js'
import { buildActionsBlock } from './actions.js'
import { buildEntitiesBlock } from './crud-prompt.js'
import { buildWorkingSetSection } from '../engine/working-set.js'
import { buildPromptedTurnTailSections, toPromptedTurnChatInput } from './prompted-turn.js'
import { getBrainSection, resolvePersonaConfigBrain } from '../brain.js'
import {
  CONVERSATION_REALITY,
  APP_INITIATED_TURN_REALITY,
  OPERATIONAL_REALITY,
  MEMORY_ENTITY_RULES,
  MEMORY_METADATA_GUIDANCE,
  ATTACHMENT_CONTINUITY_RULES,
  RETROSPECTIVE_MEMORY_POLICY,
  RETROSPECTIVE_OUTPUT_FORMAT,
  ACTION_OUTPUT_FORMAT,
  OPERATIONAL_ACTION_OUTPUT_FORMAT,
  FOCUS_ACTION_OUTPUT_FORMAT,
  FOCUS_REALITY,
  EXPERT_AUTONOMY,
  DIAGNOSTICS_CHANNEL,
  CRAFT_MEMORY_SECTION_INTRO,
  RETROSPECTIVE_CRAFT_POLICY,
  MOMENTUM,
  COME_BACK_TEST,
  OUTCOME_NOTES_INSTRUCTION,
  CRAFT_MEMORY_FULLCRUD_RULES,
} from '../playbook/defaults.js'
import { resolvePromptedTurnMode } from './prompt-mode.js'
import { resolveEntities } from './effective-config.js'

function resolveVoiceConfig(config: PersonaConfig): PersonaConfig['voice'] {
  const brainFormatting = getBrainSection(config.brain, 'voice-formatting')
  if (!brainFormatting || config.voice.formatting) return config.voice
  return { ...config.voice, formatting: brainFormatting }
}

function resolveJoinedBrainSections(config: PersonaConfig, names: string[]): string | undefined {
  const sections = names
    .map(name => getBrainSection(config.brain, name))
    .filter((value): value is string => Boolean(value))
  return sections.length > 0 ? sections.join('\n\n') : undefined
}

function resolveMethodology(config: PersonaConfig): string | undefined {
  const parts = [
    resolveJoinedBrainSections(config, ['methodology', 'action-protocol']),
    config.methodology,
  ].filter((value): value is string => Boolean(value))
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function resolveDirectives(config: PersonaConfig, override?: string | null): string | undefined {
  return override ?? config.directives?.default ?? getBrainSection(config.brain, 'directives')
}

function buildSessionFrameBlock(session?: ChatSessionFrame): string | undefined {
  if (!session) return undefined

  const lines = ['Session:']
  if (session.actorId?.trim()) lines.push(`- Speaking as: ${session.actorId.trim()}`)
  if (session.visibleTo?.trim()) lines.push(`- Visible message goes to: ${session.visibleTo.trim()}`)
  if (session.purpose?.trim()) lines.push(`- Session purpose: ${session.purpose.trim()}`)

  const participants = (session.participants ?? [])
    .map(participant => {
      const id = participant.id.trim()
      const label = participant.label.trim()
      const description = participant.description?.trim()
      if (!id && !label && !description) return null
      const name = id && label ? `${id}: ${label}` : id || label
      return description ? `- ${name} — ${description}` : `- ${name}`
    })
    .filter((line): line is string => Boolean(line))
  if (participants.length > 0) {
    lines.push('Participants:')
    lines.push(...participants)
  }

  return lines.length > 1 ? lines.join('\n') : undefined
}

export interface PromptBuilderInput {
  config: PersonaConfig
  input: ChatInput
}

function buildScaffoldSections(
  chatInput: ChatInput,
  promptMode: PromptMode,
): string[] {
  const sections: string[] = []
  const promptOrigin: PromptOrigin = chatInput.promptOrigin ?? 'user'

  if (promptOrigin === 'app' && promptMode === 'conversation') {
    sections.push(APP_INITIATED_TURN_REALITY)
  }

  if (promptMode === 'conversation') {
    sections.push(CONVERSATION_REALITY)
  } else if (promptMode === 'operational') {
    sections.push(OPERATIONAL_REALITY)
  } else if (promptMode === 'focus') {
    sections.push(FOCUS_REALITY)
  }

  sections.push(EXPERT_AUTONOMY)

  // ATTACHMENT_CONTINUITY_RULES instructs the model to use an
  // `attachmentNotes` field that only exists in the chat/operational
  // response schema. In focus mode the schema is {message, actions,
  // diagnostics} — no attachmentNotes — so injecting this block creates a
  // prompt-vs-schema contradiction. Focus mode uses attachments for
  // immediate verification (e.g. browserScreenshot), not long-horizon
  // carry-forward; skip the block there.
  if (chatInput.attachments?.length && promptMode !== 'focus') {
    sections.push(ATTACHMENT_CONTINUITY_RULES)
  }

  sections.push(
    promptMode === 'operational'
      ? OPERATIONAL_ACTION_OUTPUT_FORMAT
      : promptMode === 'focus'
        ? FOCUS_ACTION_OUTPUT_FORMAT
        : ACTION_OUTPUT_FORMAT
  )

  return sections
}

function resolvePromptScaffold(
  mode: PromptMode,
  configScaffold?: PromptScaffoldConfig,
  inputScaffold?: PromptScaffoldConfig,
): PromptScaffoldConfig {
  const defaultOperationalScaffold: PromptScaffoldConfig = mode !== 'conversation'
    ? {
        relationalPreamble: false,
        momentumBlock: false,
        comeBackTest: false,
      }
    : {}
  return {
    relationalPreamble: inputScaffold?.relationalPreamble ?? configScaffold?.relationalPreamble ?? defaultOperationalScaffold.relationalPreamble,
    momentumBlock: inputScaffold?.momentumBlock ?? configScaffold?.momentumBlock ?? defaultOperationalScaffold.momentumBlock,
    comeBackTest: inputScaffold?.comeBackTest ?? configScaffold?.comeBackTest ?? defaultOperationalScaffold.comeBackTest,
  }
}

const LOCALE_NAMES: Record<string, string> = {
  he: 'Hebrew',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  ru: 'Russian',
  it: 'Italian',
}

function resolvePromptNow(promptNow?: Date | string): Date {
  if (!promptNow) return new Date()
  return promptNow instanceof Date ? promptNow : new Date(promptNow)
}

function formatDateTime(timezone?: string, promptNow?: Date | string): string {
  const now = resolvePromptNow(promptNow)
  if (timezone) {
    const date = now.toLocaleDateString('en-CA', { timeZone: timezone })
    const time = now.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })
    return `Today: ${date}, ${time} (${timezone})`
  }
  return `Today's date: ${now.toLocaleDateString('en-CA')}`
}

/**
 * Assemble all prompt sections into a complete system prompt.
 * This is the main composition function — Layer 0's capstone.
 *
 * Section order follows the playbook's "Anatomy of a Finished Prompt":
 * 1. Date + user identity
 * 2. Identity (who is this persona)
 * 3. Voice (how does it sound)
 * 4. Methodology (domain-specific, locked)
 * 5. Directives (personal, editable)
 * 6. EQ (thinking-nudges)
 * 7. Actions (what can it do)
 * 8. Anti-pattern guards
 * 9. Judgment over literalism
 * 10. Cold start
 * 11. History + action hygiene
 * 12. Memory rules
 * 13. Output format
 * 14. Greeting hint (if applicable)
 * 15. Context blocks
 * 16. Memories
 * 17. Extra sections
 * 18. Come-back test (always last)
 */
export function buildSystemPrompt(input: PromptBuilderInput): string {
  const config = resolvePersonaConfigBrain(input.config)
  const { input: chatInput } = input
  const sections: string[] = []
  const promptMode = chatInput.promptMode ?? 'conversation'
  const promptScaffold = resolvePromptScaffold(promptMode, config.promptScaffold, chatInput.promptScaffold)

  // 1. Date + time + user identity
  sections.push(formatDateTime(chatInput.timezone, chatInput.promptNow))

  if (chatInput.userIdentity) {
    sections.push(`You are talking to ${chatInput.userIdentity}.`)
  }

  // Locale
  if (chatInput.locale) {
    const localeName = LOCALE_NAMES[chatInput.locale] ?? chatInput.locale
    sections.push(`RESPOND IN ${localeName}.`)
  }

  // 2. Identity
  sections.push(buildIdentityBlock(config.identity))

  if (promptMode === 'conversation') {
    const keystone = buildConversationKeystone(config.identity, promptScaffold.relationalPreamble)
    if (keystone) sections.push(keystone)
  }

  // 3. Voice
  if (promptMode === 'conversation') {
    sections.push(buildVoiceBlock(resolveVoiceConfig(config)))
  }

  const sessionFrame = buildSessionFrameBlock(chatInput.session)
  if (sessionFrame) sections.push(sessionFrame)

  // 4. Methodology (domain-specific, locked)
  const methodology = resolveMethodology(config)
  if (methodology) {
    sections.push(methodology)
  }

  // 5. Directives (personal, may be overridden per-call)
  const directives = resolveDirectives(config, chatInput.directives)
  if (directives) {
    sections.push(directives)
  }

  // 6. EQ
  const eqBlock = buildEQBlock(config.eq, promptMode)
  if (eqBlock) sections.push(eqBlock)

  if (promptScaffold.momentumBlock !== false) {
    sections.push(promptScaffold.momentumBlock ?? MOMENTUM)
  }
  if (promptScaffold.comeBackTest !== false) {
    sections.push(promptScaffold.comeBackTest ?? COME_BACK_TEST)
  }

  // 7. Actions
  const contractStyle = chatInput.contractStyle ?? 'full'
  const actionsBlock = buildActionsBlock(config.actions, promptMode, contractStyle)
  if (actionsBlock) sections.push(actionsBlock)

  // 7b. Entities (CRUD)
  if (config.entities && Object.keys(config.entities).length > 0) {
    const entitiesBlock = buildEntitiesBlock(config.entities, promptMode, contractStyle)
    if (entitiesBlock) sections.push(entitiesBlock)
  }

  // 7c. Outcome notes — when the persona has actions or entities, explain how outcome notes work
  const hasActions = config.actions && Object.keys(config.actions).length > 0
  const hasEntities = config.entities && Object.keys(config.entities).length > 0
  if ((hasActions || hasEntities) && promptMode !== 'focus') {
    sections.push(OUTCOME_NOTES_INSTRUCTION)
  }

  // 8-13. Playbook defaults
  sections.push(...buildScaffoldSections(chatInput, promptMode))

  if (config.memory?.enabled) {
    const memoryPurpose = buildMemoryPurposeSection(config)
    if (memoryPurpose) sections.push(memoryPurpose)
    sections.push(MEMORY_ENTITY_RULES)
    sections.push(MEMORY_METADATA_GUIDANCE)
  }

  // Diagnostics channel
  if (config.diagnostics?.enabled) {
    sections.push(DIAGNOSTICS_CHANNEL)
  }

  // Craft memory extraction
  if (config.craftMemory?.enabled) {
    const craftPurpose = buildCraftMemoryPurposeSection(config)
    if (craftPurpose) sections.push(craftPurpose)
    sections.push(CRAFT_MEMORY_FULLCRUD_RULES)
  }

  // 13. Context blocks
  if (config.contextInputs && chatInput.context) {
    const contextStr = serializeAllContext(config.contextInputs, chatInput.context)
    if (contextStr) sections.push(contextStr)
  }

  // 14. Memories
  if (chatInput.memories && chatInput.memories.length > 0) {
    const memoryBudget = config.memory?.budget ?? findMemoryBudget(config)
    const includeIds = config.memory?.includeIds ?? false
    const memBlock = buildMemoryBlock(chatInput.memories, {
      budget: memoryBudget,
      label: findMemoryLabel(config),
      includeIds,
      prioritize: findMemoryPrioritize(config),
    })
    if (memBlock) sections.push(memBlock)
  }

  if ((config.knowledge?.enabled ?? true) && chatInput.knowledgeDocuments && chatInput.knowledgeDocuments.length > 0) {
    const knowledgeBlock = buildKnowledgeBlock(chatInput.knowledgeDocuments, {
      budget: config.knowledge?.budget,
      maxDocuments: config.knowledge?.maxDocuments,
      label: config.knowledge?.label,
      purpose: config.knowledge?.purpose,
    })
    if (knowledgeBlock) sections.push(knowledgeBlock)
  }

  // Craft memories (separate block, after user memories)
  if (config.craftMemory?.enabled && chatInput.craftMemories && chatInput.craftMemories.length > 0) {
    const craftBudget = config.craftMemory.budget ?? 3000
    const craftBlock = buildMemoryBlock(chatInput.craftMemories, {
      budget: craftBudget,
      label: 'CRAFT MEMORY',
      includeIds: true,
    })
    if (craftBlock) {
      sections.push(CRAFT_MEMORY_SECTION_INTRO)
      sections.push(craftBlock)
    }
  }

  const workingSetSection = buildWorkingSetSection(chatInput.workingSet)
  if (workingSetSection) sections.push(workingSetSection)

  // 15. Extra sections
  if (chatInput.extraSystemSections) {
    for (const extra of chatInput.extraSystemSections) {
      if (extra.trim()) sections.push(extra)
    }
  }

  if (chatInput.tailSystemSections) {
    for (const extra of chatInput.tailSystemSections) {
      if (extra.trim()) sections.push(extra)
    }
  }

  return sections.filter(s => s.trim()).join('\n\n')
}

function findMemoryBudget(config: PersonaConfig): number {
  if (config.contextInputs) {
    for (const def of Object.values(config.contextInputs)) {
      if (def.label?.toLowerCase().includes('memory') && def.budget) {
        return def.budget
      }
    }
  }
  return 8000
}

function findMemoryLabel(config: PersonaConfig): string {
  if (config.contextInputs) {
    for (const def of Object.values(config.contextInputs)) {
      if (def.label?.toLowerCase().includes('memory')) {
        return def.label
      }
    }
  }
  return 'MEMORY'
}

function findMemoryPrioritize(config: PersonaConfig): 'pinned-first' | 'recent-first' | undefined {
  if (config.contextInputs) {
    for (const def of Object.values(config.contextInputs)) {
      if (def.label?.toLowerCase().includes('memory') && def.prioritize) {
        return def.prioritize
      }
    }
  }
  return undefined
}

/**
 * Build prompt for an app-initiated turn.
 * Composes on buildSystemPrompt() — same action contract, memory rules, diagnostics —
 * plus prompted-turn-specific framing (intent, guidelines, recent history).
 */
export function buildPromptedTurnPrompt(input: PromptedTurnPromptInput): string {
  const chatInput = toPromptedTurnChatInput({
    timezone: input.input.timezone,
    userIdentity: input.input.userIdentity,
    locale: input.input.locale,
    memories: input.input.memories,
    knowledgeDocuments: input.input.knowledgeDocuments,
    craftMemories: input.input.craftMemories,
    context: input.input.context,
    directives: input.input.directives,
    extraSystemSections: input.input.extraSystemSections,
    tailSystemSections: input.input.tailSystemSections,
    promptMode: input.input.promptMode,
    promptScaffold: input.input.promptScaffold,
    workingSet: input.input.workingSet,
    turnKind: input.turnKind,
    intent: input.intent,
    label: input.label,
    guidelines: input.guidelines,
    history: input.history,
  })

  const systemPrompt = buildSystemPrompt({
    config: input.config,
    input: {
      ...chatInput,
      message: '',
    },
  })

  // The runtime path already carries the app-initiated frame through tailSystemSections.
  // Keep this builder aligned with the live system prompt and only inline review-only context.
  const sections: string[] = [systemPrompt]

  if (input.history && input.history.length > 0) {
    const recent = input.history.slice(-6)
      .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n')
    sections.push(
      'RECENT CONVERSATION:\n' +
      recent +
      '\nUse this for continuity.'
    )
  }

  return sections.filter(s => s.trim()).join('\n\n')
}

/**
 * Build a silent retrospective prompt for memory maintenance.
 * This is non-user-facing and should only emit memory CRUD actions.
 */
export function buildRetrospectPrompt(input: RetrospectPromptInput): string {
  const config = resolvePersonaConfigBrain(input.config)
  const { input: chatInput } = input
  const sections: string[] = []
  const promptScaffold = resolvePromptScaffold(chatInput.promptMode ?? 'conversation', config.promptScaffold, chatInput.promptScaffold)
  const retrospectEntities = Object.fromEntries(
    Object.entries(resolveEntities(config) ?? {}).filter(([name]) => name === 'memory' || name === 'craftMemory'),
  )

  sections.push(formatDateTime(chatInput.timezone, chatInput.promptNow))

  if (chatInput.userIdentity) {
    sections.push(`You are reflecting on ${chatInput.userIdentity}.`)
  }

  if (chatInput.locale) {
    const localeName = LOCALE_NAMES[chatInput.locale] ?? chatInput.locale
    sections.push(`RESPOND IN ${localeName}.`)
  }

  sections.push(buildIdentityBlock(config.identity))

  if ((chatInput.promptMode ?? 'conversation') === 'conversation') {
    const keystone = buildConversationKeystone(config.identity, promptScaffold.relationalPreamble)
    if (keystone) sections.push(keystone)
  }
  sections.push(buildVoiceBlock(resolveVoiceConfig(config)))

  const methodology = resolveMethodology(config)
  if (methodology) {
    sections.push(methodology)
  }

  const directives = resolveDirectives(config, chatInput.directives)
  if (directives) {
    sections.push(directives)
  }

  const eqBlock = buildEQBlock(config.eq)
  if (eqBlock) sections.push(eqBlock)

  // Memory entities use the CRUD system; render entities block when present
  if (Object.keys(retrospectEntities).length > 0) {
    const entitiesBlock = buildEntitiesBlock(
      retrospectEntities,
      chatInput.promptMode ?? 'conversation',
      chatInput.contractStyle ?? 'full',
    )
    if (entitiesBlock) sections.push(entitiesBlock)
  }

  sections.push(CONVERSATION_REALITY)
  const memoryPurpose = buildMemoryPurposeSection(config)
  if (memoryPurpose) sections.push(memoryPurpose)
  sections.push(RETROSPECTIVE_MEMORY_POLICY)
  sections.push(MEMORY_METADATA_GUIDANCE)

  // Inject category descriptions so the LLM categorizes with domain awareness
  if (config.memory?.categories && Object.keys(config.memory.categories).length > 0) {
    const categoryGuide = Object.entries(config.memory.categories)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join('\n')
    sections.push(`Memory categories for this domain:\n${categoryGuide}\nUse these categories when saving memories. If none fits, use "general".`)
  }

  // Craft memory reflection
  if (config.craftMemory?.enabled) {
    const craftPurpose = buildCraftMemoryPurposeSection(config)
    if (craftPurpose) sections.push(craftPurpose)
    sections.push(RETROSPECTIVE_CRAFT_POLICY)

    if (config.craftMemory.categories && Object.keys(config.craftMemory.categories).length > 0) {
      const craftCategoryGuide = Object.entries(config.craftMemory.categories)
        .map(([name, desc]) => `- ${name}: ${desc}`)
        .join('\n')
      sections.push(`Craft memory categories:\n${craftCategoryGuide}`)
    }
  }

  // Diagnostics in retrospect
  if (config.diagnostics?.enabled) {
    sections.push(DIAGNOSTICS_CHANNEL)
  }

  sections.push(RETROSPECTIVE_OUTPUT_FORMAT)

  sections.push(
    'RETROSPECTIVE MODE:\n' +
    'This is a silent internal reflection pass. Review the recent conversation and current context to decide whether durable memory should be created, updated, or deleted.\n' +
    'Do not produce user-facing coaching. Focus on what should change in memory.'
  )

  if (input.guidelines) {
    sections.push(input.guidelines)
  }

  if (input.history && input.history.length > 0) {
    const recent = input.history.slice(-12)
      .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n')
    sections.push(
      'RECENT CONVERSATION:\n' +
      recent +
      '\nLook for repeated behavioral patterns, stable constraints, and what would have improved earlier recommendations.'
    )
  }

  if (config.contextInputs && chatInput.context) {
    const contextStr = serializeAllContext(config.contextInputs, chatInput.context)
    if (contextStr) sections.push(contextStr)
  }

  if (chatInput.memories && chatInput.memories.length > 0) {
    const memoryBudget = config.memory?.budget ?? findMemoryBudget(config)
    const includeIds = true
    const memBlock = buildMemoryBlock(chatInput.memories, {
      budget: Math.min(memoryBudget, 5000),
      label: findMemoryLabel(config),
      includeIds,
    })
    if (memBlock) sections.push(memBlock)
  }

  if ((config.knowledge?.enabled ?? true) && chatInput.knowledgeDocuments && chatInput.knowledgeDocuments.length > 0) {
    const knowledgeBlock = buildKnowledgeBlock(chatInput.knowledgeDocuments, {
      budget: Math.min(config.knowledge?.budget ?? 6000, 6000),
      maxDocuments: config.knowledge?.maxDocuments,
      label: config.knowledge?.label,
      purpose: config.knowledge?.purpose,
    })
    if (knowledgeBlock) sections.push(knowledgeBlock)
  }

  // Craft memories in retrospect (with IDs for update/delete)
  if (config.craftMemory?.enabled && chatInput.craftMemories && chatInput.craftMemories.length > 0) {
    const craftBudget = config.craftMemory.budget ?? 3000
    const craftBlock = buildMemoryBlock(chatInput.craftMemories, {
      budget: Math.min(craftBudget, 3000),
      label: 'CRAFT MEMORY',
      includeIds: true,
    })
    if (craftBlock) sections.push(craftBlock)
  }

  const workingSetSection = buildWorkingSetSection(chatInput.workingSet)
  if (workingSetSection) sections.push(workingSetSection)

  if (chatInput.extraSystemSections) {
    for (const extra of chatInput.extraSystemSections) {
      if (extra.trim()) sections.push(extra)
    }
  }

  return sections.filter(s => s.trim()).join('\n\n')
}

function buildMemoryPurposeSection(config: PersonaConfig): string | null {
  const purpose = config.memory?.purpose?.trim()
  if (!purpose) return null
  return `MEMORY PURPOSE:\n${purpose}`
}

function buildCraftMemoryPurposeSection(config: PersonaConfig): string | null {
  const purpose = config.craftMemory?.purpose?.trim()
  if (!purpose) return null
  return `CRAFT MEMORY PURPOSE:\n${purpose}`
}

/**
 * Backward-compatible helper for greeting-specific prompt construction.
 */
export function buildGreetingPrompt(input: Omit<PromptedTurnPromptInput, 'intent' | 'label'>): string {
  return buildPromptedTurnPrompt({
    ...input,
    turnKind: input.turnKind ?? 'proactive-conversation',
    label: 'Greeting',
    intent: "You're checking in on a fresh or resumed session. Generate a warm, natural check-in that reads like a thoughtful person, not a notification.",
  })
}
