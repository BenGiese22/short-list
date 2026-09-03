import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth'
import { resolveShareVisit } from '@/lib/share'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const visit = resolveShareVisit({
    token,
    existingCookie: request.cookies.get(SESSION_COOKIE)?.value,
  })

  const destination =
    visit.kind === 'reject' ? new URL('/enter?error=link', request.url) : new URL('/', request.url)
  const response = NextResponse.redirect(destination, 303)
  response.headers.set('Cache-Control', 'no-store')

  if (visit.kind === 'set') {
    response.cookies.set(SESSION_COOKIE, visit.value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: visit.maxAge,
      path: '/',
    })
  }
  return response
}
