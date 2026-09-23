/**
 * The two files the runner writes so the reaper can tell what happened.
 *
 * Files rather than an API call, because the runner holds no Vercel
 * credential — see the plan's §2.4. The reaper reads them off the sandbox
 * filesystem.
 *
 * Both parsers tolerate anything. The reaper runs every ten minutes and must
 * never throw: a half-written marker, from a sandbox killed mid-write, is a
 * normal case rather than an exceptional one.
 */

/**
 * Timestamps are epoch MILLISECONDS once parsed, to compare with Date.now().
 *
 * On disk they are epoch SECONDS: run.py stamps them with Python's
 * `time.time()`. The conversion happens here, at the one place the two
 * languages meet, and unconditionally -- a unit-sniffing heuristic would
 * quietly accept a writer that changed units, and silent unit drift is what
 * this fixes. Until 2026-09-23 nothing converted, and every marker read as
 * ~56 years old; see markers.contract.test.ts.
 */
export type StartedMarker = { started_at: number; job: string }
export type DoneMarker = { exit_code: number; finished_at: number; job: string }

const SECONDS_TO_MS = 1000

function parse(buf: Buffer | null): Record<string, unknown> | null {
  if (!buf || buf.length === 0) return null
  try {
    const value = JSON.parse(buf.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

export function parseStarted(buf: Buffer | null): StartedMarker | null {
  const o = parse(buf)
  if (!o || typeof o.started_at !== 'number' || typeof o.job !== 'string') return null
  return { started_at: o.started_at * SECONDS_TO_MS, job: o.job }
}

export function parseDone(buf: Buffer | null): DoneMarker | null {
  const o = parse(buf)
  if (
    !o ||
    typeof o.exit_code !== 'number' ||
    typeof o.finished_at !== 'number' ||
    typeof o.job !== 'string'
  ) {
    return null
  }
  return { exit_code: o.exit_code, finished_at: o.finished_at * SECONDS_TO_MS, job: o.job }
}
