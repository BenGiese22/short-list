/**
 * The share link's duration vocabulary and the labels that describe it.
 *
 * Split out of `share.ts` for one reason, and it is not tidiness: `ShareControl`
 * is a client component, and `share.ts` imports `./auth`, which imports
 * `node:crypto`. A single VALUE import (a type-only one is erased and harmless)
 * from a module that transitively reaches `node:crypto` makes the bundler
 * resolve it for the browser graph, and it falls back to the whole
 * crypto-browserify polyfill — wholesale, not per-export. Measured on this app:
 * 632 KB of client JS became 1,072 KB, ~440 KB of it cryptography that can
 * never run in a browser here.
 *
 * The function bodies in `auth.ts` were tree-shaken and no secret was exposed;
 * the cost was pure dead weight. So: nothing in this file may import `./auth`.
 */

// Closed allowlist, so 30 days is the hard ceiling on any link's life.
export const SHARE_DURATIONS = {
  '24h': 60 * 60 * 24,
  '7d': 60 * 60 * 24 * 7,
  '30d': 60 * 60 * 24 * 30,
} as const

export type ShareDuration = keyof typeof SHARE_DURATIONS

export function isShareDuration(value: unknown): value is ShareDuration {
  // hasOwn, not `in`: a string like 'constructor' must not match.
  return typeof value === 'string' && Object.hasOwn(SHARE_DURATIONS, value)
}

/**
 * Dates are formatted by hand rather than through toLocaleString.
 *
 * The label must read the same in every environment — the dev container runs
 * UTC while the browser does not — and an ICU-dependent format cannot be pinned
 * in a unit test without also pinning a timezone, which would stop it
 * reflecting the viewer's own clock. The app is English-only regardless.
 *
 * Every reader below is a LOCAL-time getter, so the label is the viewer's wall
 * clock while staying deterministic for a given Date.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** "Sun 13 Sep" — no zero-padding on the day, matching how a person says it. */
function dayLabel(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/**
 * The day a link of this duration stops working, for the picker.
 *
 * Date arithmetic in milliseconds rather than by incrementing the day, so a
 * 30-day link crossing a month or year boundary lands correctly.
 */
export function durationLabel(duration: ShareDuration, now: Date): string {
  return dayLabel(new Date(now.getTime() + SHARE_DURATIONS[duration] * 1000))
}

/**
 * "Sun 13 Sep, 3:04 PM" from the unix seconds `buildShareLink` returns.
 *
 * 12-hour, because that is how the times in this app get spoken aloud. Hour 0
 * and hour 12 both map to 12, which is the pair a `% 12` alone gets wrong.
 */
export function formatExpiry(expiresAt: number): string {
  const date = new Date(expiresAt * 1000)
  const hours = date.getHours()
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${dayLabel(date)}, ${hour12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
}
