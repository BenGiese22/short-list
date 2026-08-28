'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, signSession } from '../../lib/auth'

// Only allow site-relative paths for `next`. Anything else falls back to
// '/' to prevent an open redirect through a crafted `?next=` value: an
// absolute URL, a protocol-relative URL (`//evil.example.com`), or a
// backslash variant (`/\evil.com`, `/\/evil.com`) that WHATWG URL parsing
// (browsers, and Node's URL) normalizes to a protocol-relative URL during
// relative resolution.
const SAFE_NEXT = /^\/(?!\/|\\)/

export function safeNext(next: string | null | undefined): string {
  if (!next || !SAFE_NEXT.test(next)) {
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
