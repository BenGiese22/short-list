import { Sandbox } from '@vercel/sandbox'
import { get, put } from '@vercel/blob'
import { createReapHandler } from '@/lib/pipeline/reap-handler'
import { SANDBOX_NAME } from '@/lib/pipeline/run-handler'

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
  return put(pathname, content, {
    access: 'private',
    storeId: process.env.STATE_BLOB_STORE_ID,
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
  return handle(request)
}
