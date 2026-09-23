# The scheduled pipeline

The `home-search` pipeline runs on Vercel, not on a laptop. This app owns the
three cron routes that start it, watch it, and stop it. The pipeline itself —
scrape, score, publish — lives in `home-search` and runs inside a persistent
Vercel Sandbox named `home-search-pipeline`.

## The three crons

From `vercel.json`, all authorized by `CRON_SECRET`:

| Route | Schedule (UTC) | What it does |
| --- | --- | --- |
| `/api/pipeline/run?job=pipeline` | `0 */6 * * *` | Launch a full pipeline run. |
| `/api/pipeline/run?job=canary` | `30 3 * * *` | Launch the canary: a seconds-long run that checks the sandbox still works. |
| `/api/pipeline/reap` | `*/10 * * * *` | Stop a sandbox that finished, hung, or was orphaned. |

## Launcher — `lib/pipeline/run-handler.ts`

1. Builds the runner's environment from an allowlist (`lib/pipeline/env.ts`).
   A missing required variable fails the launch before anything is provisioned.
2. Gets or creates the sandbox from `home-search` at `PIPELINE_GIT_REVISION`
   (default `main`), with a 3h platform timeout (`SANDBOX_TIMEOUT_MS`).
3. Reads the run markers (below). If a `started` marker has no `done` beside it
   **and is younger than `RUN_STALE_AFTER_MS`** (3h15m), it returns
   `{ "skipped": "in-progress" }` and launches nothing.
4. Otherwise it runs `ops/sandbox/bootstrap.sh <revision> <job>`, which has 270s
   to finish inside the route's 300s `maxDuration`. Bootstrap first takes run.py's
   lock (`data/.run/lock`), then deletes the previous run's `done` and writes a
   provisional `started` for this job (see markers, below). Exit codes:
   - **75:** the lock is held by a live run that the markers missed. Bootstrap
     refuses before touching anything, and the launcher answers
     `{ "skipped": "locked" }`.
   - **Anything else nonzero:** a failed launch (`500`). That includes 69 (no way
     to take the lock) and 64 (a malformed job name).

   Both the lock and the provisional marker need home-search's bootstrap change
   (branch `bgiese/post-outage-fixes`) on home-search `main`. Until that ships,
   bootstrap ignores the job argument, writes no markers, and never exits 75.
5. Seeds the Compass session from Blob if the sandbox has none, and starts
   `ops/sandbox/run.py <job>` detached. Returns `202`.

A skip response's `job` is the job that was requested, and `running` names the
live run when the markers say which one it is. A skipped **pipeline** launch sends
an ntfy alert ("pipeline launch skipped"). This needs `NTFY_TOPIC` in the
function's environment.
Runs end inside the 3h timeout and the cron runs every 6h, so a scheduled pipeline
launch should never find a live run. A skipped canary stays quiet, because at 03:30
it can land inside the 00:00 run.

A `started` marker older than `RUN_STALE_AFTER_MS` counts as stale. The platform
would already have stopped that run, however it died: a hang, a crash, an outright
failure, or a manual stop. The launcher ignores the stale marker and launches.

The thresholds live in `lib/pipeline/limits.ts`:

- `SANDBOX_TIMEOUT_MS`: the 3h platform timeout.
- `STALE_MARGIN_MS`: a 15-minute margin. The platform times the session from when
  it started or resumed, before bootstrap. `started_at` is stamped after bootstrap,
  by a VM clock that a snapshot resume can skew.
- `RUN_STALE_AFTER_MS`: the two added together. The reaper uses the same value.

## Run markers — `lib/pipeline/markers.ts`

The runner has no Vercel credential and can't report in, so it writes two JSON
files into the checkout at `data/.run/`:

- `started` — `{ "started_at", "job", "git_sha" }`, written when a run begins
  (after deleting any old `done`).
- `done` — `{ "exit_code", "finished_at", "job" }`, written when it ends,
  cleanly or not.

Bootstrap writes the first `started` of a launch:
`{ "started_at", "job", "provisional": true }`. It writes it under the lock, before
any git or pip work, after deleting the previous run's `done`. run.py overwrites
it when the run begins. If bootstrap fails, its EXIT trap writes `done` with the
exit code, so the reaper collects the sandbox right away and alerts "run failed".
The parser ignores `provisional`, so the reaper treats a provisional marker as a
live run, which it is about to be.

On disk the timestamps are epoch **seconds**, from Python's `time.time()`.
`parseStarted` and `parseDone` convert them to milliseconds, unconditionally, so
that everything downstream can compare them with `Date.now()`.
`markers.contract.test.ts` pins the exact bytes a real run writes and runs them
through the reaper and launcher decisions. The two repos share no type checking,
so this test is the only thing guarding the format.

## Reaper — `lib/pipeline/reap-handler.ts`, `reap-decision.ts`

The reaper reads the sandbox's **status before touching its disk**. Any file read
auto-resumes a persistent sandbox, and an earlier bug woke and re-stopped it
144 times a day. It only reads markers when the status is `running`, then
decides:

| Decision | When | Effect |
| --- | --- | --- |
| `alert-failed` | Sandbox status is `failed` | Notify via ntfy. |
| `noop` | Not running, or a run is inside its age limit, or bootstrap is inside its budget | Nothing. |
| `collect-and-stop` | `done` exists | Save the Compass session to Blob, stop, and notify if `exit_code` ≠ 0. |
| `stop-hung` | `started` older than `MAX_RUN_AGE_MS` (= `RUN_STALE_AFTER_MS`, 3h15m), no `done` | Save the session, stop, and notify. |
| `stop-orphaned` | No markers after the bootstrap budget | Save the session, stop, and notify. |

The reaper never clears markers. A stale `started` left behind by any stop path
is handled by the launcher's age check.

## Watching it

Every decision from both routes is emitted as the custom metric
`pipeline.decision` (`lib/pipeline/telemetry.ts`). These routes fail by
returning the wrong word with an HTTP 200, so query the word:

```bash
vercel metrics pipeline.decision --filter "outcome:stop-hung"
vercel metrics pipeline.decision --filter "outcome:skipped:in-progress"
vercel metrics pipeline.decision --filter "outcome:skipped:locked"
```

A healthy day shows four `started` pipeline launches, one canary, and a
`collect-and-stop` after each run ends. `stop-hung` should be rare. A
`skipped:in-progress` or `skipped:locked` on a pipeline launch also sends an ntfy
alert. The `job` tag separates pipeline skips from canary skips.

Any resume of the stopped sandbox also shows up later as a `collect-and-stop`
with no launch before it. That includes a manual resume just to read
`data/logs/`: the reaper finds it `running` with the last run's `done` still on
disk. The 2026-09-19 13:40Z `collect-and-stop` was exactly this.

## Environment

Required by the launcher (`REQUIRED_VARS` in `lib/pipeline/env.ts`):
`COMPASS_EMAIL`, `COMPASS_PASSWORD`, `COMPASS_COLLECTION_URL`,
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`,
`REVALIDATE_SECRET`, `VERCEL_PROJECT_PRODUCTION_URL` (system-provided),
`MAPBOX_ACCESS_TOKEN`. Every job checks all of them, the canary included.

Passed through when set: `COMPASS_COLLECTION_TABS`, `ANTHROPIC_API_KEY`,
`NTFY_TOPIC`, `MAX_PHOTOS_PER_LISTING`, `RESEND_API_KEY`, `DIGEST_EMAIL_TO`,
`RESEND_FROM`, `SITE_URL`.

Routes only: `CRON_SECRET`, `NTFY_TOPIC` (alerts from both routes) and `STATE_BLOB_STORE_ID` (the private Blob store for the
Compass session), plus optional `PIPELINE_GIT_REVISION`.

Nothing else from the function's environment reaches the sandbox. That's
deliberate, because the sandbox runs Chromium against a third-party site.

## Manual recovery

- **Launches keep returning `skipped: in-progress`:** a run is live, or its
  marker is younger than 3h15m. Wait. A stale marker never needs deleting by hand.
- **Force a run now:** call the route with the cron secret:
  `curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/pipeline/run?job=pipeline"`.

## Incident: the Sep 8–19, 2026 outage

No pipeline run completed for about 10.5 days. The root cause was a unit
mismatch: `run.py` stamped markers in epoch seconds, and the reaper compared
them against `Date.now()` in milliseconds. Every marker looked about 56 years
old.

- **Sep 4:** the reaper shipped with the mismatch. Every run finished inside
  10 minutes, so it never mattered.
- **Sep 8, 18:00Z:** the first run still going at the 10-minute reap tick was
  stopped as "hung", 9m53s after launch. Its `started` marker had no `done`.
- **Sep 8–19:** the launcher had no age check, so that marker made it skip every
  run. Each skip resumed the sandbox to read the markers, and the next reap tick
  stopped it as "hung" again. The only signal was a stream of "run hung" alerts.
- **Sep 19:** #27 cleared the marker on `stop-hung` and broke the loop. #28 moved
  staleness into the launcher, but the unit bug made that check always true, so
  the launcher stopped protecting live runs. The reaper's copy of the bug stayed
  live, and it stopped the Sep 23 00:00Z run 9m53s in.
- **Fix (#29):** the markers are now converted at the parse boundary, and the real
  bytes are asserted through both decisions. A skipped pipeline launch now
  alerts, and a locked bootstrap counts as a skip. A follow-up had bootstrap write
  a provisional `started`, which closed the two reaper races below.

## Reaper races closed by the provisional marker

Two issues predated the outage fix. The provisional marker closes both, once
home-search's bootstrap change is on `main`.

- **A reap tick could land mid-bootstrap.** The reap cron (`*/10`) fires at :00
  too. The previous run's `done` used to stay on disk until run.py deleted it after
  bootstrap, so a reap in that window saw `running` plus `done`, decided
  `collect-and-stop`, and stopped the sandbox under the launch. Now bootstrap
  deletes `done` as soon as it holds the lock, a few seconds into the launch.
- **The bootstrap budget measures the wrong clock.** `stop-orphaned` compares
  against `Sandbox.createdAt`, which is when the named sandbox was first created,
  not when the current session started. For this persistent sandbox that was days
  ago, so a running session with no markers counted as "orphaned" at its first
  reap tick. A launch now always has a fresh `started`, so the reaper never
  reaches that path mid-launch.

**Still true:** a resumed sandbox running with *no* markers at all gets stopped at
the first tick. A brand-new sandbox isn't affected, because its `createdAt` is its
session start. The case that remains is a run started by hand, outside both the
launcher and bootstrap, in a checkout with no markers.
The SDK exposes no session start time that has been verified in production
(`statusUpdatedAt` and `expiresAt` are candidates), so the budget stays on
`createdAt` until one is.

The 270s bootstrap timeout covers the measured 1–2 min cold bootstrap. A cold
path that includes `playwright install-deps` hasn't been measured.
