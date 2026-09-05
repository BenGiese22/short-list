import { Sandbox } from '@vercel/sandbox'
import { get, put } from '@vercel/blob'
import { createReapHandler } from '@/lib/pipeline/reap-handler'
import { SANDBOX_NAME } from '@/lib/pipeline/run-handler'
import { requireStateStoreId } from '@/lib/pipeline/state-store'

// See the note in ../run/route.ts about `dynamic` under cacheComponents.
export const maxDuration = 60

async function getSandbox() {
  try {
    // resume: false -- looking at a stopped sandbox must not restart it and
    // start billing again, which is the opposite of this route's purpose.
    return (await Sandbox.get({ name: SANDBOX_NAME, resume: false } as never)) as never
  } catch {
    return null
  }
}

async function putState(pathname: string, content: Buffer) {
  // Throws rather than defaulting. Without the id the SDK falls back to
  // BLOB_READ_WRITE_TOKEN -- the PUBLIC photo store -- and this call would
  // publish the Compass session. The reaper's caller treats a throw here as
  // "session not collected", which costs a cold login and nothing else.
  const storeId = requireStateStoreId(process.env)
  return put(pathname, content, {
    access: 'private',
    storeId,
    allowOverwrite: true,
    contentType: 'application/json',
  } as never)
}

async function notify(title: string, message: string) {
  const topic = process.env.NTFY_TOPIC
  if (!topic) return
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high' },
      body: message,
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Notification is commentary on a run that already ended. Never let it
    // fail the reap.
  }
}

const handle = createReapHandler({ getSandbox, putState, notify, env: process.env })

export async function GET(request: Request) {
  const response = await handle(request)
  // Logged on EVERY run, not just failures. This one decides whether a
  // sandbox keeps billing, and a 200 that quietly did nothing is exactly as
  // interesting as a 500 -- it is what a wrong decision looks like. At one
  // invocation every ten minutes the volume is not worth optimising.
  const body = await response.clone().text()
  if (response.status >= 500) console.error(`[pipeline/reap] ${response.status} ${body}`)
  else console.log(`[pipeline/reap] ${response.status} ${body}`)
  return response
}
