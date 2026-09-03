import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'short_list_session'
export const OWNER_SESSION_SECONDS = 60 * 60 * 24 * 90

export type Role = 'owner' | 'guest'
export type SessionClaims = { role: Role; expiresAt: number; keyVersion: string }

// Wire format: `v1-<role>-<expiresAt>-<keyVersion>.<hex hmac>`.
// The four fields' charsets exclude both separators, so a field can never
// smuggle a separator in, and parsing requires exact part counts before
// anything else is looked at. Keep the regexes and the separators in sync.
const FORMAT = 'v1'
const FIELD_SEP = '-'
const SIG_SEP = '.'
const ROLES: ReadonlySet<string> = new Set<Role>(['owner', 'guest'])
const EXP_RE = /^\d{1,12}$/
const KEY_VERSION_RE = /^[A-Za-z0-9]{1,32}$/
const SIG_RE = /^[0-9a-f]{64}$/

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// Not a secret: it is a revocation epoch. Bumping it invalidates every
// outstanding token (guest links AND owner sessions). Defaults so a deploy
// without the env var set keeps working.
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
  const payload = [FORMAT, claims.role, exp, currentKeyVersion()].join(FIELD_SEP)
  return `${payload}${SIG_SEP}${sign(payload)}`
}

export function verifySession(
  value: string | undefined,
  now: number = nowSeconds(),
): SessionClaims | null {
  if (!value) return null

  const parts = value.split(SIG_SEP)
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!SIG_RE.test(signature)) return null

  const fields = payload.split(FIELD_SEP)
  if (fields.length !== 4) return null
  const [format, role, exp, keyVersion] = fields
  if (format !== FORMAT) return null
  if (!ROLES.has(role)) return null
  if (!EXP_RE.test(exp)) return null
  if (!KEY_VERSION_RE.test(keyVersion)) return null

  let expectedKeyVersion: string
  try {
    expectedKeyVersion = currentKeyVersion()
  } catch {
    return null
  }
  if (keyVersion !== expectedKeyVersion) return null

  // Sign the payload exactly as received -- never a re-serialization of the
  // parsed fields -- so there is no canonicalization gap to exploit.
  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  const expiresAt = Number(exp)
  if (expiresAt <= now) return null

  return { role: role as Role, expiresAt, keyVersion }
}

export function remainingSeconds(claims: SessionClaims, now: number = nowSeconds()): number {
  return Math.max(0, claims.expiresAt - now)
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
