import { describe, it, expect } from 'vitest'
import { safeNext } from './actions'

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
