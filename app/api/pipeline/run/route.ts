import { metric } from '@vercel/functions'
import { Sandbox } from '@vercel/sandbox'
import { get } from '@vercel/blob'
import { emitDecision } from '@/lib/pipeline/telemetry'
import { createRunHandler } from '@/lib/pipeline/run-handler'
import { requireStateStoreId } from '@/lib/pipeline/state-store'

// The pipeline outlives any function invocation, so this starts the runner
// detached and returns. maxDuration only has to cover clone + bootstrap.
// No `export const dynamic` here: this project runs with cacheComponents,
// under which route handlers are already dynamic unless they opt into
// caching, and the segment config is rejected outright at build time.
export const maxDuration = 300

/**
 * Reads the Compass session out of the PRIVATE state store.
 *
 * Uses the SDK rather than a raw fetch so it authenticates with OIDC and
 * refreshes the token itself. That is the whole reason this read happens in
 * the function and not in the sandbox: a forwarded OIDC token has between 30
 * minutes and two hours left and nothing inside a sandbox can renew it,
 * while score_photos.py runs for hours.
 */
async function getState(pathname: string): Promise<Buffer | null> {
  // Resolved OUTSIDE the try. A missing store id must reach the handler's
  // error path and name itself, not be swallowed as "no session" -- see
  // lib/pipeline/state-store.ts for what the SDK does otherwise.
  const storeId = requireStateStoreId(process.env)
  try {
    const result = await get(pathname, { access: 'private', storeId })
    if (!result || result.statusCode !== 200) return null
    return Buffer.from(await new Response(result.stream).arrayBuffer())
  } catch {
    // A missing session is normal on a first run: the pipeline falls back to
    // a cold login. Never fail the launch over it.
    return null
  }
}

const handle = createRunHandler({
  getOrCreate: (params) => Sandbox.getOrCreate(params as never) as never,
  getState,
  env: process.env,
})

export async function GET(request: Request) {
  const response = await handle(request)
  // Same reasoning as the reaper: a cron reads no response body, so without
  // this the logs show a bare status code and the message explaining it is
  // thrown away. Skipped runs and launches are worth seeing too -- "why did
  // nothing happen tonight" is answered by the 200 that said in-progress.
  const body = await response.clone().text()
  if (response.status >= 500) console.error(`[pipeline/run] ${response.status} ${body}`)
  else console.log(`[pipeline/run] ${response.status} ${body}`)
  // The decision as a queryable dimension, not just a log line a human has
  // to read the right word out of. See lib/pipeline/telemetry.ts.
  emitDecision(metric, 'run', response.status, body)
  return response
}
