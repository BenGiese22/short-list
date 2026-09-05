import { Sandbox } from '@vercel/sandbox'
import { get } from '@vercel/blob'
import { createRunHandler } from '@/lib/pipeline/run-handler'

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
  try {
    const result = await get(pathname, {
      access: 'private',
      storeId: process.env.STATE_BLOB_STORE_ID,
    })
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
  return handle(request)
}
