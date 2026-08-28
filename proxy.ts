import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, isValidSession } from './lib/auth'

export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value
  if (isValidSession(cookie)) {
    return NextResponse.next()
  }
  const url = new URL('/enter', request.url)
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!enter|api/revalidate|_next/static|_next/image|favicon.ico).*)',
  ],
}
