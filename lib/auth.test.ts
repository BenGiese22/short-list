import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signSession, isValidSession } from './auth'

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
