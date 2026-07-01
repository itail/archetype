import { describe, expect, it } from 'vitest'
import { resolveAddressedParticipantId, resolveSessionRecipientId } from '../src/index.js'

const participants = [
  { id: 'pm', label: 'Product Manager' },
  { id: 'builder', label: 'Builder' },
]

describe('session routing', () => {
  it('routes explicit participant addresses to that participant', () => {
    expect(resolveAddressedParticipantId({
      actorId: 'pm',
      participants,
      message: 'Builder, the design is ready in spec/design.md.',
    })).toBe('builder')
  })

  it('uses the earliest explicit participant address instead of participant list order', () => {
    expect(resolveAddressedParticipantId({
      actorId: 'human',
      participants,
      message: 'Builder, I want a substantial browser adventure game. PM should keep the product spine clear.',
    })).toBe('builder')
  })

  it('routes second-person handoffs to the only peer in a two-person session', () => {
    expect(resolveAddressedParticipantId({
      actorId: 'pm',
      participants,
      message: 'For the first build step, could you set up the playable shell?',
    })).toBe('builder')
    expect(resolveAddressedParticipantId({
      actorId: 'pm',
      participants,
      message: 'The spec is in spec.md. Take a look, and if it looks good, feel free to start scaffolding the artifact.',
    })).toBe('builder')
  })

  it('does not route self-status updates without an addressed peer', () => {
    expect(resolveAddressedParticipantId({
      actorId: 'pm',
      participants,
      message: 'I am reviewing the brief and plan before writing the next spec update.',
    })).toBeNull()
    expect(resolveAddressedParticipantId({
      actorId: 'builder',
      participants,
      message: "Let's take a look at the scaffolded files and start implementing the core game logic.",
    })).toBeNull()
    expect(resolveAddressedParticipantId({
      actorId: 'builder',
      participants,
      message: "I'll take a look at the current files before editing.",
    })).toBeNull()
    expect(resolveAddressedParticipantId({
      actorId: 'builder',
      participants,
      message: "The files are in place. I'll start the server and take a look at the game in the browser.",
    })).toBeNull()
  })

  it('does not infer a second-person addressee when multiple peers are available', () => {
    expect(resolveAddressedParticipantId({
      actorId: 'pm',
      participants: [
        ...participants,
        { id: 'designer', label: 'Designer' },
      ],
      message: 'Could you review the next build step?',
    })).toBeNull()
  })

  it('uses the declared default recipient for unaddressed session openings', () => {
    expect(resolveSessionRecipientId({
      actorId: 'user',
      participants,
      defaultRecipientId: 'builder',
      message: 'Let’s build Clockwork Courier.',
    })).toBe('builder')
  })

  it('lets explicit addresses override the declared default recipient', () => {
    expect(resolveSessionRecipientId({
      actorId: 'user',
      participants,
      defaultRecipientId: 'builder',
      message: 'PM, can you clarify the player promise first?',
    })).toBe('pm')
  })

  it('ignores a missing default recipient instead of inventing a participant', () => {
    expect(resolveSessionRecipientId({
      actorId: 'user',
      participants,
      defaultRecipientId: 'designer',
      message: 'Let’s build Clockwork Courier.',
    })).toBeNull()
  })
})
