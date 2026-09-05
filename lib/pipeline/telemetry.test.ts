import { describe, expect, it } from 'vitest'
import { DECISION_METRIC, decisionTags, emitDecision, outcomeOf } from './telemetry'

describe('outcomeOf', () => {
  it('carries the reaper action, which is the word that has been wrong', () => {
    // Six consecutive `collect-and-stop` where `noop` belonged is the whole
    // incident this metric exists for.
    expect(outcomeOf('reap', 200, { action: 'noop' })).toBe('noop')
    expect(outcomeOf('reap', 200, { action: 'collect-and-stop' })).toBe('collect-and-stop')
    expect(outcomeOf('reap', 200, { idle: true })).toBe('idle')
  })

  it('distinguishes a launch from a skip', () => {
    expect(outcomeOf('run', 202, { started: true })).toBe('started')
    expect(outcomeOf('run', 200, { skipped: 'in-progress' })).toBe('skipped:in-progress')
  })

  it('separates auth failure from a real error', () => {
    // 401 is a misconfigured caller; 500 is us. Grouping them would hide one
    // behind the other's baseline.
    expect(outcomeOf('reap', 401, {})).toBe('unauthorized')
    expect(outcomeOf('run', 500, { error: 'boom' })).toBe('error')
  })

  it('says unknown rather than guessing', () => {
    expect(outcomeOf('reap', 200, {})).toBe('none')
    expect(outcomeOf('run', 200, {})).toBe('unknown')
  })
})

describe('decisionTags', () => {
  it('are all strings, because tags become dimensions', () => {
    const tags = decisionTags('reap', 200, JSON.stringify({ action: 'noop', status: 'stopped' }))

    expect(tags).toEqual({
      route: 'reap',
      http_status: '200',
      outcome: 'noop',
      sandbox_status: 'stopped',
      job: 'none',
    })
    for (const v of Object.values(tags)) expect(typeof v).toBe('string')
  })

  it('survives a body that is not JSON', () => {
    // A gateway error page is still an event worth counting.
    const tags = decisionTags('run', 502, '<html>Bad Gateway</html>')
    expect(tags.outcome).toBe('error')
    expect(tags.job).toBe('none')
  })

  it('survives a JSON body that is not an object', () => {
    expect(decisionTags('reap', 200, '[1,2,3]').outcome).toBe('none')
    expect(decisionTags('reap', 200, 'null').outcome).toBe('none')
  })
})

describe('emitDecision', () => {
  it('emits one event with the decision attached', () => {
    const calls: unknown[][] = []
    emitDecision((...a) => calls.push(a), 'reap', 200, '{"action":"noop","status":"stopped"}')

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(DECISION_METRIC)
    expect(calls[0][1]).toBe(1)
    expect((calls[0][2] as Record<string, string>).outcome).toBe('noop')
  })

  it('never throws, because it describes a request already answered', () => {
    // An observability path that can break the thing it observes is worse
    // than no observability path.
    expect(() =>
      emitDecision(() => { throw new Error('metrics down') }, 'run', 202, '{}'),
    ).not.toThrow()
  })
})
