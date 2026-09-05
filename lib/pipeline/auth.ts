/**
 * Whether a request carries the cron secret.
 *
 * Rejects up front when the secret is unset. Without that guard, a missing
 * env var turns the comparison into `header !== 'Bearer undefined'`, which a
 * request literally sending `Authorization: Bearer undefined` would pass —
 * making an unconfigured deployment an open trigger for a pipeline that
 * spends money. Same guard, same reasoning, as app/api/revalidate/route.ts.
 */
export function isCronAuthorized(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return false
  return header === `Bearer ${secret}`
}
