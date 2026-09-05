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

/**
 * How long a sandbox may exist without a `started` marker before the reaper
 * treats it as orphaned rather than still bootstrapping.
 *
 * bootstrap.sh is budgeted at two minutes cold, so fifteen is generous
 * enough that no honest bootstrap trips it. It exists because the launcher
 * provisions the sandbox BEFORE it writes anything: if it then throws --
 * a bad store id, an SDK call that fails, a timeout -- the sandbox is left
 * running with no marker, and the "still bootstrapping" branch below used to
 * return noop for that state forever. The platform's own 3h timeout was the
 * only thing that stopped it, at roughly $0.70 of provisioned memory a go.
 *
 * Observed on the first real cloud launch, which had to be stopped by hand.
 */
export const BOOTSTRAP_BUDGET_MS = 15 * 60 * 1000

export type SandboxStatus = 'absent' | 'running' | 'stopped' | 'failed'
export type ReapAction =
  | 'noop'
  | 'collect-and-stop'
  | 'stop-hung'
  | 'stop-orphaned'
  | 'alert-failed'

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
  createdAt = null,
  maxAgeMs = MAX_RUN_AGE_MS,
  bootstrapBudgetMs = BOOTSTRAP_BUDGET_MS,
}: {
  status: SandboxStatus
  started: StartedMarker | null
  done: DoneMarker | null
  now: number
  createdAt?: number | null
  maxAgeMs?: number
  bootstrapBudgetMs?: number
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

  // Neither marker yet. Usually that means bootstrap is still going --
  // cloning and installing takes a while, and stopping here would kill every
  // run at its first reap -- so this waits out a generous budget first.
  //
  // Past the budget it is not bootstrapping, it is orphaned: the launcher
  // provisions the sandbox before it writes anything, so a launcher that
  // throws afterwards leaves exactly this state. Without the budget it
  // returned noop forever and the platform's 3h timeout was the only thing
  // that ever stopped it.
  if (createdAt !== null && now - createdAt > bootstrapBudgetMs) {
    return 'stop-orphaned'
  }
  return 'noop'
}
