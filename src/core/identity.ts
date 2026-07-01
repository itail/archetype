import type { PersonaIdentity } from '../types.js'

const DEFAULT_KEYSTONE =
  'What is the single most impactful thing you could say right now?'
const DEFAULT_RELATIONAL_PREAMBLE =
  'You are an expert with a real person in front of you.'

/**
 * Build the identity paragraph of the system prompt from persona config.
 * This is the opening paragraph that sets expertise, relationship, and north star.
 *
 * DESIGN PRINCIPLE — Scenario-first, not directive-first.
 * Identity stays neutral: who this expert is, what they weave together,
 * and what they serve. Mode-specific presence/keystone hooks are layered
 * separately so operational turns do not inherit conversation assumptions.
 */
export function buildIdentityBlock(identity: PersonaIdentity): string {
  const { name, expertise, relationship, northStar, scopeBoundary } = identity
  const expertiseStr = joinNatural(expertise)

  // If the persona's name already contains the expertise word (e.g.
  // name="Coding Agent", expertise=["coding"]), restating "you bring deep
  // expertise in coding" is redundant and reads like coaching a mediocre
  // employee. Skip the expertise clause in that case — the name carries it.
  const nameNorm = name.toLowerCase()
  const expertiseAlreadyInName = expertise.some((e) => nameNorm.includes(e.toLowerCase()))

  const lines: string[] = []
  if (expertiseAlreadyInName || expertise.length === 0) {
    lines.push(`You are ${name} — a ${relationship}.`)
  } else {
    lines.push(
      `You are ${name} — a ${relationship}. ` +
      `You bring deep expertise in ${expertiseStr}.`
    )
  }
  lines.push(`Your north star is ${northStar}.`)
  if (scopeBoundary) {
    lines.push(scopeBoundary)
  }

  return lines.join('\n')
}

export function buildConversationKeystone(
  identity: PersonaIdentity,
  relationalPreamble?: string | false,
): string {
  const effectiveRelationalPreamble = relationalPreamble === undefined
    ? DEFAULT_RELATIONAL_PREAMBLE
    : relationalPreamble
  if (effectiveRelationalPreamble === false) return ''

  const keystoneStr = identity.keystone ?? DEFAULT_KEYSTONE
  return `${effectiveRelationalPreamble} ${keystoneStr}`
}

/** Join array items naturally: "a, b, and c" */
function joinNatural(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}
