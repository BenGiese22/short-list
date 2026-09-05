import { describe, it, expect } from 'vitest'
import { parseStarted, parseDone } from './markers'

const buf = (o: unknown) => Buffer.from(JSON.stringify(o))

describe('run markers', () => {
  it('reads a started marker', () => {
    expect(parseStarted(buf({ started_at: 1000, job: 'canary' }))).toEqual({
      started_at: 1000, job: 'canary',
    })
  })

  it('reads a done marker', () => {
    expect(parseDone(buf({ exit_code: 0, finished_at: 2000, job: 'canary' }))).toEqual({
      exit_code: 0, finished_at: 2000, job: 'canary',
    })
  })

  // The reaper runs every 10 minutes and must never throw. A half-written
  // marker -- the sandbox was killed mid-write -- is the normal case, not an
  // exceptional one.
  it.each([
    ['absent', null],
    ['empty', Buffer.from('')],
    ['truncated json', Buffer.from('{"started_at":')],
    ['not json at all', Buffer.from('<html>500</html>')],
    ['json of the wrong shape', buf({ nope: true })],
    ['json array', buf([1, 2, 3])],
  ])('returns null for a %s marker rather than throwing', (_label, input) => {
    expect(parseStarted(input as Buffer | null)).toBeNull()
    expect(parseDone(input as Buffer | null)).toBeNull()
  })
})
