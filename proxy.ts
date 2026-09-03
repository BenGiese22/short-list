import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from './lib/auth'

export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value
  // Any valid role may view. Owner-only actions gate themselves in lib/share.
  if (verifySession(cookie)) {
    return NextResponse.next()
  }
  const url = new URL('/enter', request.url)
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

// api/pipeline covers both /run and /reap. It must stay a LITERAL string:
// Next reads this matcher statically and silently ignores a computed one,
// so a clever refactor here fails by redirecting the cron to /enter — which
// Vercel then reports as a successful cron run. Silent and permanent.
export const config = {
  matcher: [
    '/((?!enter(?:/|$)|api/revalidate(?:/|$)|api/pipeline(?:/|$)|_next/static|_next/image|favicon\\.ico).*)',
  ],
}
