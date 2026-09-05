import { describe, it, expect } from 'vitest'
import { buildRunnerEnv, REQUIRED_VARS } from './env'

const complete = {
  COMPASS_EMAIL: 'a@b.com',
  COMPASS_PASSWORD: 'hunter2',
  COMPASS_COLLECTION_URL: 'https://compass.com/c/1',
  TURSO_DATABASE_URL: 'libsql://db',
  PIPELINE_TURSO_AUTH_TOKEN: 'rw-token',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y',
  REVALIDATE_SECRET: 'revalidate-me',
  VERCEL_PROJECT_PRODUCTION_URL: 'short-list.example',
}

describe('buildRunnerEnv', () => {
  it('is an allowlist, not a copy of the environment', () => {
    // A sandbox runs Chromium against a third-party site. Passing the whole
    // function environment would hand it every Vercel-injected secret.
    const env = buildRunnerEnv({ ...complete, SOME_OTHER_SECRET: 'nope' })
    expect(env.SOME_OTHER_SECRET).toBeUndefined()
  })

  it('maps the read-write Turso token onto the name the pipeline expects', () => {
    // short-list's own TURSO_AUTH_TOKEN is read-only by design; a pipeline
    // has to write. Passing the viewer's token would fail at the first upsert.
    const env = buildRunnerEnv({ ...complete, TURSO_AUTH_TOKEN: 'read-only' })
    expect(env.TURSO_AUTH_TOKEN).toBe('rw-token')
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

  it('passes optional vars through only when set', () => {
    expect(buildRunnerEnv(complete).NTFY_TOPIC).toBeUndefined()
    expect(buildRunnerEnv({ ...complete, NTFY_TOPIC: 't' }).NTFY_TOPIC).toBe('t')
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
    expect(REQUIRED_VARS).toContain('PIPELINE_TURSO_AUTH_TOKEN')
  })
})
