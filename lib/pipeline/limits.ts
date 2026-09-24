import type { StartedMarker } from './markers'

/**
 * How long a run may take, and how old a marker must be before it is
 * presumed dead.
 *
 * Its own module so the pure reap decision can share these with the
 * launcher without importing the launcher.
 */

/** Three hours: score_photos.py legitimately waits hours on a vision batch. */
export const SANDBOX_TIMEOUT_MS = 3 * 60 * 60 * 1000

/**
 * Slack between the platform's timeout and the point a marker is called
 * dead.
 *
 * Equal thresholds would be safe only if two clocks agreed exactly. The
 * platform times the session from when it started or resumed, before
 * bootstrap; `started_at` is stamped after bootstrap, by the VM's clock,
 * which can come back from a snapshot resume skewed. The launcher compares
 * that against the function's clock. Fifteen minutes absorbs both, and costs
 * nothing: a run this old is past the platform's limit either way.
 */
export const STALE_MARGIN_MS = 15 * 60 * 1000

/**
 * How long bootstrap may take before its launch counts as orphaned.
 *
 * bootstrap.sh is budgeted at two minutes cold (and capped at 270s by the
 * launcher), so fifteen is generous enough that no honest bootstrap trips
 * it. Applies to a sandbox with no marker at all, and to one whose `started`
 * is still bootstrap's provisional marker: run.py replaces that within
 * seconds of bootstrap ending, so one this old means the launcher died
 * between the two and nothing will ever run.
 */
export const BOOTSTRAP_BUDGET_MS = 15 * 60 * 1000

/** The age past which a `started` marker without a `done` is a dead run. */
export const RUN_STALE_AFTER_MS = SANDBOX_TIMEOUT_MS + STALE_MARGIN_MS

/**
 * Whether a `started` marker is too old to belong to a live run.
 *
 * Judged on age alone, deliberately: whatever ended the run -- a hang, a
 * crash, an outright sandbox failure, a manual stop -- the platform would
 * have stopped it by now, so the launcher need not know which.
 */
export function isRunStale(started: StartedMarker, now: number): boolean {
  const limit = started.provisional ? BOOTSTRAP_BUDGET_MS : RUN_STALE_AFTER_MS
  return now - started.started_at > limit
}
