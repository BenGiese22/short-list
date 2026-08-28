'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, signSession } from '@/lib/auth'

// Only allow site-relative paths for `next`. Anything else (an absolute URL,
// or a protocol-relative URL like `//evil.example.com`) falls back to '/' to
// prevent an open redirect through a crafted `?next=` value.
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return '/'
  }
  return next
}

export async function submitPasscode(formData: FormData) {
  const passcode = formData.get('passcode')
  const next = safeNext(formData.get('next') as string | null)

  if (passcode !== process.env.SITE_PASSCODE) {
    redirect(`/enter?error=1&next=${encodeURIComponent(next)}`)
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, signSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  })
  redirect(next)
}
