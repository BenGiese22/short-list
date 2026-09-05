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
