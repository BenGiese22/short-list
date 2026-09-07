import { signSession, verifySession, nowSeconds, type SessionClaims } from './auth'

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

// Next's server-action CSRF check has already validated these headers against Origin.
export function shareOrigin(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host') ?? headers.get('host')
  if (!host) return null
  const isLoopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  const proto = headers.get('x-forwarded-proto') ?? (isLoopback ? 'http' : 'https')
  return `${proto}://${host}`
}

/**
 * Date labels for the share control, formatted by hand rather than through
 * toLocaleString.
 *
 * Two reasons. The control must read the same in every environment -- the dev
 * container runs UTC while the browser does not, and an ICU-dependent format
 * cannot be pinned in a unit test without also pinning a timezone, which would
 * stop it reflecting the viewer's own clock. And the app is English-only, the
 * same call `lib/facts.ts` already makes for money.
 *
 * Every reader below is a LOCAL-time getter, so the label is the viewer's
 * wall clock while staying deterministic for a given Date.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** "Sun 13 Sep" -- no zero-padding on the day, matching how a person says it. */
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

export type ShareLinkResult =
  | { ok: true; url: string; expiresAt: number }
  | { ok: false; message: string }

export function buildShareLink(input: {
  cookie: string | undefined
  duration: unknown
  requestHeaders: Headers
  now?: number
}): ShareLinkResult {
  const now = input.now ?? nowSeconds()

  // Authorization inside this function, so the gate holds for a hand-crafted POST.
  const session = verifySession(input.cookie, now)
  if (!session || session.role !== 'owner') {
    return { ok: false, message: 'Only the passcode session can create share links.' }
  }
  if (!isShareDuration(input.duration)) {
    return { ok: false, message: 'Pick a valid duration.' }
  }
  const origin = shareOrigin(input.requestHeaders)
  if (!origin) {
    return { ok: false, message: 'Could not determine the site address.' }
  }

  const expiresAt = now + SHARE_DURATIONS[input.duration]
  const token = signSession({ role: 'guest', expiresAt })
  return { ok: true, url: `${origin}/s/${token}`, expiresAt }
}

export type ShareVisit =
  | { kind: 'set'; claims: SessionClaims }
  | { kind: 'keep' }
  | { kind: 'reject' }

export function resolveShareVisit(input: {
  token: string | undefined
  existingCookie: string | undefined
  now?: number
}): ShareVisit {
  const now = input.now ?? nowSeconds()

  const claims = verifySession(input.token, now)
  // Owner sessions are minted only by the passcode; never by a URL.
  if (!claims || claims.role !== 'guest') return { kind: 'reject' }

  // Don't downgrade an owner who clicks their own link.
  const existing = verifySession(input.existingCookie, now)
  if (existing?.role === 'owner') return { kind: 'keep' }

  return { kind: 'set', claims }
}
