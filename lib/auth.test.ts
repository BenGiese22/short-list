import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signSession, isValidSession, safeNext } from './auth'

describe('session signing', () => {
  const originalSecret = process.env.COOKIE_SECRET

  beforeEach(() => {
    process.env.COOKIE_SECRET = 'test-secret'
  })
  afterEach(() => {
    process.env.COOKIE_SECRET = originalSecret
  })

  it('a freshly signed session is valid', () => {
    const token = signSession()
    expect(isValidSession(token)).toBe(true)
  })

  it('an undefined cookie value is invalid', () => {
    expect(isValidSession(undefined)).toBe(false)
  })

  it('a tampered token is invalid', () => {
    const token = signSession()
    expect(isValidSession(token + 'x')).toBe(false)
  })

  it('a token signed with a different secret is invalid', () => {
    const token = signSession()
    process.env.COOKIE_SECRET = 'a-different-secret'
    expect(isValidSession(token)).toBe(false)
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
