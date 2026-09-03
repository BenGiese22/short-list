import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession } from '@/lib/auth'
import { ShareControl } from './ShareControl'

// Reads the request cookie, so it must render inside a <Suspense> boundary
// (Cache Components). Renders nothing for guests -- and nothing for a page
// somehow reached without a session, which the proxy already prevents.
export async function OwnerTools() {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)
  if (session?.role !== 'owner') return null
  return <ShareControl />
}
