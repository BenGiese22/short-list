import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signSession, verifySession, OWNER_SESSION_SECONDS } from './auth'
import {
  SHARE_DURATIONS,
  isShareDuration,
  shareOrigin,
  buildShareLink,
  resolveShareVisit,
} from './share'

const NOW = 1_760_000_000
const VERCEL_HEADERS = new Headers({
  host: 'short-list.vercel.app',
  'x-forwarded-host': 'short-list.vercel.app',
  'x-forwarded-proto': 'https',
})

describe('share', () => {
  const originalSecret = process.env.COOKIE_SECRET
  const originalKeyVersion = process.env.SHARE_KEY_VERSION
  beforeEach(() => {
    process.env.COOKIE_SECRET = 'test-secret'
    process.env.SHARE_KEY_VERSION = '1'
  })
  afterEach(() => {
    process.env.COOKIE_SECRET = originalSecret
    process.env.SHARE_KEY_VERSION = originalKeyVersion
  })

  const owner = () => signSession({ role: 'owner', expiresAt: NOW + OWNER_SESSION_SECONDS })
  const guest = (ttl = 3600) => signSession({ role: 'guest', expiresAt: NOW + ttl })

  describe('durations', () => {
    it('offers exactly 24h, 7d, and 30d', () => {
      expect(SHARE_DURATIONS).toEqual({ '24h': 86_400, '7d': 604_800, '30d': 2_592_000 })
    })
    it('isShareDuration is a strict allowlist', () => {
      expect(isShareDuration('7d')).toBe(true)
      for (const bad of ['1h', '90d', '', null, undefined, 7, '7d ', 'constructor', '__proto__']) {
        expect(isShareDuration(bad), String(bad)).toBe(false)
      }
    })
  })

  describe('shareOrigin', () => {
    it('prefers the forwarded host and proto (Vercel)', () => {
      expect(shareOrigin(VERCEL_HEADERS)).toBe('https://short-list.vercel.app')
    })
    it('falls back to host, with https for a real hostname', () => {
      expect(shareOrigin(new Headers({ host: 'example.com' }))).toBe('https://example.com')
    })
    it('falls back to http for localhost and loopback in dev', () => {
      expect(shareOrigin(new Headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
      expect(shareOrigin(new Headers({ host: '127.0.0.1:3000' }))).toBe('http://127.0.0.1:3000')
    })
    it('returns null when there is no host at all', () => {
      expect(shareOrigin(new Headers())).toBeNull()
    })
  })

  describe('buildShareLink', () => {
    it('an owner gets an absolute /s/<token> URL whose token verifies as a guest with the chosen expiry', () => {
      const result = buildShareLink({ cookie: owner(), duration: '7d', requestHeaders: VERCEL_HEADERS, now: NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.expiresAt).toBe(NOW + SHARE_DURATIONS['7d'])
      expect(result.url.startsWith('https://short-list.vercel.app/s/')).toBe(true)
      const token = result.url.slice('https://short-list.vercel.app/s/'.length)
      expect(verifySession(token, NOW)).toEqual({ role: 'guest', expiresAt: NOW + SHARE_DURATIONS['7d'], keyVersion: '1' })
    })

    it('the token needs no URL encoding', () => {
      const result = buildShareLink({ cookie: owner(), duration: '24h', requestHeaders: VERCEL_HEADERS, now: NOW })
      if (!result.ok) throw new Error('expected ok')
      expect(encodeURIComponent(result.url.split('/s/')[1])).toBe(result.url.split('/s/')[1])
    })

    it('a guest cannot mint a link (server-side gate, independent of the UI)', () => {
      const result = buildShareLink({ cookie: guest(), duration: '7d', requestHeaders: VERCEL_HEADERS, now: NOW })
      expect(result).toEqual({ ok: false, message: 'Only the passcode session can create share links.' })
    })

    it('no cookie, an expired owner cookie, or a tampered cookie cannot mint a link', () => {
      const expiredOwner = signSession({ role: 'owner', expiresAt: NOW - 1 })
      for (const cookie of [undefined, '', expiredOwner, owner() + 'x']) {
        const result = buildShareLink({ cookie, duration: '7d', requestHeaders: VERCEL_HEADERS, now: NOW })
        expect(result.ok, String(cookie)).toBe(false)
      }
    })

    it('rejects a duration outside the allowlist', () => {
      for (const duration of ['90d', '3600', '', null, undefined]) {
        const result = buildShareLink({ cookie: owner(), duration, requestHeaders: VERCEL_HEADERS, now: NOW })
        expect(result).toEqual({ ok: false, message: 'Pick a valid duration.' })
      }
    })

    it('fails clearly when the origin cannot be determined', () => {
      const result = buildShareLink({ cookie: owner(), duration: '7d', requestHeaders: new Headers(), now: NOW })
      expect(result).toEqual({ ok: false, message: 'Could not determine the site address.' })
    })
  })

  describe('resolveShareVisit', () => {
    it('a valid guest token with no existing cookie sets the cookie for its remaining life', () => {
      const token = guest(3600)
      expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW + 1000 })).toEqual({
        kind: 'set',
        value: token,
        maxAge: 2600,
      })
    })

    it('maxAge is never below 1 second for a token that is still valid', () => {
      const token = guest(1)
      expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW })).toEqual({ kind: 'set', value: token, maxAge: 1 })
    })

    it('a visitor who already holds a valid owner cookie is not downgraded', () => {
      expect(resolveShareVisit({ token: guest(), existingCookie: owner(), now: NOW })).toEqual({ kind: 'keep' })
    })

    it('a visitor holding a guest cookie gets the new link applied (may extend or shorten)', () => {
      const longer = guest(7200)
      expect(resolveShareVisit({ token: longer, existingCookie: guest(60), now: NOW })).toEqual({ kind: 'set', value: longer, maxAge: 7200 })
    })

    it('an expired or invalid existing owner cookie does not protect the visitor from a bad link', () => {
      const staleOwner = signSession({ role: 'owner', expiresAt: NOW - 1 })
      expect(resolveShareVisit({ token: 'junk', existingCookie: staleOwner, now: NOW })).toEqual({ kind: 'reject' })
    })

    it('rejects an expired token', () => {
      expect(resolveShareVisit({ token: guest(60), existingCookie: undefined, now: NOW + 60 })).toEqual({ kind: 'reject' })
    })

    it('rejects a tampered, empty, or missing token', () => {
      for (const token of [guest() + 'x', guest().replace('-guest-', '-owner-'), '', undefined]) {
        expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW }), String(token)).toEqual({ kind: 'reject' })
      }
    })

    it('rejects a token from a previous key version', () => {
      const token = guest()
      process.env.SHARE_KEY_VERSION = '2'
      expect(resolveShareVisit({ token, existingCookie: undefined, now: NOW })).toEqual({ kind: 'reject' })
    })

    it('an OWNER-role value is never accepted as a share link', () => {
      // A leaked owner cookie must not be convertible into a URL that hands
      // out owner sessions. Owner sessions are minted only by the passcode.
      expect(resolveShareVisit({ token: owner(), existingCookie: undefined, now: NOW })).toEqual({ kind: 'reject' })
    })
  })
})
