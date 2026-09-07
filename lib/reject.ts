import { createClient, type Client } from '@libsql/client'

/** The client used by the one route that writes.
 *
 *  Same credential as `getDb()`, deliberately: there is one Turso token now.
 *  Three existed until 2026-09-07 — the viewer's, the pipeline's, and a
 *  write token added for this route — and all three were measured as fully
 *  read-write, DROP TABLE included, including the one whose comment said
 *  "read-only by design". Three names for one capability is worse than one
 *  honest name: it invites reasoning about a boundary that is not there.
 *
 *  The SEPARATION that survives is at the code level, and it is the half that
 *  was ever real. `getDb()` renders pages; this writes. A page cannot reach
 *  this function by accident however a future refactor rearranges things,
 *  which is the protection the token names were only pretending to give.
 */
let _writeDb: Client | null = null

export function getWriteDb(): Client {
  if (!_writeDb) {
    const authToken = process.env.TURSO_AUTH_TOKEN
    if (!authToken) throw new Error('TURSO_AUTH_TOKEN is not set')
    _writeDb = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken })
  }
  return _writeDb
}

export type RejectResult =
  | { kind: 'rejected'; address: string; propertyId: string }
  | { kind: 'unrejected'; propertyId: string }
  | { kind: 'not-found' }
  | { kind: 'no-property-id'; address: string }

/** Reject a house by one of its listing ids.
 *
 *  Recorded against the PROPERTY, never the listing. Compass keys its own
 *  notInterested on the listing id, so a relist mints a new one and the
 *  rejection is forgotten — the house returns, is re-scraped, re-photographed
 *  and re-paid for at the vision API.
 *
 *  Refuses when the property id is unresolved rather than falling back to the
 *  listing id. A rejection that cannot survive a relist is not the thing being
 *  asked for, and silently storing a weaker one would look identical until the
 *  house came back.
 *
 *  The address is stored on the row because a rejection outlives every listing
 *  of its house — by the time anyone reads it back there is nothing to join to.
 *
 *  `db` is injected so a test never needs a token or a network, the same seam
 *  the Python side uses for http_get and delete_fn.
 */
export async function rejectListing(
  listingId: string,
  db: Client = getWriteDb(),
): Promise<RejectResult> {
  const found = await db.execute({
    sql: `SELECT l.address, l.city, l.listing_url, p.property_id
          FROM listings l LEFT JOIN property_ids p ON p.listing_id = l.listing_id
          WHERE l.listing_id = ?`,
    args: [listingId],
  })
  const row = found.rows[0]
  if (!row) return { kind: 'not-found' }

  const propertyId = row.property_id as string | null
  const address = (row.address as string) ?? listingId
  if (!propertyId) return { kind: 'no-property-id', address }

  await db.execute({
    sql: `INSERT OR REPLACE INTO rejections
            (property_id, address, city, listing_url, reason, rejected_at)
          VALUES (?, ?, ?, ?,
                  COALESCE((SELECT reason FROM rejections WHERE property_id = ?), NULL),
                  ?)`,
    args: [
      propertyId, address, row.city as string | null,
      row.listing_url as string | null, propertyId,
      new Date().toISOString(),
    ],
  })
  return { kind: 'rejected', address, propertyId }
}

/** Undo a rejection. Safe for a property that was never rejected. */
export async function unrejectProperty(
  propertyId: string,
  db: Client = getWriteDb(),
): Promise<RejectResult> {
  await db.execute({
    sql: 'DELETE FROM rejections WHERE property_id = ?',
    args: [propertyId],
  })
  return { kind: 'unrejected', propertyId }
}
