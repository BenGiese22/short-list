import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { timingSafeEqual, createHmac } from 'node:crypto'
import {
  signSession,
  verifySession,
  issueSession,
  currentKeyVersion,
  OWNER_SESSION_SECONDS,
  safeNext,
} from './auth'

// Wrap (not replace) timingSafeEqual so a test can assert the comparison
// actually goes through it. Everything else in node:crypto is untouched.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const NOW = 1_760_000_000 // fixed "current time" in unix seconds

describe('session claims', () => {
  const originalSecret = process.env.COOKIE_SECRET
  const originalKeyVersion = process.env.SHARE_KEY_VERSION

  beforeEach(() => {
    process.env.COOKIE_SECRET = 'test-secret'
    process.env.SHARE_KEY_VERSION = '1'
    vi.mocked(timingSafeEqual).mockClear()
  })
  afterEach(() => {
    process.env.COOKIE_SECRET = originalSecret
    process.env.SHARE_KEY_VERSION = originalKeyVersion
  })

  it('an owner token round-trips its claims', () => {
    const token = signSession({ role: 'owner', expiresAt: NOW + OWNER_SESSION_SECONDS })
    expect(verifySession(token, NOW)).toEqual({
      role: 'owner',
      expiresAt: NOW + OWNER_SESSION_SECONDS,
      keyVersion: '1',
    })
  })

  it('a guest token round-trips its claims', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 3600 })
    expect(verifySession(token, NOW)).toEqual({ role: 'guest', expiresAt: NOW + 3600, keyVersion: '1' })
  })

  it('the wire format is v1-<role>-<exp>-<kv>.<64 hex chars>', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(token).toMatch(/^v1-guest-1760000060-1\.[0-9a-f]{64}$/)
  })

  it('undefined and empty values are invalid', () => {
    expect(verifySession(undefined, NOW)).toBeNull()
    expect(verifySession('', NOW)).toBeNull()
  })

  it('the pre-v1 "authenticated.<sig>" cookie is rejected (deploy logs everyone out once)', () => {
    const sig = createHmac('sha256', 'test-secret').update('authenticated').digest('hex')
    expect(verifySession(`authenticated.${sig}`, NOW)).toBeNull()
  })

  // --- expiry -------------------------------------------------------------

  it('is valid one second before expiry and invalid at expiry', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(verifySession(token, NOW + 59)).not.toBeNull()
    expect(verifySession(token, NOW + 60)).toBeNull()
    expect(verifySession(token, NOW + 61)).toBeNull()
  })

  it('issueSession derives maxAge from the claims it signs', () => {
    const session = issueSession({ role: 'guest', expiresAt: NOW + 60 }, NOW)
    expect(session.name).toBe('short_list_session')
    expect(verifySession(session.value, NOW)).toEqual({ role: 'guest', expiresAt: NOW + 60, keyVersion: '1' })
    expect(session.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 })
  })

  it('issueSession floors maxAge at 1 second when the clock has moved past the expiry', () => {
    // `now` is re-read at issue time, so a token with a second left must not
    // round down to a 0 (session-length) or negative maxAge.
    expect(issueSession({ role: 'guest', expiresAt: NOW + 1 }, NOW + 5).options.maxAge).toBe(1)
  })

  it('signSession rejects a non-integer or past-looking expiry', () => {
    expect(() => signSession({ role: 'guest', expiresAt: 1.5 })).toThrow()
    expect(() => signSession({ role: 'guest', expiresAt: -1 })).toThrow()
    expect(() => signSession({ role: 'guest', expiresAt: NaN })).toThrow()
  })

  // --- tampering ----------------------------------------------------------

  it('a tampered signature is invalid', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    const last = token.slice(-1)
    const flipped = token.slice(0, -1) + (last === '0' ? '1' : '0')
    expect(verifySession(flipped, NOW)).toBeNull()
    expect(verifySession(token + 'x', NOW)).toBeNull()
  })

  it('a tampered expiry (extended, signature kept) is invalid', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    const [payload, sig] = token.split('.')
    const [v, role, , kv] = payload.split('-')
    expect(verifySession(`${v}-${role}-${NOW + 999_999}-${kv}.${sig}`, NOW)).toBeNull()
  })

  it('a tampered role (guest promoted to owner, signature kept) is invalid', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(verifySession(token.replace('-guest-', '-owner-'), NOW)).toBeNull()
  })

  it('a token signed under a different secret is invalid', () => {
    const token = signSession({ role: 'owner', expiresAt: NOW + 60 })
    process.env.COOKIE_SECRET = 'a-different-secret'
    expect(verifySession(token, NOW)).toBeNull()
  })

  it('a signature of the wrong length is rejected without throwing', () => {
    expect(verifySession(`v1-guest-${NOW + 60}-1.abc`, NOW)).toBeNull()
  })

  // --- key version --------------------------------------------------------

  it('a token minted under key version 1 is invalid once the version is bumped to 2', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    process.env.SHARE_KEY_VERSION = '2'
    expect(verifySession(token, NOW)).toBeNull()
  })

  it('an owner token is also invalidated by a key-version bump (accepted side effect)', () => {
    const token = signSession({ role: 'owner', expiresAt: NOW + 60 })
    process.env.SHARE_KEY_VERSION = '2'
    expect(verifySession(token, NOW)).toBeNull()
  })

  it('key version defaults to "1" when the env var is unset', () => {
    delete process.env.SHARE_KEY_VERSION
    expect(currentKeyVersion()).toBe('1')
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    expect(verifySession(token, NOW)?.keyVersion).toBe('1')
  })

  // --- field injection ----------------------------------------------------

  it('signSession refuses a key version containing a separator or other junk', () => {
    for (const bad of ['1-owner', '1.x', '', 'a b', 'x'.repeat(33)]) {
      process.env.SHARE_KEY_VERSION = bad
      expect(() => signSession({ role: 'guest', expiresAt: NOW + 60 }), bad).toThrow()
    }
  })

  it('verifySession refuses a key version containing a separator even if the env matches', () => {
    // Env is corrupted the same way, so a naive "kv === env" check would pass.
    process.env.SHARE_KEY_VERSION = '1-owner'
    const payload = `v1-guest-${NOW + 60}-1-owner`
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
    expect(verifySession(`${payload}.${sig}`, NOW)).toBeNull()
  })

  it('an unknown role is refused at sign and verify time', () => {
    // @ts-expect-error -- deliberately wrong role
    expect(() => signSession({ role: 'admin', expiresAt: NOW + 60 })).toThrow()
    const payload = `v1-admin-${NOW + 60}-1`
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
    expect(verifySession(`${payload}.${sig}`, NOW)).toBeNull()
  })

  it('an unknown format version is refused', () => {
    const payload = `v2-guest-${NOW + 60}-1`
    const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
    expect(verifySession(`${payload}.${sig}`, NOW)).toBeNull()
  })

  it('extra fields or extra dots are refused even when correctly signed', () => {
    for (const payload of [
      `v1-guest-${NOW + 60}-1-extra`,
      `v1-guest-${NOW + 60}`,
      `v1-guest-${NOW + 60}-1.extra`,
    ]) {
      const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
      expect(verifySession(`${payload}.${sig}`, NOW), payload).toBeNull()
    }
  })

  it('a non-numeric or padded expiry is refused', () => {
    for (const exp of ['abc', '1e9', '', '0'.repeat(13), ' 100']) {
      const payload = `v1-guest-${exp}-1`
      const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex')
      expect(verifySession(`${payload}.${sig}`, NOW), exp).toBeNull()
    }
  })

  // --- timing safety ------------------------------------------------------

  it('compares signatures with timingSafeEqual', () => {
    const token = signSession({ role: 'guest', expiresAt: NOW + 60 })
    verifySession(token, NOW)
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it('does not reach timingSafeEqual when the shape is already wrong (no oracle on junk)', () => {
    verifySession('garbage', NOW)
    verifySession(`v1-guest-${NOW + 60}-1.abc`, NOW) // wrong length
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })
})

describe('safeNext', () => {
  it('passes through a site-relative path unchanged', () => {
    expect(safeNext('/listing/abc')).toBe('/listing/abc')
  })

  it('falls back to / for a protocol-relative URL', () => {
    expect(safeNext('//evil.com')).toBe('/')
  })

  it('falls back to / for a backslash open-redirect variant', () => {
    expect(safeNext('/\\evil.com')).toBe('/')
  })

  it('falls back to / for a slash-backslash open-redirect variant', () => {
    expect(safeNext('/\\/evil.com')).toBe('/')
  })

  it('falls back to / for an absolute URL', () => {
    expect(safeNext('https://evil.com')).toBe('/')
  })

  it('falls back to / for undefined', () => {
    expect(safeNext(undefined)).toBe('/')
  })

  it('falls back to / for an empty string', () => {
    expect(safeNext('')).toBe('/')
  })

  it('falls back to / for null', () => {
    expect(safeNext(null)).toBe('/')
  })
})
