import { describe, it, expect } from 'vitest'
import { decideReap, MAX_RUN_AGE_MS } from './reap-decision'

const now = 1_000_000_000_000

describe('decideReap', () => {
  it('does nothing when there is no sandbox', () => {
    expect(decideReap({ status: 'absent', started: null, done: null, now })).toBe('noop')
  })

  it('does nothing while a run is still going', () => {
    expect(decideReap({
      status: 'running',
      started: { started_at: now - 60_000, job: 'pipeline' },
      done: null, now,
    })).toBe('noop')
  })

  it('waits during bootstrap, before either marker exists', () => {
    // Cloning and installing takes a while; no markers yet is normal, not
    // hung. Stopping here would kill every run at its first reap.
    expect(decideReap({ status: 'running', started: null, done: null, now })).toBe('noop')
  })

  it('collects and stops a finished run', () => {
    expect(decideReap({
      status: 'running',
      started: { started_at: now - 600_000, job: 'pipeline' },
      done: { exit_code: 0, finished_at: now - 1000, job: 'pipeline' }, now,
    })).toBe('collect-and-stop')
  })

  it('collects and stops a run that finished badly, so the session ends', () => {
    // A non-zero exit still has to be collected: the session must be stopped
    // either way, or provisioned memory bills until the 3h timeout.
    expect(decideReap({
      status: 'running',
      started: { started_at: now - 600_000, job: 'pipeline' },
      done: { exit_code: 1, finished_at: now - 1000, job: 'pipeline' }, now,
    })).toBe('collect-and-stop')
  })

  it('stops a run that started and never finished', () => {
    // The expensive case. Provisioned memory bills for the whole session,
    // so a runner that died without writing `done` would otherwise idle to
    // the 3h limit -- roughly $0.23 a time, and more than the Pro credit
    // across a month of them.
    expect(decideReap({
      status: 'running',
      started: { started_at: now - MAX_RUN_AGE_MS - 1, job: 'pipeline' },
      done: null, now,
    })).toBe('stop-hung')
  })

  it('does not call a long but legitimate run hung', () => {
    // score_photos.py legitimately waits hours on a vision batch.
    expect(decideReap({
      status: 'running',
      started: { started_at: now - MAX_RUN_AGE_MS + 60_000, job: 'pipeline' },
      done: null, now,
    })).toBe('noop')
  })

  it('alerts when the sandbox itself failed', () => {
    expect(decideReap({ status: 'failed', started: null, done: null, now })).toBe('alert-failed')
  })

  it('alerts on a failed sandbox even if a done marker exists', () => {
    // The sandbox dying is worth knowing about regardless of what the
    // runner managed to write before it went.
    expect(decideReap({
      status: 'failed',
      started: { started_at: now - 1000, job: 'canary' },
      done: { exit_code: 0, finished_at: now, job: 'canary' }, now,
    })).toBe('alert-failed')
  })

  it('treats a stopped sandbox with a done marker as already collected', () => {
    expect(decideReap({
      status: 'stopped',
      started: { started_at: now - 1000, job: 'canary' },
      done: { exit_code: 0, finished_at: now, job: 'canary' }, now,
    })).toBe('noop')
  })
})

describe('a sandbox that never started a run', () => {
  const base = { status: 'running' as const, started: null, done: null }

  it('is left alone while it could still be bootstrapping', () => {
    // Stopping here would kill every run at its first reap.
    expect(
      decideReap({ ...base, now: 10 * 60_000, createdAt: 5 * 60_000 }),
    ).toBe('noop')
  })

  it('is stopped once it is past any honest bootstrap', () => {
    // The launcher provisions BEFORE it writes anything, so a launcher that
    // throws afterwards leaves exactly this state. This branch used to
    // return noop forever and the platform's 3h timeout was the only thing
    // that stopped it -- observed for real on the first cloud launch.
    expect(
      decideReap({ ...base, now: 40 * 60_000, createdAt: 5 * 60_000 }),
    ).toBe('stop-orphaned')
  })

  it('falls back to leaving it alone when the age is unknown', () => {
    // An SDK that stops reporting createdAt must not start reaping live runs.
    expect(decideReap({ ...base, now: 9e9, createdAt: null })).toBe('noop')
  })

  it('never overrides a run that has actually started', () => {
    expect(
      decideReap({
        ...base,
        started: { started_at: 9e9, job: 'pipeline' },
        now: 9e9,
        createdAt: 0,
      }),
    ).toBe('noop')
  })
})
