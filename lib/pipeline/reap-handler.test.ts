import { describe, it, expect, vi } from 'vitest'
import { createReapHandler, toEpochMs } from './reap-handler'

const env = { CRON_SECRET: 's3cret', NTFY_TOPIC: 'topic' }
const req = (auth: string | null = 'Bearer s3cret') =>
  new Request('https://x/api/pipeline/reap', { headers: auth ? { authorization: auth } : {} })

function fakeSandbox(o: Record<string, unknown> = {}) {
  return {
    status: 'running',
    readFileToBuffer: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue({}),
    ...o,
  }
}

const marker = (o: unknown) => Buffer.from(JSON.stringify(o))

describe('reaper route', () => {
  it('rejects an unauthenticated request', async () => {
    const handler = createReapHandler({ getSandbox: vi.fn(), putState: vi.fn(), notify: vi.fn(), env })
    expect((await handler(req(null))).status).toBe(401)
  })

  it('is idle when there is no sandbox', async () => {
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(null), putState: vi.fn(), notify: vi.fn(), env,
    })
    const res = await handler(req())
    expect(await res.json()).toMatchObject({ idle: true })
  })

  it('stops a finished sandbox', async () => {
    // The reason the reaper exists: provisioned memory bills for the whole
    // session, so a finished run that is not stopped wastes ~$0.23 idling
    // to its 3h timeout.
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started') ? marker({ started_at: 1, job: 'canary' })
        : path.endsWith('done') ? marker({ exit_code: 0, finished_at: 2, job: 'canary' })
        : null),
    })
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(sbx), putState: vi.fn(), notify: vi.fn(), env,
    })

    await handler(req())

    expect(sbx.stop).toHaveBeenCalled()
  })

  it('collects the refreshed Compass session before stopping', async () => {
    // Last chance: once the session is stopped the filesystem is a snapshot
    // and the refreshed cookies are only recoverable by resuming it.
    const session = Buffer.from('{"cookies":["fresh"]}')
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started') ? marker({ started_at: 1, job: 'canary' })
        : path.endsWith('done') ? marker({ exit_code: 0, finished_at: 2, job: 'canary' })
        : path.includes('compass_state') ? session
        : null),
    })
    const putState = vi.fn().mockResolvedValue(undefined)
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(sbx), putState, notify: vi.fn(), env,
    })

    await handler(req())

    expect(putState).toHaveBeenCalledWith(expect.stringContaining('compass_state'), session)
    // Order matters: collect, then stop.
    expect(putState.mock.invocationCallOrder[0]).toBeLessThan(sbx.stop.mock.invocationCallOrder[0])
  })

  it('notifies on a failed run', async () => {
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started') ? marker({ started_at: 1, job: 'pipeline' })
        : path.endsWith('done') ? marker({ exit_code: 1, finished_at: 2, job: 'pipeline' })
        : null),
    })
    const notify = vi.fn()
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(sbx), putState: vi.fn(), notify, env,
    })

    await handler(req())

    expect(notify).toHaveBeenCalled()
    expect(String(notify.mock.calls[0])).toMatch(/pipeline|exit/i)
  })

  it('does not notify on a clean run', async () => {
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started') ? marker({ started_at: 1, job: 'canary' })
        : path.endsWith('done') ? marker({ exit_code: 0, finished_at: 2, job: 'canary' })
        : null),
    })
    const notify = vi.fn()
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(sbx), putState: vi.fn(), notify, env,
    })

    await handler(req())
    expect(notify).not.toHaveBeenCalled()
  })

  it('leaves a still-running sandbox alone', async () => {
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started') ? marker({ started_at: Date.now(), job: 'pipeline' }) : null),
    })
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(sbx), putState: vi.fn(), notify: vi.fn(), env,
    })

    await handler(req())
    expect(sbx.stop).not.toHaveBeenCalled()
  })

  it('never throws when collecting the session fails', async () => {
    // The reaper's job is to stop billing. A Blob hiccup must not prevent it.
    const sbx = fakeSandbox({
      readFileToBuffer: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith('started') ? marker({ started_at: 1, job: 'canary' })
        : path.endsWith('done') ? marker({ exit_code: 0, finished_at: 2, job: 'canary' })
        : Buffer.from('session')),
    })
    const handler = createReapHandler({
      getSandbox: vi.fn().mockResolvedValue(sbx),
      putState: vi.fn().mockRejectedValue(new Error('blob down')),
      notify: vi.fn(), env,
    })

    const res = await handler(req())

    expect(res.status).toBe(200)
    expect(sbx.stop, 'billing must still be stopped').toHaveBeenCalled()
  })
})

describe('toEpochMs', () => {
  it('accepts the shapes the SDK has used', () => {
    expect(toEpochMs(new Date('2026-09-05T03:19:14Z'))).toBe(1788578354000)
    expect(toEpochMs('2026-09-05T03:19:14Z')).toBe(1788578354000)
    expect(toEpochMs(1788578354000)).toBe(1788578354000)
  })

  it('returns null for anything it cannot read', () => {
    // null makes decideReap fall back to "still bootstrapping", which is the
    // safe direction: never reap a live run because a field changed shape.
    expect(toEpochMs(undefined)).toBeNull()
    expect(toEpochMs(null)).toBeNull()
    expect(toEpochMs('not a date')).toBeNull()
    expect(toEpochMs(new Date('nonsense'))).toBeNull()
    expect(toEpochMs({})).toBeNull()
  })
})
