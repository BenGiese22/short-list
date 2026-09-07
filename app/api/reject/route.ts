import { revalidateTag } from 'next/cache'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth'
import { rejectListing, unrejectProperty } from '@/lib/reject'

/** Reject a house, or undo a rejection.
 *
 *  **Owner only.** A share link issues a `guest` role, and a guest looking at
 *  the list must not be able to remove a house from it. `proxy.ts` already
 *  admits any valid role — "Any valid role may view" — so viewing is not the
 *  check this needs, and gating here rather than there keeps the share links
 *  working exactly as they do now.
 */
/** Expire the cached listing queries so a rejection is visible immediately.
 *
 *  `getListings` is `'use cache'` with `cacheLife('hours')`, so without this
 *  a rejected house keeps appearing until the cache ages out -- the filter
 *  would be correct and invisible, which is worse than no filter at all.
 *
 *  `{ expire: 0 }` rather than the 'max' profile, and `revalidateTag` rather
 *  than `updateTag`, for the reasons app/api/revalidate/route.ts already
 *  documents: 'max' keeps serving stale content in the background, and
 *  `updateTag` throws outside a Server Action.
 */
function revalidateListings() {
  revalidateTag('listings', { expire: 0 })
}

export async function POST(request: NextRequest) {
  const claims = verifySession(request.cookies.get(SESSION_COOKIE)?.value)
  if (!claims) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }
  if (claims.role !== 'owner') {
    return NextResponse.json({ error: 'owner only' }, { status: 403 })
  }

  let body: { listingId?: string; propertyId?: string; undo?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 })
  }

  try {
    if (body.undo) {
      if (!body.propertyId) {
        return NextResponse.json({ error: 'propertyId is required to undo' }, { status: 400 })
      }
      const undone = await unrejectProperty(body.propertyId)
      revalidateListings()
      return NextResponse.json(undone)
    }

    if (!body.listingId) {
      return NextResponse.json({ error: 'listingId is required' }, { status: 400 })
    }
    const result = await rejectListing(body.listingId)
    if (result.kind === 'not-found') {
      return NextResponse.json({ error: 'no such listing' }, { status: 404 })
    }
    if (result.kind === 'no-property-id') {
      // Deliberately a failure rather than a weaker rejection. Falling back to
      // the listing id would look identical until the house relisted.
      return NextResponse.json(
        { error: `${result.address} has no resolved property id yet, so a rejection could not survive a relist` },
        { status: 409 },
      )
    }
    revalidateListings()
    return NextResponse.json(result)
  } catch (error) {
    // Never the token, which is in the client rather than the message — but
    // this is the one route that can write, so the guard is worth stating.
    console.error('[api/reject]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'could not record the rejection' }, { status: 500 })
  }
}
