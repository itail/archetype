import type { ChatParticipant } from '../types.js'

export interface AddressedParticipantInput {
  message: string
  participants?: readonly ChatParticipant[]
  actorId?: string
}

export interface SessionRecipientInput extends AddressedParticipantInput {
  /**
   * Recipient for an unaddressed opening/session message. This is factual
   * session setup, not a hidden scheduler: explicit conversational addresses
   * still win.
   */
  defaultRecipientId?: string | null
}

/**
 * Resolve whether a visible session message is addressed to another
 * participant. This is turn-taking, not judgment: the runtime honors the
 * conversational addressee instead of requiring hidden control actions for
 * ordinary teammate handoffs.
 */
export function resolveAddressedParticipantId(input: AddressedParticipantInput): string | null {
  const message = input.message.trim()
  if (!message) return null

  const peers = (input.participants ?? [])
    .filter(participant => participant.id && participant.id !== input.actorId)
  if (peers.length === 0) return null

  const explicit = peers
    .map(participant => ({ participant, index: participantNameMatchIndex(message, participant) }))
    .filter(item => item.index !== null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
  if (explicit) return explicit.participant.id

  if (peers.length === 1 && addressesSinglePeer(message)) return peers[0].id
  return null
}

export function resolveSessionRecipientId(input: SessionRecipientInput): string | null {
  const addressed = resolveAddressedParticipantId(input)
  if (addressed) return addressed

  const fallback = input.defaultRecipientId?.trim()
  if (!fallback) return null
  return participantExists(input.participants, fallback) ? fallback : null
}

function participantNameMatchIndex(message: string, participant: ChatParticipant) {
  const names = [participant.id, participant.label]
    .map(name => name.trim())
    .filter(Boolean)
    .map(escapeRegExp)
  let earliest: number | null = null
  for (const name of names) {
    const match = new RegExp(`(^|[\\s(])@?${name}(?=[\\s,:;.!?)]|$)`, 'iu').exec(message)
    if (!match) continue
    const index = match.index + (match[1]?.length ?? 0)
    earliest = earliest === null ? index : Math.min(earliest, index)
  }
  return earliest
}

function participantExists(participants: readonly ChatParticipant[] | undefined, id: string) {
  return (participants ?? []).some(participant => participant.id === id)
}

function addressesSinglePeer(message: string) {
  return /\b(could you|can you|please|over to you|your turn|let me know when|feel free to)\b/iu.test(message)
    || /(^|[.!?]\s+)take a look\b/iu.test(message)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
