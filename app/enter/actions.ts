'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  SESSION_COOKIE,
  OWNER_SESSION_SECONDS,
  signSession,
  nowSeconds,
  safeNext,
} from '../../lib/auth'

export async function submitPasscode(formData: FormData) {
  const passcode = formData.get('passcode')
  const next = safeNext(formData.get('next') as string | null)

  if (passcode !== process.env.SITE_PASSCODE) {
    redirect(`/enter?error=1&next=${encodeURIComponent(next)}`)
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, signSession({ role: 'owner', expiresAt: nowSeconds() + OWNER_SESSION_SECONDS }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: OWNER_SESSION_SECONDS,
    path: '/',
  })
  redirect(next)
}
