import { describe, it, expect } from 'vitest'
import { config } from './proxy'

/**
 * The proxy redirects every unmatched path to the /enter password gate.
 * A cron hitting a route that is not excluded gets a 302 to a login page
 * instead of running the pipeline — and Vercel's cron reports that as a
 * success, so the failure would be silent and permanent.
 */
describe('proxy matcher', () => {
  const matches = (path: string) =>
    new RegExp('^' + config.matcher[0] + '$').test(path)

  it('lets the pipeline routes through the auth gate', () => {
    expect(matches('/api/pipeline/run')).toBe(false)
    expect(matches('/api/pipeline/reap')).toBe(false)
  })

  it('still lets revalidate through', () => {
    expect(matches('/api/revalidate')).toBe(false)
  })

  it('still lets the gate itself through', () => {
    expect(matches('/enter')).toBe(false)
  })

  it('still gates the pages a person browses', () => {
    expect(matches('/')).toBe(true)
    expect(matches('/listing/123')).toBe(true)
  })

  it('does not accidentally exempt a lookalike path', () => {
    // `api/pipelines` or `/api/pipeline-admin` must NOT be exempt: the
    // exclusion is anchored on a path segment, not a prefix.
    expect(matches('/api/pipelines')).toBe(true)
    expect(matches('/api/pipeline-admin')).toBe(true)
  })

  it('is a literal, because Next ignores a computed matcher', () => {
    expect(typeof config.matcher[0]).toBe('string')
  })
})
