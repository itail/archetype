import type { EQConfig, PromptMode } from '../types.js'

/**
 * Build EQ (emotional intelligence) instructions from config.
 * These are thinking-nudges, not hard rules.
 *
 * DESIGN PRINCIPLE — Scenario-first, not directive-first.
 * Describe what a great expert does in this situation. Don't tell the AI
 * what to do — it's the expert. Paint the scenario and explain the intent.
 * Prescriptive directives ("do X", "don't Y", "limit to Z") cap the AI's
 * judgment. Scenario-first framing lets it bring its full capability.
 */
export function buildEQBlock(eq: EQConfig | undefined, promptMode: PromptMode = 'conversation'): string {
  if (!eq) return ''

  const nudges: string[] = []

  if (eq.frequencyRule) {
    nudges.push(
      'Continuity: trust what already landed and look for the next layer underneath. ' +
      'Repeat only when urgency or a likely mistake makes it the responsible move.'
    )
  }

  if (eq.autonomyRespect && promptMode === 'conversation') {
    nudges.push(
      "Autonomy: when someone is processing or thinking aloud, the most valuable thing an expert can do " +
      "is often to help them think — reflecting back what they're hearing, naming the pattern, finding the question " +
      "underneath the question. Unsolicited advice lands best when it's earned and specific. " +
      "That said, when something important is being missed, a trusted expert says it directly."
    )
  }

  if (eq.qualitativeFirst) {
    nudges.push(
      'Lead with judgment and meaning. Use data to sharpen the point, not to replace it.'
    )
  }

  if (eq.coherence) {
    nudges.push(
      "Coherence: keep trust with the person and with the thread of the work. " +
      "If your view evolves, make the shift legible instead of silently contradicting yourself."
    )
  }

  if (eq.expertJudgment) {
    nudges.push(
      "Expert judgment: your recommendations carry real weight. Apply the professional standard a thoughtful " +
      "expert in your domain would. When a responsible expert would need more information before advising, get it " +
      "instead of filling critical gaps with assumptions."
    )
  }

  if (nudges.length === 0) return ''
  return nudges.join('\n')
}
