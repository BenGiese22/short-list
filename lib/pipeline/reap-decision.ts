import type { DoneMarker, StartedMarker } from './markers'

/**
 * How long a run may go without writing its done marker before the reaper
 * stops it.
 *
 * Sized above the sandbox's own 3h timeout would be pointless, and far below
 * it would kill legitimate work: score_photos.py waits on a vision batch
 * that can legitimately take hours. Three hours plus a margin means the
 * platform's own timeout is what actually fires in the worst case, and this
 * only catches a runner that died without saying so.
 */
export const MAX_RUN_AGE_MS = 3 * 60 * 60 * 1000

export type SandboxStatus = 'absent' | 'running' | 'stopped' | 'failed'
export type ReapAction = 'noop' | 'collect-and-stop' | 'stop-hung' | 'alert-failed'

/**
 * What the reaper should do, as a pure function.
 *
 * The reaper exists because the runner cannot stop itself: doing so would
 * need a Vercel credential inside the sandbox, and the only ones available
 * either expire mid-run (OIDC, 2h TTL) or are team-wide (a personal token)
 * — see the plan's §2.5.
 *
 * Stopping matters more than it looks: provisioned memory bills for the
 * whole session, not for CPU used, so a 20-minute run that idles to the 3h
 * limit wastes about $0.23. Four a day is more than the entire Pro credit.
 */
export function decideReap({
  status,
  started,
  done,
  now,
  maxAgeMs = MAX_RUN_AGE_MS,
}: {
  status: SandboxStatus
  started: StartedMarker | null
  done: DoneMarker | null
  now: number
  maxAgeMs?: number
}): ReapAction {
  // Worth knowing about whatever the markers say: the sandbox itself dying
  // is a different failure from the pipeline failing inside it.
  if (status === 'failed') return 'alert-failed'
  if (status === 'absent' || status === 'stopped') return 'noop'

  // Finished, cleanly or not. Either way the results are collected and the
  // session is stopped — a non-zero exit still has to stop billing.
  if (done) return 'collect-and-stop'

  // Started and never finished. Only past the age limit, so a legitimately
  // long run is left alone.
  if (started) {
    return now - started.started_at > maxAgeMs ? 'stop-hung' : 'noop'
  }

  // Neither marker yet: bootstrap is still going. Cloning and installing
  // takes a while, and stopping here would kill every run at its first reap.
  return 'noop'
}
