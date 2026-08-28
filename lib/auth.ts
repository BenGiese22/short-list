import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'short_list_session'
const PAYLOAD = 'authenticated'

function sign(payload: string): string {
  return createHmac('sha256', process.env.COOKIE_SECRET!).update(payload).digest('hex')
}

export function signSession(): string {
  return `${PAYLOAD}.${sign(PAYLOAD)}`
}

export function isValidSession(value: string | undefined): boolean {
  if (!value) return false
  const [payload, signature] = value.split('.')
  if (!payload || !signature || payload !== PAYLOAD) return false

  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
