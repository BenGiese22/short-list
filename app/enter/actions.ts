'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { OWNER_SESSION_SECONDS, issueSession, nowSeconds, safeNext } from '../../lib/auth'

export async function submitPasscode(formData: FormData) {
  const passcode = formData.get('passcode')
  const next = safeNext(formData.get('next') as string | null)

  if (passcode !== process.env.SITE_PASSCODE) {
    redirect(`/enter?error=1&next=${encodeURIComponent(next)}`)
  }

  const jar = await cookies()
  const session = issueSession({ role: 'owner', expiresAt: nowSeconds() + OWNER_SESSION_SECONDS })
  jar.set(session.name, session.value, session.options)
  redirect(next)
}
