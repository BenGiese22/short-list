import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'short_list_session'
export const OWNER_SESSION_SECONDS = 60 * 60 * 24 * 90

export type Role = 'owner' | 'guest'
export type SessionClaims = { role: Role; expiresAt: number; keyVersion: string }

// Wire format: `v1-<role>-<expiresAt>-<keyVersion>.<hex hmac>`. No field's charset admits a separator.
const FORMAT = 'v1'
const ROLES: ReadonlySet<string> = new Set<Role>(['owner', 'guest'])
const EXP_RE = /^\d{1,12}$/
const KEY_VERSION_RE = /^[A-Za-z0-9]{1,32}$/
const SIG_RE = /^[0-9a-f]{64}$/

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// A revocation epoch, not a secret: bumping it invalidates every outstanding token.
export function currentKeyVersion(): string {
  const kv = process.env.SHARE_KEY_VERSION ?? '1'
  if (!KEY_VERSION_RE.test(kv)) {
    throw new Error('SHARE_KEY_VERSION must be 1-32 alphanumeric characters')
  }
  return kv
}

function sign(payload: string): string {
  return createHmac('sha256', process.env.COOKIE_SECRET!).update(payload).digest('hex')
}

export function signSession(claims: { role: Role; expiresAt: number }): string {
  if (!ROLES.has(claims.role)) throw new Error('invalid role')
  if (!Number.isInteger(claims.expiresAt) || claims.expiresAt < 0) {
    throw new Error('expiresAt must be a non-negative integer (unix seconds)')
  }
  const exp = String(claims.expiresAt)
  if (!EXP_RE.test(exp)) throw new Error('expiresAt out of range')
  const payload = [FORMAT, claims.role, exp, currentKeyVersion()].join('-')
  return `${payload}.${sign(payload)}`
}

// The only place a session cookie is defined, so expiry and maxAge cannot drift
// apart. The floor guards a token that expires between verifying and issuing.
export function issueSession(
  claims: { role: Role; expiresAt: number },
  now: number = nowSeconds(),
) {
  return {
    name: SESSION_COOKIE,
    value: signSession(claims),
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: Math.max(1, claims.expiresAt - now),
      path: '/',
    },
  } as const
}

export function verifySession(
  value: string | undefined,
  now: number = nowSeconds(),
): SessionClaims | null {
  if (!value) return null

  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!SIG_RE.test(signature)) return null

  const fields = payload.split('-')
  if (fields.length !== 4) return null
  const [format, role, exp, keyVersion] = fields
  if (format !== FORMAT) return null
  if (!ROLES.has(role)) return null
  if (!EXP_RE.test(exp)) return null

  // Equality with a validated value implies the field is well-formed.
  const expectedKeyVersion = process.env.SHARE_KEY_VERSION ?? '1'
  if (!KEY_VERSION_RE.test(expectedKeyVersion)) return null
  if (keyVersion !== expectedKeyVersion) return null

  // Signed as received, never re-serialized, so there is no canonicalization gap.
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return null

  const expiresAt = Number(exp)
  if (expiresAt <= now) return null

  return { role: role as Role, expiresAt, keyVersion }
}

// Only allow site-relative paths for `next`. Anything else falls back to
// '/' to prevent an open redirect through a crafted `?next=` value: an
// absolute URL, a protocol-relative URL (`//evil.example.com`), or a
// backslash variant (`/\evil.com`, `/\/evil.com`) that WHATWG URL parsing
// (browsers, and Node's URL) normalizes to a protocol-relative URL during
// relative resolution.
const SAFE_NEXT = /^\/(?!\/|\\)/

export function safeNext(next: string | null | undefined): string {
  if (!next || !SAFE_NEXT.test(next)) {
    return '/'
  }
  return next
}
