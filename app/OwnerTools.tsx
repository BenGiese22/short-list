import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession } from '@/lib/auth'
import { ShareControl } from './ShareControl'

// Reads the request cookie, so it must render inside a <Suspense> boundary.
export async function OwnerTools() {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)
  if (session?.role !== 'owner') return null
  return <ShareControl />
}
