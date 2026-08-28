import { revalidateTag } from 'next/cache'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET
  const auth = request.headers.get('authorization')
  // Reject up front when the secret is unset — without this, a missing env var
  // turns the comparison below into `auth !== 'Bearer undefined'`, which a
  // request literally sending `Authorization: Bearer undefined` would pass,
  // making an unconfigured deployment an open revalidation endpoint. The
  // response shape matches the header-mismatch case below so callers can't
  // tell which condition failed.
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // `{ expire: 0 }`, not the generally-recommended 'max' profile: 'max' is a
  // one-year stale window, so requests keep being served stale content while
  // revalidation runs in the background (see Next's revalidateTag docs). This
  // endpoint exists so a manual publish.py sync is visible immediately, and
  // `updateTag` isn't an option here — it throws when called outside a Server
  // Action (it checks workStore.page.endsWith('/route')). `{ expire: 0 }`
  // expires the tag immediately, so the next request recomputes fresh.
  revalidateTag('listings', { expire: 0 })
  return NextResponse.json({ revalidated: true })
}
