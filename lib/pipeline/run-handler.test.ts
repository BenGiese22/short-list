import { describe, it, expect, vi } from 'vitest'
import { createRunHandler } from './run-handler'

const env = {
  CRON_SECRET: 's3cret',
  COMPASS_EMAIL: 'a@b.com',
  COMPASS_PASSWORD: 'pw',
  COMPASS_COLLECTION_URL: 'https://compass.com/c/1',
  TURSO_DATABASE_URL: 'libsql://db',
  PIPELINE_TURSO_AUTH_TOKEN: 'rw',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_a_b',
  REVALIDATE_SECRET: 'rev',
  VERCEL_PROJECT_PRODUCTION_URL: 'short-list.example',
  STATE_BLOB_STORE_ID: 'store_state',
}

function fakeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    sandboxId: 'sbx_1',
    timeout: 3 * 60 * 60 * 1000,
    readFileToBuffer: vi.fn().mockResolvedValue(null),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue({ exitCode: 0, cmdId: 'c1' }),
    ...overrides,
  }
}

const req = (url = 'https://x/api/pipeline/run?job=canary', auth = 'Bearer s3cret') =>
  new Request(url, { headers: auth ? { authorization: auth } : {} })

describe('launcher route', () => {
  it('rejects an unauthenticated request', async () => {
    const handler = createRunHandler({ getOrCreate: vi.fn(), getState: vi.fn(), env })
    const res = await handler(req('https://x/api/pipeline/run', null as never))
    expect(res.status).toBe(401)
  })

  it('rejects an unknown job rather than guessing', async () => {
    const handler = createRunHandler({ getOrCreate: vi.fn(), getState: vi.fn(), env })
    const res = await handler(req('https://x/api/pipeline/run?job=rm-rf'))
    expect(res.status).toBe(400)
  })

  it('starts the runner detached and returns 202', async () => {
    const sbx = fakeSandbox()
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(sbx), getState: vi.fn().mockResolvedValue(null), env,
    })

    const res = await handler(req())

    expect(res.status).toBe(202)
    const detached = sbx.runCommand.mock.calls.find((c) => c[0]?.detached)
    expect(detached, 'the runner must be detached; the function cannot outlive a 3h pipeline').toBeTruthy()
    expect(detached![0].args).toContain('canary')
  })

  it('passes only allowlisted env to the runner', async () => {
    const sbx = fakeSandbox()
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(sbx), getState: vi.fn().mockResolvedValue(null),
      env: { ...env, UNRELATED_SECRET: 'must-not-leak' },
    })

    await handler(req())

    const passed = sbx.runCommand.mock.calls.find((c) => c[0]?.detached)![0].env
    expect(passed.UNRELATED_SECRET).toBeUndefined()
    expect(passed.CRON_SECRET).toBeUndefined()
    expect(passed.TURSO_AUTH_TOKEN).toBe('rw')
  })

  it('skips when a run is already in progress', async () => {
    // started marker present, done absent
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started')
          ? Buffer.from(JSON.stringify({ started_at: Date.now(), job: 'pipeline' }))
          : null),
    })
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(sbx), getState: vi.fn(), env,
    })

    const res = await handler(req())

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'in-progress' })
    expect(sbx.runCommand.mock.calls.find((c) => c[0]?.detached)).toBeUndefined()
  })

  it('seeds the Compass session from Blob only when the disk lacks it', async () => {
    const getState = vi.fn().mockResolvedValue(Buffer.from('{"cookies":[]}'))
    const sbx = fakeSandbox()
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(sbx), getState, env,
    })

    await handler(req())

    expect(getState).toHaveBeenCalled()
    const written = sbx.writeFiles.mock.calls[0][0][0]
    expect(written.path).toContain('compass_state.json')
    expect(written.mode, 'a session file must not be world-readable').toBe(0o600)
  })

  it('does not overwrite a session already on disk', async () => {
    // Disk wins: it is the copy src/auth.py has been re-saving, so it is
    // newer than whatever Blob holds.
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.includes('compass_state') ? Buffer.from('{"on":"disk"}') : null),
    })
    const getState = vi.fn()
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(sbx), getState, env,
    })

    await handler(req())

    expect(getState).not.toHaveBeenCalled()
    expect(sbx.writeFiles).not.toHaveBeenCalled()
  })

  it('proceeds to a cold login when Blob has no session either', async () => {
    const sbx = fakeSandbox()
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(sbx), getState: vi.fn().mockResolvedValue(null), env,
    })

    const res = await handler(req())

    expect(res.status).toBe(202)
  })

  it('returns 500 naming no secret when the sandbox cannot be created', async () => {
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockRejectedValue(new Error('boom')),
      getState: vi.fn(), env,
    })

    const res = await handler(req())
    const body = await res.text()

    expect(res.status).toBe(500)
    for (const value of Object.values(env)) expect(body).not.toContain(value)
  })

  it('reports a misconfigured environment without leaking values', async () => {
    const { PIPELINE_TURSO_AUTH_TOKEN, ...broken } = env
    const handler = createRunHandler({
      getOrCreate: vi.fn().mockResolvedValue(fakeSandbox()),
      getState: vi.fn().mockResolvedValue(null), env: broken,
    })

    const res = await handler(req())
    const body = await res.text()

    expect(res.status).toBe(500)
    expect(body).toContain('PIPELINE_TURSO_AUTH_TOKEN')
    expect(body).not.toContain('rw')
  })
})
