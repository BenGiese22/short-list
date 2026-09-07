import { describe, it, expect } from 'vitest'
import { buildRunnerEnv, REQUIRED_VARS } from './env'

const complete = {
  COMPASS_EMAIL: 'a@b.com',
  COMPASS_PASSWORD: 'hunter2',
  COMPASS_COLLECTION_URL: 'https://compass.com/c/1',
  TURSO_DATABASE_URL: 'libsql://db',
  TURSO_AUTH_TOKEN: 'rw-token',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y',
  REVALIDATE_SECRET: 'revalidate-me',
  VERCEL_PROJECT_PRODUCTION_URL: 'short-list.example',
  MAPBOX_ACCESS_TOKEN: 'sk.routing-token',
}

describe('buildRunnerEnv', () => {
  it('is an allowlist, not a copy of the environment', () => {
    // A sandbox runs Chromium against a third-party site. Passing the whole
    // function environment would hand it every Vercel-injected secret.
    const env = buildRunnerEnv({ ...complete, SOME_OTHER_SECRET: 'nope' })
    expect(env.SOME_OTHER_SECRET).toBeUndefined()
  })

  it('passes the one Turso token through to the sandbox', () => {
    // There were three until 2026-09-07, on the stated grounds that the
    // viewer's was read-only. It never was -- measured fully read-write that
    // day, DROP TABLE included -- so the names described a boundary nobody
    // had checked. One honest token beats three that all do the same thing.
    expect(buildRunnerEnv(complete).TURSO_AUTH_TOKEN).toBe('rw-token')
  })

  it('derives SHORT_LIST_URL from the production URL', () => {
    expect(buildRunnerEnv(complete).SHORT_LIST_URL).toBe('https://short-list.example')
  })

  it('marks the run as coming from the sandbox', () => {
    // Recorded on vision batches and the pipeline lease, so an operator can
    // tell which home is holding something.
    expect(buildRunnerEnv(complete).HOME_SEARCH_HOME).toBe('sandbox')
  })

  it('unbuffers python so logs appear before the process ends', () => {
    expect(buildRunnerEnv(complete).PYTHONUNBUFFERED).toBe('1')
  })

  it('passes the digest settings through when they are set', () => {
    const env = buildRunnerEnv({
      ...complete,
      RESEND_API_KEY: 're_key',
      DIGEST_EMAIL_TO: 'ben@example.com',
      SITE_URL: 'https://short-list.bgiese.tech',
    })
    expect(env.RESEND_API_KEY).toBe('re_key')
    expect(env.DIGEST_EMAIL_TO).toBe('ben@example.com')
    expect(env.SITE_URL).toBe('https://short-list.bgiese.tech')
  })

  it('runs without the digest settings', () => {
    // Optional, not required -- the opposite call from MAPBOX_ACCESS_TOKEN.
    // Without routing the run produces wrong data; without email it produces
    // right data quietly, so it must not block a run.
    expect(() => buildRunnerEnv(complete)).not.toThrow()
    expect(buildRunnerEnv(complete).RESEND_API_KEY).toBeUndefined()
  })

  it('passes optional vars through only when set', () => {
    expect(buildRunnerEnv(complete).NTFY_TOPIC).toBeUndefined()
    expect(buildRunnerEnv({ ...complete, NTFY_TOPIC: 't' }).NTFY_TOPIC).toBe('t')
  })

  it('passes the routing token through', () => {
    // The commutes stage cannot run without it, and it is the one thing in
    // this list that is not about Compass, Turso or Blob.
    expect(buildRunnerEnv(complete).MAPBOX_ACCESS_TOKEN).toBe('sk.routing-token')
  })

  it('throws naming MAPBOX_ACCESS_TOKEN when it is absent', () => {
    // Required, not optional: a run that cannot compute commutes should not
    // start. Optional would mean discovering this three stages in, after
    // Chromium has scraped and the photos have uploaded.
    const { MAPBOX_ACCESS_TOKEN, ...partial } = complete
    expect(() => buildRunnerEnv(partial)).toThrow(/MAPBOX_ACCESS_TOKEN/)
  })

  it('never puts the routing token in the error either', () => {
    const { REVALIDATE_SECRET, ...partial } = complete
    try {
      buildRunnerEnv(partial)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain('sk.routing-token')
    }
  })

  it('throws naming every missing required var', () => {
    const { COMPASS_PASSWORD, TURSO_DATABASE_URL, ...partial } = complete
    expect(() => buildRunnerEnv(partial)).toThrow(/COMPASS_PASSWORD/)
    expect(() => buildRunnerEnv(partial)).toThrow(/TURSO_DATABASE_URL/)
  })

  it('never puts a secret value in the error', () => {
    // The error surfaces in logs and in the 500 body.
    const { COMPASS_PASSWORD, ...partial } = complete
    try {
      buildRunnerEnv(partial)
      throw new Error('should have thrown')
    } catch (e) {
      const message = (e as Error).message
      for (const value of Object.values(partial)) {
        expect(message).not.toContain(value)
      }
    }
  })

  it('treats an empty string as missing', () => {
    expect(() => buildRunnerEnv({ ...complete, COMPASS_EMAIL: '' })).toThrow(/COMPASS_EMAIL/)
  })

  it('exports what it requires, so the route can report config problems', () => {
    expect(REQUIRED_VARS).toContain('TURSO_AUTH_TOKEN')
  })
})
