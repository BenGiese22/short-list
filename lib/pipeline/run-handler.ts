import { isCronAuthorized } from './auth'
import { buildRunnerEnv } from './env'
import { SANDBOX_TIMEOUT_MS, isRunStale } from './limits'
import { parseDone, parseStarted } from './markers'

/**
 * The launcher, with its Sandbox and Blob clients injected so the decisions
 * are testable without a network.
 *
 * The route is thin on purpose. Everything that can be got wrong -- which
 * env reaches the VM, whether a run is already going, whether to seed the
 * session -- is decided here and unit-tested.
 */

export const SANDBOX_NAME = 'home-search-pipeline'
export const DEFAULT_GIT_URL = 'https://github.com/BenGiese22/home-search.git'
export const RUN_DIR = 'data/.run'
export const SESSION_PATH = 'data/.auth/compass_state.json'
export const STATE_BLOB_PATHNAME = 'state/compass_state.json'

/**
 * Where the git source lands inside the sandbox.
 *
 * A git-sourced sandbox clones into a subdirectory named after the repo --
 * `/vercel/home-search` -- while every command and file operation defaults to
 * `/vercel` itself. Nothing in this file worked without that: bootstrap.sh was
 * invoked at a path that did not exist, and the session was seeded into a
 * `/vercel/data` that no run would ever read.
 *
 * Derived from the URL rather than hardcoded, so pointing gitUrl at a fork or
 * a rename cannot silently reintroduce the same mismatch.
 */
export function repoDirFromGitUrl(gitUrl: string): string {
  // Strip the scheme and host (or the scp-style `git@host:` prefix), then
  // require what is left to look like `owner/repo`. Without that check a bare
  // host such as `https://github.com/` yields "github.com" -- a plausible
  // directory name that would fail far from here.
  const path = gitUrl
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?/i, '')
    .replace(/^git@[^:]+:/i, '')
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  const name = parts.length >= 2 ? parts[parts.length - 1].replace(/\.git$/, '').trim() : ''
  if (!name) throw new Error(`cannot derive a repo directory from git url: ${gitUrl}`)
  return name
}


/** The clone directory for the default source, shared with the reaper: both
 * must address the same tree or the reaper silently finds no markers. */
export const REPO_DIR = repoDirFromGitUrl(DEFAULT_GIT_URL)

/** Named so the failure is asserted rather than restated in a test. */
export const BOOTSTRAP_EXIT_HINT = 'bootstrap.sh failed'

/** Under app/api/pipeline/run's maxDuration of 300s, with room to answer. */
export const BOOTSTRAP_TIMEOUT_MS = 270 * 1000

/**
 * bootstrap.sh's exit when run.py's lock (`data/.run/lock`) is held: a run
 * is live in this checkout, so it refused before `git reset --hard`. Same
 * value as run.py's EXIT_LOCKED (EX_TEMPFAIL) in home-search. A skip, not a
 * failure.
 */
export const BOOTSTRAP_LOCKED_EXIT = 75

/**
 * A path inside the checkout, spelled out in full.
 *
 * The file APIs take a `cwd` in their type signature and IGNORE it. Verified
 * the hard way: a launch that passed `cwd` to writeFiles put the Compass
 * session at /vercel/data/.auth/compass_state.json (3336 bytes, the Blob
 * copy) while the checkout is /vercel/home-search -- so the run found no
 * session and logged in cold, and the reaper read markers from a tree that
 * has none and concluded no run had ever started.
 *
 * runCommand's cwd does work, and is still used for commands. For files,
 * only an explicit path can be trusted.
 */
export function repoPath(relative: string): string {
  return `${REPO_DIR}/${relative}`
}

export { SANDBOX_TIMEOUT_MS }

const JOBS = new Set(['pipeline', 'canary'])

type MinimalSandbox = {
  sandboxId?: string
  timeout?: number
  readFileToBuffer(file: { path: string; cwd?: string }): Promise<Buffer | null>
  writeFiles(
    files: { path: string; content: string | Uint8Array; cwd?: string; mode?: number }[],
  ): Promise<void>
  runCommand(params: Record<string, unknown>): Promise<{ exitCode?: number | null } | unknown>
}

export function createRunHandler({
  getOrCreate,
  getState,
  env,
  gitUrl = DEFAULT_GIT_URL,
  now = () => Date.now(),
  notify = () => {},
}: {
  getOrCreate: (params: Record<string, unknown>) => Promise<MinimalSandbox>
  getState: (pathname: string) => Promise<Buffer | null>
  env: Record<string, string | undefined>
  gitUrl?: string
  now?: () => number
  notify?: (title: string, message: string) => Promise<unknown> | unknown
}) {
  /**
   * Answer a launch that found another run live.
   *
   * A scheduled pipeline launch never legitimately finds one: runs end
   * inside the 3h timeout and the cron is every 6h. The Sep 8-19 outage was
   * ten days of exactly this, visible only in a 200 body nobody reads. The
   * canary is exempt -- at 03:30 it can land inside the 00:00 run.
   */
  async function skip(
    job: string,
    reason: 'in-progress' | 'locked',
    detail: string,
    running?: string,
  ): Promise<Response> {
    if (job === 'pipeline') {
      try {
        await notify(
          'home-search: pipeline launch skipped',
          `${detail}, so this scheduled pipeline run did not start.`,
        )
      } catch {
        // Never let the alert turn a skip into a failure.
      }
    }
    // `job` is the job that was ASKED for, as on a launch, so the metric's
    // job tag separates a skipped pipeline from a skipped canary; `running`
    // names the run in the way when the markers say which it is.
    return Response.json({ skipped: reason, job, ...(running && { running }) }, { status: 200 })
  }

  return async function handle(request: Request): Promise<Response> {
    if (!isCronAuthorized(request.headers.get('authorization'), env.CRON_SECRET)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const job = new URL(request.url).searchParams.get('job') ?? 'pipeline'
    if (!JOBS.has(job)) {
      // Never pass an unrecognised value through to a shell argument.
      return Response.json({ error: 'unknown job' }, { status: 400 })
    }

    try {
      // Built before the sandbox so a misconfigured deployment fails without
      // provisioning anything. The message names variables, never values.
      const runnerEnv = buildRunnerEnv(env)
      const cwd = repoDirFromGitUrl(gitUrl)

      const sandbox = await getOrCreate({
        name: SANDBOX_NAME,
        source: {
          type: 'git',
          url: gitUrl,
          revision: env.PIPELINE_GIT_REVISION ?? 'main',
          depth: 1,
        },
        resources: { vcpus: 2 },
        timeout: SANDBOX_TIMEOUT_MS,
        keepLastSnapshots: { count: 1 },
        tags: { app: 'home-search' },
      })

      // Already running? The markers are on the sandbox's own disk because
      // the runner holds no Vercel credential and cannot report in.
      const started = parseStarted(
        await sandbox.readFileToBuffer({ path: repoPath(`${RUN_DIR}/started`) }),
      )
      const done = parseDone(
        await sandbox.readFileToBuffer({ path: repoPath(`${RUN_DIR}/done`) }),
      )
      // A `started` marker older than the sandbox's own platform timeout
      // cannot still be an in-progress run -- the platform would have force-
      // stopped it by now, whatever killed it (hang, crash, outright
      // failure, manual stop). Treating it as stale here, rather than relying
      // on the reaper to have cleared it, covers every way the previous run
      // could have died without a `done` marker, not just the ones the
      // reaper's own status classification happens to catch.
      if (started && !done && !isRunStale(started, now())) {
        const ageMin = Math.round((now() - started.started_at) / 60_000)
        return skip(
          job,
          'in-progress',
          `A ${started.job} run started ${ageMin} min ago is still in progress`,
          started.job,
        )
      }

      // Bring the checkout to the pinned revision, then bootstrap. Both are
      // idempotent and cost seconds once the snapshot is warm.
      const bootstrap = (await sandbox.runCommand({
        cmd: 'bash',
        args: ['ops/sandbox/bootstrap.sh', env.PIPELINE_GIT_REVISION ?? 'main'],
        cwd,
        // Inside the route's maxDuration (300s), so a hung bootstrap ends
        // as a 500 with a metric rather than a killed function with none.
        timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      })) as { exitCode?: number | null }
      // The markers said no run was live, but the lock says one is -- a
      // run whose marker was lost, or one started outside this launcher.
      // bootstrap refused before touching the checkout, which is all this
      // protects: the reaper cannot see the lock, and a running sandbox with
      // no markers is one it stops as orphaned. See docs/PIPELINE.md.
      if (bootstrap?.exitCode === BOOTSTRAP_LOCKED_EXIT) {
        // Which job holds the lock is not known from here.
        return skip(job, 'locked', 'bootstrap found the run lock held')
      }
      // Checked, because an unchecked failure here does not stay quiet -- it
      // resurfaces one step later as `fork/exec venv/bin/python: no such file
      // or directory`, which says nothing about the pip install that actually
      // broke. Fail where the failure is.
      if (bootstrap?.exitCode !== 0) {
        throw new Error(
          `${BOOTSTRAP_EXIT_HINT} (exit ${bootstrap?.exitCode ?? 'unknown'}); ` +
            `see the sandbox command logs`,
        )
      }

      // Seed the Compass session only when the sandbox has none. Disk wins:
      // src/auth.py re-saves it every run, so the sandbox copy is newer than
      // whatever Blob holds. A cold login works if neither exists -- it is
      // just the thing the warm-session design exists to keep rare.
      const onDisk = await sandbox.readFileToBuffer({ path: repoPath(SESSION_PATH) })
      if (!onDisk) {
        const seeded = await getState(STATE_BLOB_PATHNAME)
        if (seeded) {
          await sandbox.writeFiles([
            { path: repoPath(SESSION_PATH), content: seeded, mode: 0o600 },
          ])
        }
      }

      // Detached: a pipeline run outlives any function invocation, so the
      // launcher starts it and returns rather than waiting.
      await sandbox.runCommand({
        cmd: 'venv/bin/python',
        args: ['ops/sandbox/run.py', job],
        cwd,
        env: runnerEnv,
        detached: true,
        timeoutMs: SANDBOX_TIMEOUT_MS,
      })

      return Response.json(
        { started: true, job, sandboxId: sandbox.sandboxId, timeout: sandbox.timeout },
        { status: 202 },
      )
    } catch (error) {
      // buildRunnerEnv's message names missing variables and never values,
      // and nothing else here interpolates a secret.
      const message = error instanceof Error ? error.message : 'unknown error'
      return Response.json({ error: message }, { status: 500 })
    }
  }
}
