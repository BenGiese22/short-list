import { signSession, verifySession, remainingSeconds, nowSeconds } from './auth'

// Closed allowlist. The server action never accepts raw seconds, so 30 days
// is the hard ceiling on any link's life.
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

// Vercel sets x-forwarded-host / x-forwarded-proto on every deployment, and
// Next's server-action CSRF check has already verified Origin against
// Host / X-Forwarded-Host by the time an action runs, so these headers are
// the origin the owner's browser attested to. Falls back for `next dev`.
export function shareOrigin(headers: Headers): string | null {
  const host = headers.get('x-forwarded-host') ?? headers.get('host')
  if (!host) return null
  const isLoopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  const proto = headers.get('x-forwarded-proto') ?? (isLoopback ? 'http' : 'https')
  return `${proto}://${host}`
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

  // Authorization first, and inside this function, so the gate holds for a
  // hand-crafted POST just as it does for the UI.
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
  | { kind: 'set'; value: string; maxAge: number }
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

  // The cookie can never outlive the link: its lifetime is what is left.
  return { kind: 'set', value: input.token!, maxAge: Math.max(1, remainingSeconds(claims, now)) }
}
