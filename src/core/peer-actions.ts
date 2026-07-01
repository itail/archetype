import { z } from 'zod'
import type { ActionDefinition, PeerConfig } from '../types.js'

/** Action name for the built-in peer consultation action */
export const PEER_ACTION_NAME = 'consultPeer'

/**
 * Build the consultPeer action definition from the declared peer config.
 * Auto-registered when peers are configured on withStorage() — same pattern as
 * memory CRUD entities when memory is enabled.
 *
 * The description is generated from peer identities so the persona knows
 * who it can consult and what each peer offers.
 */
export function buildPeerAction(peers: Record<string, PeerConfig>): Record<string, ActionDefinition> {
  const peerNames = Object.keys(peers)
  const peerDescriptions = peerNames
    .map(name => {
      const expertise = peers[name].expertise
      return expertise ? `${name} (${expertise})` : name
    })
    .join(', ')

  return {
    [PEER_ACTION_NAME]: {
      description: `Consult a peer for information or expertise you need to handle the current situation well. Available peers: ${peerDescriptions}. Be specific about what you need — the peer sees your query and curates a response.`,
      schema: z.object({
        peer: z.string().describe(`Which peer to consult: ${peerNames.join(' | ')}`),
        query: z.string().describe('What you need from them — be specific about topics, senders, timeframes, or data types'),
      }),
      confidence: 'low', // consulting is always safe — no side effects
    },
  }
}

/** Set of built-in peer action names (for auto-handling in managed mode) */
export const PEER_ACTION_NAMES = new Set([PEER_ACTION_NAME])
