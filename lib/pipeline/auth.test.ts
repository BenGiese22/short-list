import { describe, it, expect } from 'vitest'
import { isCronAuthorized } from './auth'

describe('isCronAuthorized', () => {
  it('accepts the configured secret', () => {
    expect(isCronAuthorized('Bearer s3cret', 's3cret')).toBe(true)
  })

  it('rejects a wrong secret', () => {
    expect(isCronAuthorized('Bearer wrong', 's3cret')).toBe(false)
  })

  it('rejects when the secret is unset', () => {
    // The same guard app/api/revalidate/route.ts uses, and for the same
    // reason: without it an unconfigured deployment compares against
    // 'Bearer undefined', which a request sending exactly that would pass.
    expect(isCronAuthorized('Bearer undefined', undefined)).toBe(false)
    expect(isCronAuthorized('Bearer ', '')).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(isCronAuthorized(null, 's3cret')).toBe(false)
  })
})
