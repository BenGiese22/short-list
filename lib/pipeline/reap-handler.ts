import { isCronAuthorized } from './auth'
import { parseDone, parseStarted } from './markers'
import { decideReap, type SandboxStatus } from './reap-decision'
import { RUN_DIR, SESSION_PATH, STATE_BLOB_PATHNAME } from './run-handler'

/**
 * The reaper: what stops a finished sandbox, and the only thing that does.
 *
 * The runner cannot stop itself. Doing so needs a Vercel credential inside
 * the VM, and both available kinds are wrong: an OIDC token expires mid-run
 * (2h TTL, reused up to 90 minutes, against a pipeline that runs for hours),
 * and a personal access token is team-wide -- the worst possible blast
 * radius for a VM running Chromium against a third-party site.
 *
 * So a cron reaps instead. Provisioned memory bills for the whole session
 * rather than for CPU used, so a 20-minute run left to idle to its 3h limit
 * wastes about $0.23; four a day exceeds the entire Pro credit.
 */

type MinimalSandbox = {
  status?: string
  /** When the sandbox was provisioned; used to tell bootstrapping from orphaned. */
  createdAt?: number | string | Date
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>
  stop(): Promise<unknown>
}

/** The SDK has returned this as a Date, a number and an ISO string across
 * versions, so it is normalised here rather than trusted. Unparseable means
 * null, which makes decideReap fall back to "still bootstrapping" -- the
 * old, safe behaviour. */
export function toEpochMs(value: unknown): number | null {
  if (value == null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function createReapHandler({
  getSandbox,
  putState,
  notify,
  env,
  now = () => Date.now(),
}: {
  getSandbox: () => Promise<MinimalSandbox | null>
  putState: (pathname: string, content: Buffer) => Promise<unknown>
  notify: (title: string, message: string) => Promise<unknown> | unknown
  env: Record<string, string | undefined>
  now?: () => number
}) {
  return async function handle(request: Request): Promise<Response> {
    if (!isCronAuthorized(request.headers.get('authorization'), env.CRON_SECRET)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const sandbox = await getSandbox().catch(() => null)
    if (!sandbox) return Response.json({ idle: true }, { status: 200 })

    const started = parseStarted(await sandbox.readFileToBuffer({ path: `${RUN_DIR}/started` }))
    const done = parseDone(await sandbox.readFileToBuffer({ path: `${RUN_DIR}/done` }))
    const action = decideReap({
      status: (sandbox.status ?? 'running') as SandboxStatus,
      started,
      done,
      now: now(),
      createdAt: toEpochMs(sandbox.createdAt),
    })

    if (action === 'noop') {
      return Response.json({ action, running: Boolean(started && !done) }, { status: 200 })
    }

    if (action === 'alert-failed') {
      await notify('home-search: sandbox failed', 'The sandbox itself failed, not the pipeline inside it.')
      return Response.json({ action }, { status: 200 })
    }

    // Last chance to collect the refreshed Compass session: once the session
    // stops, the filesystem is a snapshot and those cookies are only
    // reachable by resuming it. src/auth.py re-saves the session on every
    // run, so this copy is the newest one that exists.
    try {
      const session = await sandbox.readFileToBuffer({ path: SESSION_PATH })
      if (session) await putState(STATE_BLOB_PATHNAME, session)
    } catch {
      // Never let this stop the stop. The reaper's job is to end billing;
      // a stale session costs a cold login, an unstopped sandbox costs money.
    }

    await sandbox.stop()

    if (action === 'stop-orphaned') {
      // Not the pipeline failing -- the launcher failing after it had already
      // provisioned. Worth a distinct message: the fix is in the route, not
      // in the run.
      await notify(
        'home-search: orphaned sandbox stopped',
        'A sandbox was provisioned but no run ever started in it. The launcher ' +
          'most likely failed after creating it; check the function logs.',
      )
    } else if (action === 'stop-hung') {
      await notify(
        'home-search: run hung',
        `A ${started?.job ?? 'pipeline'} run started but never finished; the sandbox was stopped.`,
      )
    } else if (done && done.exit_code !== 0) {
      await notify(
        'home-search: run failed',
        `The ${done.job} run exited ${done.exit_code}.`,
      )
    }

    return Response.json({ action, job: done?.job ?? started?.job ?? null }, { status: 200 })
  }
}
