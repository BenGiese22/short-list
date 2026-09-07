import { signSession, verifySession, nowSeconds, type SessionClaims } from './auth'
// The duration allowlist and its labels live in a module that never imports
// ./auth, so the client component can use them without dragging node:crypto
// into the browser bundle. See the note at the top of lib/share-durations.ts.
import { SHARE_DURATIONS, isShareDuration } from './share-durations'

// Next's server-action CSRF check has already validated these headers against Origin.
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
