import { isCronAuthorized } from './auth'
import { buildRunnerEnv } from './env'
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

/** Three hours: score_photos.py legitimately waits hours on a vision batch. */
export const SANDBOX_TIMEOUT_MS = 3 * 60 * 60 * 1000

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
}: {
  getOrCreate: (params: Record<string, unknown>) => Promise<MinimalSandbox>
  getState: (pathname: string) => Promise<Buffer | null>
  env: Record<string, string | undefined>
  gitUrl?: string
}) {
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
        await sandbox.readFileToBuffer({ path: `${RUN_DIR}/started`, cwd }),
      )
      const done = parseDone(await sandbox.readFileToBuffer({ path: `${RUN_DIR}/done`, cwd }))
      if (started && !done) {
        return Response.json({ skipped: 'in-progress', job: started.job }, { status: 200 })
      }

      // Bring the checkout to the pinned revision, then bootstrap. Both are
      // idempotent and cost seconds once the snapshot is warm.
      const bootstrap = (await sandbox.runCommand({
        cmd: 'bash',
        args: ['ops/sandbox/bootstrap.sh', env.PIPELINE_GIT_REVISION ?? 'main'],
        cwd,
        timeoutMs: 10 * 60 * 1000,
      })) as { exitCode?: number | null }
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
      const onDisk = await sandbox.readFileToBuffer({ path: SESSION_PATH, cwd })
      if (!onDisk) {
        const seeded = await getState(STATE_BLOB_PATHNAME)
        if (seeded) {
          await sandbox.writeFiles([
            { path: SESSION_PATH, content: seeded, cwd, mode: 0o600 },
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
