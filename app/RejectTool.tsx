import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession } from '@/lib/auth'
import { RejectButton } from './RejectButton'

/** Owner gate for the reject control. Reads the request cookie, so it must
 *  render inside a <Suspense> boundary -- same constraint as OwnerTools.
 *
 *  The gate is repeated in /api/reject and that duplication is deliberate:
 *  this one decides what is shown, that one decides what is allowed, and only
 *  the second is a control.
 */
export async function RejectTool({ listingId, address }: { listingId: string; address: string }) {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)
  if (session?.role !== 'owner') return null
  return <RejectButton listingId={listingId} address={address} />
}
