import { describe, expect, it } from 'vitest'
import { parseDone, parseStarted } from './markers'

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
const DONE =
  '{"exit_code": 0, "finished_at": 1788575767.3939707, "job": "canary"}'

describe('markers written by the Python runner', () => {
  it('reads a real started marker', () => {
    expect(parseStarted(Buffer.from(STARTED))).toEqual({
      started_at: 1788575764.082466,
      job: 'canary',
    })
  })

  it('reads a real done marker', () => {
    expect(parseDone(Buffer.from(DONE))).toEqual({
      exit_code: 0,
      finished_at: 1788575767.3939707,
      job: 'canary',
    })
  })

  it('ignores git_sha rather than rejecting the marker for carrying it', () => {
    // The runner records it for operators. A parser that demanded an exact
    // shape would break the moment the Python side added a field.
    expect(parseStarted(Buffer.from(STARTED))).not.toHaveProperty('git_sha')
  })
})
