const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2 hours

/**
 * Determine if a greeting/re-engagement is appropriate based on staleness.
 * Returns true if: no prior message, >2 hours since last, or new calendar day.
 */
export function shouldGreet(
  lastMessageAt: Date | null | undefined,
  now?: Date,
  timezone?: string,
): boolean {
  if (!lastMessageAt) return true

  const currentTime = now ?? new Date()
  const elapsed = currentTime.getTime() - lastMessageAt.getTime()

  if (elapsed >= STALE_THRESHOLD_MS) return true
  if (isNewDay(lastMessageAt, currentTime, timezone)) return true

  return false
}

/**
 * Check if two dates fall on different calendar days in the given timezone.
 */
function isNewDay(a: Date, b: Date, timezone?: string): boolean {
  const opts: Intl.DateTimeFormatOptions = { timeZone: timezone }
  const dayA = a.toLocaleDateString('en-CA', opts)
  const dayB = b.toLocaleDateString('en-CA', opts)
  return dayA !== dayB
}

/**
 * Build a greeting context hint for the system prompt.
 */
export function buildGreetingHint(
  isGreeting: boolean,
  timezone?: string,
): string {
  if (!isGreeting) return ''

  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  })
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: timezone })

  return `This is a fresh session (${dateStr}, ${timeStr}). The context, memories, and history you have paint the current situation.`
}
