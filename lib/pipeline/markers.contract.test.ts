import { describe, expect, it } from 'vitest'
import { parseDone, parseStarted } from './markers'
import { decideReap } from './reap-decision'
import { isRunStale } from './limits'

/**
 * The only place the two languages meet.
 *
 * `ops/sandbox/run.py` in home-search writes these files; the launcher and
 * the reaper here are the only things that read them. Nothing type-checks
 * across that boundary and no integration test spans both repos, so a
 * renamed field would ship green on both sides and surface as a sandbox that
 * never appears to be running -- the launcher would start a second pipeline
 * on top of a live one.
 *
 * These are verbatim bytes from a real local canary run on 2026-09-04, not
 * fixtures written to match the parser. Python's json.dumps spacing and its
 * float repr are part of what is being asserted.
 */

const STARTED =
  '{"started_at": 1788575764.082466, "job": "canary", "git_sha": "79b93d6423fe116acc029477aa278aa787446046"}'
/** What bootstrap.sh writes under the run lock, before git or pip. */
const PROVISIONAL =
  '{"started_at": 1790208035.512, "job": "pipeline", "provisional": true}'
const DONE =
  '{"exit_code": 0, "finished_at": 1788575767.3939707, "job": "canary"}'

describe('markers written by the Python runner', () => {
  it('reads a real started marker', () => {
    const started = parseStarted(Buffer.from(STARTED))!
    expect(started.job).toBe('canary')
    expect(started.started_at).toBeCloseTo(1788575764082.466, 1)
  })

  it('reads a real done marker', () => {
    const done = parseDone(Buffer.from(DONE))!
    expect(done).toMatchObject({ exit_code: 0, job: 'canary' })
    expect(done.finished_at).toBeCloseTo(1788575767393.9707, 1)
  })

  it('ignores git_sha rather than rejecting the marker for carrying it', () => {
    // The runner records it for operators. A parser that demanded an exact
    // shape would break the moment the Python side added a field.
    expect(parseStarted(Buffer.from(STARTED))).not.toHaveProperty('git_sha')
  })
})

/**
 * The units, asserted through the decisions that consume them.
 *
 * run.py writes epoch SECONDS (`time.time()`); everything here compares
 * against `Date.now()`, epoch MILLISECONDS. Until 2026-09-23 nothing
 * converted, so every real marker looked ~56 years old: the reaper stopped
 * any run still going at its first tick as "hung" -- the Sep 8-19 outage --
 * and the launcher's in-progress guard never fired. Every other test builds
 * its markers in ms and so agreed with the bug. These use the real bytes.
 */
describe('real markers, judged at a realistic Date.now()', () => {
  const startedMs = 1788575764.082466 * 1000
  const minutesLater = (m: number) => startedMs + m * 60_000

  it('leaves a run alone ten minutes in', () => {
    expect(decideReap({
      status: 'running',
      started: parseStarted(Buffer.from(STARTED)),
      done: null,
      now: minutesLater(10),
    })).toBe('noop')
  })

  it('does not call a run stale ten minutes in', () => {
    expect(isRunStale(parseStarted(Buffer.from(STARTED))!, minutesLater(10))).toBe(false)
  })

  it('still ages a run out eventually', () => {
    expect(isRunStale(parseStarted(Buffer.from(STARTED))!, minutesLater(4 * 60))).toBe(true)
  })
})

describe('the provisional marker bootstrap writes', () => {
  const startedMs = 1790208035.512 * 1000

  it('reads as an ordinary started marker', () => {
    const started = parseStarted(Buffer.from(PROVISIONAL))!
    expect(started.job).toBe('pipeline')
    expect(started.started_at).toBeCloseTo(startedMs, 1)
  })

  it('keeps a reap tick mid-bootstrap from stopping the launch', () => {
    // bootstrap removed the previous run's `done` and wrote this; without it
    // a :00 reap saw running + that stale `done` and collected-and-stopped.
    expect(decideReap({
      status: 'running',
      started: parseStarted(Buffer.from(PROVISIONAL)),
      done: null,
      now: startedMs + 30_000,
      createdAt: startedMs - 30 * 24 * 60 * 60 * 1000, // sandbox made a month ago
    })).toBe('noop')
  })

  it('lets a failed bootstrap be collected, not wait out the age limit', () => {
    // bootstrap's EXIT trap writes `done` with its exit code on failure.
    const failed = '{"exit_code": 1, "finished_at": 1790208095.0, "job": "pipeline"}'
    expect(decideReap({
      status: 'running',
      started: parseStarted(Buffer.from(PROVISIONAL)),
      done: parseDone(Buffer.from(failed)),
      now: startedMs + 120_000,
    })).toBe('collect-and-stop')
  })
})
