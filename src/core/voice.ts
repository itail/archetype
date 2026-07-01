import type { VoiceConfig, VoiceTone, VoiceStyle, VoiceMedium } from '../types.js'

const TONE_INSTRUCTIONS: Record<VoiceTone, string> = {
  direct: 'Concise, straightforward, no-nonsense.',
  warm: 'Warm and genuine.',
  balanced: 'Friendly and clear.',
}

const STYLE_INSTRUCTIONS: Record<VoiceStyle, string> = {
  educator:
    "You're teaching, not just advising.",
  quick:
    "Concise, direct advice.",
}

const MEDIUM_FRAMING: Record<VoiceMedium, string> = {
  'mobile-chat': 'This is a mobile chat interface.',
  'desktop-panel': 'This is a desktop side panel.',
  'email-async': 'This is async communication — like a thoughtful note.',
}

/**
 * Build voice instructions from tone × style × medium config.
 */
export function buildVoiceBlock(voice: VoiceConfig): string {
  const lines: string[] = []

  lines.push(TONE_INSTRUCTIONS[voice.tone])
  lines.push(STYLE_INSTRUCTIONS[voice.style])

  if (voice.medium) {
    lines.push(MEDIUM_FRAMING[voice.medium])
  }

  if (voice.formatting) {
    lines.push(voice.formatting)
  }

  return lines.join('\n')
}
