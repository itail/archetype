/**
 * Cross-layer duplicate detector — a structural audit that catches the most
 * common "boxed brain" pattern: prose in the brain that restates content
 * already carried by entity descriptions, entity field describe() annotations,
 * context labels, EQ flags, or memory config.
 *
 * This isn't a replacement for judgment-level review — it's a cheap, deterministic
 * pass that catches the patterns we saw in the Savor v2 → v3 experiment:
 *  - "Profile settings use the profile entity" (duplicate of profile entity description)
 *  - "Weight: if given in kg, convert to lbs" (duplicate of weight field describe())
 *  - "use the id shown in PROFILE RECORD" (duplicate of context label with includeIds)
 *  - "qualitative language by default" (duplicate of eq.qualitativeFirst)
 *
 * Scenario-first design: the findings are advisory. Each finding names a
 * specific adjacent layer where the rule should live, not a brand-new rule.
 */
import type { PersonaConfig } from '../types.js'
import { parseBrainMarkdown } from '../brain.js'
import type { LoadedBrainArtifact } from '../types.js'

export interface CrossLayerAuditInput {
  config: PersonaConfig
  markdown?: string
  brain?: LoadedBrainArtifact
}

export interface CrossLayerDuplicate {
  /** Which layer the brain content duplicates. */
  targetLayer:
    | 'entity-description'
    | 'entity-field'
    | 'context-label'
    | 'eq-flag'
    | 'memory-purpose'
    | 'identity-keystone'
    | 'identity-northstar'
    | 'voice-formatting'
  /** The specific target (entity name, field name, context key, flag name). */
  target: string
  /** The offending text from the brain. */
  brainText: string
  /** Brain section where the text appears. */
  section: string
  /** Why it's duplicated and what to do. */
  suggestion: string
}

export interface CrossLayerAuditResult {
  pass: boolean
  duplicates: CrossLayerDuplicate[]
}

/**
 * Detect brain prose that restates content available in adjacent layers.
 *
 * The detector works by scanning brain lines for mentions of entity names,
 * field names, context keys, or EQ concepts, then checking whether the brain
 * line is a rule/directive (as opposed to domain-level framing that happens
 * to reference an entity name).
 */
export function auditCrossLayerDuplicates(input: CrossLayerAuditInput): CrossLayerAuditResult {
  const brain = input.brain ?? parseBrainMarkdown(input.markdown ?? '', undefined)
  const duplicates: CrossLayerDuplicate[] = []

  const config = input.config
  const entities = config.entities ?? {}
  const contextInputs = config.contextInputs ?? {}
  const eq = config.eq ?? {}
  const memory = config.memory
  const craftMemory = config.craftMemory
  const identity = config.identity
  const voice = config.voice

  for (const [sectionName, sectionContent] of Object.entries(brain.sections)) {
    for (const line of extractMeaningfulLines(sectionContent)) {
      const lower = line.toLowerCase()

      // Entity-name duplicates: brain line names an entity AND either
      //   (a) prescribes when/how to use it (routing rule), or
      //   (b) defines what it IS (definitional drift — belongs in entity description).
      for (const [entityName, entityConfig] of Object.entries(entities)) {
        const entityMentioned = lineNamesEntity(lower, entityName)
        if (!entityMentioned) continue

        if (lineLooksPrescriptive(line)) {
          duplicates.push({
            targetLayer: 'entity-description',
            target: entityName,
            brainText: line,
            section: sectionName,
            suggestion: `This rule directs the AI on when/how to use the '${entityName}' entity — move the routing guidance into the entity description or the relevant field's describe() annotation. The current description is: ${JSON.stringify(entityConfig?.description ?? null)}.`,
          })
        } else if (lineLooksDefinitional(line, entityName)) {
          duplicates.push({
            targetLayer: 'entity-description',
            target: entityName,
            brainText: line,
            section: sectionName,
            suggestion: `This brain line defines what '${entityName}' IS — that semantic belongs in the entity description, not the brain. The current description is: ${JSON.stringify(entityConfig?.description ?? null)}.`,
          })
        }
      }

      // Context-label duplicates: "use the id" / "the record shows" when includeIds is already on the label
      if (/\buse the id\b|\bthe id shown\b|\bwith the id\b/i.test(line)) {
        for (const [contextKey, contextInput] of Object.entries(contextInputs)) {
          if ('includeIds' in contextInput && contextInput.includeIds) {
            duplicates.push({
              targetLayer: 'context-label',
              target: contextKey,
              brainText: line,
              section: sectionName,
              suggestion: `Context '${contextKey}' already has includeIds=true — the AI can see the id in the context block. Delete the brain rule; or if the label isn't clear, strengthen the label text instead.`,
            })
          }
        }
      }

      // EQ flag duplicates
      if (/\bqualitative\b|\bwarm language by default\b|\bnumbers (only )?(when|if) (the user )?asks?\b/i.test(line)) {
        if (eq.qualitativeFirst) {
          duplicates.push({
            targetLayer: 'eq-flag',
            target: 'qualitativeFirst',
            brainText: line,
            section: sectionName,
            suggestion: `eq.qualitativeFirst is already enabled and drives this behavior at prompt-assembly time. Remove the brain rule.`,
          })
        }
      }

      // Frequency rule: detect both the literal phrase AND the concept
      // ("when something shows up once/twice/three times", "pattern worth naming",
      // "repetition is signal", etc.).
      if (
        /\bfrequency rule\b|\bdon'?t repeat the same observation\b/i.test(line) ||
        /\b(when|once)\b.*\b(pattern|thing|something)\b.*\b(three times|twice|repeats|keeps|shows up)\b/i.test(line) ||
        /\bpatterns?\b.*\b(across|worth naming|keep showing up|repeat)\b/i.test(line) ||
        /\b(shows up|appears) (once|twice|three times|\d+ times)\b.*\b(moment|coincidence|worth naming|pattern)\b/i.test(line)
      ) {
        if (eq.frequencyRule) {
          duplicates.push({
            targetLayer: 'eq-flag',
            target: 'frequencyRule',
            brainText: line,
            section: sectionName,
            suggestion: `eq.frequencyRule already drives "pattern vs moment" behavior at prompt-assembly time. Remove the brain rule.`,
          })
        }
      }

      if (/\bautonomy\b.*\b(respect|inform)\b|\brespect informed choices?\b/i.test(line)) {
        if (eq.autonomyRespect) {
          duplicates.push({
            targetLayer: 'eq-flag',
            target: 'autonomyRespect',
            brainText: line,
            section: sectionName,
            suggestion: `eq.autonomyRespect is already enabled. Remove the brain rule.`,
          })
        }
      }

      // Memory config duplicates: brain describes what memory is for when memory.purpose already covers it
      if (/\bdurable\b.*\bmemor(y|ies)\b|\bmemor(y|ies)\b.*\bnot\b.*\b(active|settings|targets|declared)\b/i.test(line)) {
        if (memory?.purpose || memory?.categories) {
          duplicates.push({
            targetLayer: 'memory-purpose',
            target: 'memory',
            brainText: line,
            section: sectionName,
            suggestion: `memory.purpose/categories already define what memory is for. Strengthen that config instead of restating in the brain.`,
          })
        }
      }

      // Identity keystone duplicates: brain restates the "single most impactful thing" frame
      if (identity?.keystone && keystoneOverlap(line)) {
        duplicates.push({
          targetLayer: 'identity-keystone',
          target: 'keystone',
          brainText: line,
          section: sectionName,
          suggestion: `identity.keystone already asks for the single most impactful move this turn. This brain line paraphrases that. Remove — the keystone is injected early in the prompt.`,
        })
      }

      // Identity northStar duplicates: brain restates the persona's enduring goal
      if (identity?.northStar && northStarOverlap(line, identity.northStar)) {
        duplicates.push({
          targetLayer: 'identity-northstar',
          target: 'northStar',
          brainText: line,
          section: sectionName,
          suggestion: `identity.northStar already carries the persona's enduring goal. This brain line restates it. Remove.`,
        })
      }

      // Voice formatting leaks: brain talks about markdown/rendering when voice.formatting exists (or should)
      if (voiceFormattingLeak(line)) {
        duplicates.push({
          targetLayer: 'voice-formatting',
          target: 'voice.formatting',
          brainText: line,
          section: sectionName,
          suggestion: voice?.formatting
            ? `This is markdown/rendering info — belongs in voice.formatting (which already exists), not in methodology.`
            : `This is markdown/rendering info — belongs in voice.formatting. Move it there so the brain stays focused on domain intent.`,
        })
      }
    }
  }

  return {
    pass: duplicates.length === 0,
    duplicates,
  }
}

/**
 * Pull meaningful lines from a brain section — skip headers, markers, blank lines,
 * but keep bullet items and prose paragraphs as candidate rules.
 */
function extractMeaningfulLines(content: string): string[] {
  return content
    .split('\n')
    .map((raw) => raw.replace(/^[-*]\s+/, '').trim())
    .filter((line) => {
      if (!line) return false
      if (line.length < 15) return false
      if (line.startsWith('#')) return false
      return true
    })
}

/**
 * A line "names" an entity if the entity name appears as a word (not as a substring
 * of an unrelated word). We use word-boundary matching and also try the pluralized
 * form (entities often appear as "threads" when the name is "thread").
 */
function lineNamesEntity(lowerLine: string, entityName: string): boolean {
  const esc = entityName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\b${esc}\\b`).test(lowerLine)) return true
  // Try simple plural: entity + 's' or entity + 'es'
  if (new RegExp(`\\b${esc}s\\b`).test(lowerLine)) return true
  if (new RegExp(`\\b${esc}es\\b`).test(lowerLine)) return true
  return false
}

/**
 * A line looks "definitional" when it reads as an explanation of what the entity
 * IS or WHAT IT CAPTURES, rather than a rule about when to use it. These
 * belong in the entity's description, not the brain.
 *
 * Patterns we catch:
 *  - `"[entity]s" are X` / `'[entity]s' are X`
 *  - `[entity] (is|are) [definition]`
 *  - `[entity] (have|means|represents|captures) X`
 *  - `[entity] (persist|exist|live|work) ...`
 */
function lineLooksDefinitional(line: string, entityName: string): boolean {
  const lower = line.toLowerCase()
  const esc = entityName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // "threads are CEO-level challenges"
  if (new RegExp(`["']?${esc}s?["']?\\s+(are|is)\\s+\\w+`, 'i').test(lower)) return true
  // "forcing functions have owners and deadlines"
  if (new RegExp(`\\b${esc}s?\\s+(have|means?|represents?|captures?|records?|persists?|exist|live)\\b`, 'i').test(lower)) return true
  // "movement means decisions" — defining a concept the enum/schema encodes
  if (new RegExp(`\\b(movement|progress|status|completion)\\b.*\\b(means?|is|includes?)\\b`, 'i').test(lower)) return true
  return false
}

/** Concept overlap with identity.keystone — "single most impactful move/thing". */
function keystoneOverlap(line: string): boolean {
  const lower = line.toLowerCase()
  // The keystone always asks for the single highest-leverage move. Brain
  // paraphrases take forms like "80/20", "biggest lever", "single move",
  // "highest leverage", "one thing that matters most".
  return (
    /\b80[/\\-]?20\b/.test(lower) ||
    /\b(single|one)\s+(move|thing|lever|question|message)\b.*\b(most|matters|impactful|leverage|disproportionate|highest|biggest)\b/i.test(lower) ||
    /\b(highest|biggest)\s+(leverage|lever|impact)\b/i.test(lower) ||
    /\bleverage point\b/.test(lower) ||
    /\bone (move|thing) that (creates|matters|moves)\b/i.test(lower)
  )
}

/**
 * Concept overlap with identity.northStar. Compare by shared distinctive words
 * (nouns ≥4 chars, excluding stopwords) between the brain line and northStar.
 * Threshold: ≥3 shared distinctive words AND the line is mostly restating
 * the goal (short / principle-shaped, not scene-setting).
 */
function northStarOverlap(line: string, northStar: string): boolean {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'for', 'from', 'with', 'into',
    'over', 'through', 'their', 'them', 'that', 'this', 'those', 'these',
    'what', 'when', 'where', 'which', 'while', 'your', 'yours', 'you',
    'its', 'is', 'are', 'be', 'been', 'have', 'has', 'had', 'will', 'would',
  ])
  const norm = (s: string) => s.toLowerCase().match(/[a-z]{4,}/g) ?? []
  const lineTokens = new Set(norm(line).filter((t) => !stop.has(t)))
  const starTokens = new Set(norm(northStar).filter((t) => !stop.has(t)))
  let shared = 0
  for (const t of starTokens) if (lineTokens.has(t)) shared++
  // Need substantial overlap AND line should be relatively short / principle-shaped
  return shared >= 3 && line.length < 200
}

/**
 * Detect markdown/rendering mentions that belong in voice.formatting, not the
 * brain's methodology.
 */
function voiceFormattingLeak(line: string): boolean {
  const lower = line.toLowerCase()
  return (
    /\bmarkdown\b/.test(lower) ||
    /\brenders?\b.*\b(rich|formatting|bold|italic|span)\b/i.test(lower) ||
    /\bformatting\b.*\b(helps? structure|when it helps?)\b/i.test(lower) ||
    /\*\*bold\*\*/.test(line) ||
    /<span style=/.test(line)
  )
}

/**
 * Detect whether a line reads like a rule/directive about what the AI should do,
 * as opposed to scene-setting prose that merely mentions an entity.
 */
function lineLooksPrescriptive(line: string): boolean {
  const lower = line.toLowerCase()
  const triggers = [
    /\buse the\b/,
    /\buse \w+\b/,
    /\bupdate the\b/,
    /\brecord\b/,
    /\blive in\b/,
    /\blives? here\b/,
    /\bsettings? use\b/,
    /\bnot (in )?(memor|memories)\b/,
    /\bfor [a-z ]+ updates?,? use\b/,
    /\bif (given|reported) in\b/,
    /\bconvert to\b/,
    /\bthe recipe is part of\b/,
    /\bvisible card\b/,
    /\bdraft meals?\b.*\b(recipe|card|update)\b/,
    /\bprofile settings?\b/,
    /\bshould\b.*\bnot\b/,
    /\bdo not\b/,
    /\bmust\b/,
  ]
  return triggers.some((pattern) => pattern.test(lower))
}
