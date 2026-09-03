'use server'

import { cookies, headers } from 'next/headers'
import { SESSION_COOKIE } from '@/lib/auth'
import { buildShareLink, type ShareLinkResult } from '@/lib/share'

export type ShareLinkState = ShareLinkResult | null

export async function createShareLink(
  _prev: ShareLinkState,
  formData: FormData,
): Promise<ShareLinkState> {
  const jar = await cookies()
  const requestHeaders = await headers()
  return buildShareLink({
    cookie: jar.get(SESSION_COOKIE)?.value,
    duration: formData.get('duration'),
    requestHeaders,
  })
}
