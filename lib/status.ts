/** Compass's own market status, and what it means for whether a house is
 *  actually gettable.
 *
 *  Kept apart from every other "pending" in this app on purpose. Before this
 *  existed the word `Pending` on a card meant "no vision score" -- so the two
 *  listings whose photo scoring had failed were labelled Pending while all
 *  seven genuinely under contract showed nothing at all. The market status is
 *  the one a person reads a badge for, so it gets the word.
 */
export type Availability = 'available' | 'unavailable' | 'unknown'

/** Statuses that mean someone else is already buying it, or has. A deal can
 *  fall through, so these stay in the ranking -- de-emphasised, not hidden.
 *  Ben, 2026-09-07: "we can still see where it stacks up but we know it's not
 *  relevant to our current search." */
export const NOT_AVAILABLE = ['pending', 'closed', 'sold', 'under contract'] as const

const NOT_AVAILABLE_SET: ReadonlySet<string> = new Set(NOT_AVAILABLE)

/** Shown as-is when present. Compass writes these in title case already. */
export function statusLabel(status: unknown): string | null {
  const text = typeof status === 'string' ? status.trim() : ''
  return text ? text : null
}

export function availability(status: unknown): Availability {
  const text = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (!text) return 'unknown'
  if (NOT_AVAILABLE_SET.has(text)) return 'unavailable'
  // "Active / Backup" is accepting backup offers: still gettable, and the
  // slash form means a substring check would be wrong to treat it as closed.
  return 'available'
}

/** The list's own state, serialised for a round trip to a detail page.
 *
 *  An allowlist, not a copy of the query string. Sort, search and the filters
 *  are what make the list the list; anything else in the URL is somebody
 *  else's parameter and must not come back on the return trip.
 */
export const LIST_STATE_KEYS = ['search', 'sort', 'availability'] as const

export function listStateParams(params: Record<string, string | undefined>): string {
  const out = new URLSearchParams()
  for (const key of LIST_STATE_KEYS) {
    const value = params[key]
    if (value) out.set(key, value)
  }
  return out.toString()
}

/** The list URL to return to, given serialised list state. */
export function listHref(params: string): string {
  return params ? `/?${params}` : '/'
}
