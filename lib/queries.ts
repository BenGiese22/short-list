import { cacheLife, cacheTag } from 'next/cache'
import type { InValue } from '@libsql/client'
import { getDb } from './db'
import { NOT_AVAILABLE } from './status'

export type SortKey =
  | 'composite' | 'commute' | 'sqft' | 'condition' | 'outdoor' | 'room' | 'parking'
  | 'value' | 'price' | 'cost'

// A Map (rather than a plain object) so an unrecognized or prototype-polluting
// key (e.g. '__proto__', 'toString') safely misses instead of resolving to an
// inherited Object.prototype member.
const SORT_COLUMNS = new Map<Exclude<SortKey, 'value' | 'price'>, string>([
  ['composite', 's.composite'],
  ['commute', 's.commute_score'],
  ['sqft', 's.sqft_score'],
  ['condition', 's.condition_score'],
  ['outdoor', 's.outdoor_score'],
  ['room', 's.room_count_score'],
  ['parking', 's.parking_score'],
])

/** Which slice of the corpus to show. `undefined` means all of it.
 *
 *  Replaces three chips that were each near-useless: "Passes cutoffs" was two
 *  undocumented numbers matching 92 of 99; "Staging flagged" matched 46 of 99,
 *  which is a coin flip rather than a signal; and "Not yet scored" meant "no
 *  VISION score", so listings with composites of 71 and 67 appeared under it.
 *
 *  What replaces them is the question actually worth asking of a house: can we
 *  still buy it. Four of the current top thirteen are already under contract. */
export type AvailabilityFilter = 'available' | 'unavailable'

export interface ListingsFilter {
  search?: string
  sort?: SortKey
  availability?: AvailabilityFilter
}

/** Houses Ben has said no to, excluded by property rather than by listing.
 *
 *  A rejection is recorded against the property id, because Compass mints a
 *  new listing id when a house relists. The listing rows survive until the
 *  next pipeline run removes them, so without this the list keeps showing a
 *  house for up to six hours after it was rejected -- which reads as the
 *  reject button not having worked.
 */
const NOT_REJECTED = `l.listing_id NOT IN (
    SELECT p.listing_id FROM property_ids p
    JOIN rejections r ON r.property_id = p.property_id
  )`

export function buildListingsQuery(filter: ListingsFilter): { sql: string; args: InValue[] } {
  const clauses: string[] = [NOT_REJECTED]
  const args: InValue[] = []

  if (filter.search) {
    clauses.push('(l.address LIKE ? OR l.city LIKE ?)')
    args.push(`%${filter.search}%`, `%${filter.search}%`)
  }
  if (filter.availability) {
    // The same vocabulary `availability()` uses for the card badge, from one
    // definition rather than two. A TS helper and a SQL IN clause drifting
    // apart is precisely how the badge and the filter would come to disagree
    // about the same house.
    const placeholders = NOT_AVAILABLE.map(() => '?').join(', ')
    const test = filter.availability === 'unavailable' ? 'IN' : 'NOT IN'
    clauses.push(`LOWER(TRIM(COALESCE(l.localized_status, ''))) ${test} (${placeholders})`)
    args.push(...NOT_AVAILABLE)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  let orderBy: string
  if (filter.sort === 'value') {
    orderBy = "ORDER BY (CASE WHEN l.price_numeric > 0 THEN s.composite / (l.price_numeric / 100000.0) END) DESC NULLS LAST"
  } else if (filter.sort === 'price') {
    orderBy = 'ORDER BY l.price_numeric ASC NULLS LAST'
  } else if (filter.sort === 'cost') {
    // Derived, because upstream deliberately did not mirror Compass's
    // precomputed monthlySalesChargesInclTaxes. Both inputs must be non-NULL:
    // a NULL hoa_annual means UNKNOWN, not zero, so coalescing it would sort a
    // listing as cheaper than it may actually be. Listings missing either fall
    // to the end via NULLS LAST rather than sorting as free.
    //
    // This is the ONLY place a post-migration column is named in SQL, and it
    // appears only when this sort is selected -- the default query still names
    // none of them, so the list page survives an unmigrated mirror.
    orderBy =
      'ORDER BY (CASE WHEN l.tax_annual IS NOT NULL AND l.hoa_annual IS NOT NULL ' +
      'THEN (l.tax_annual + l.hoa_annual) / 12.0 END) ASC NULLS LAST'
  } else {
    // filter.sort may come from an unvalidated searchParams string (the list
    // view reads it straight off the URL), so an unrecognized value must fall
    // back to composite ordering rather than producing `ORDER BY undefined ...`
    // and crashing at db.execute().
    const column = SORT_COLUMNS.get(filter.sort as Exclude<SortKey, 'value' | 'price'>)
      ?? SORT_COLUMNS.get('composite')!
    orderBy = `ORDER BY ${column} DESC NULLS LAST`
  }

  const sql = `
    SELECT l.*, s.commute_score, s.sqft_score, s.condition_score, s.outdoor_score,
           s.room_count_score, s.parking_score, s.composite, s.passes_filters,
           s.has_incomplete_data,
           vs.garage_attached, vs.watermarked_staging_detected,
           vs.suspected_unwatermarked_staging, vs.has_layout_plan,
           vs.layout_plan_clarity_score, vs.photo_score_unavailable,
           c.medtronic_minutes,
           (SELECT hp.blob_url FROM hosted_photos hp WHERE hp.listing_id = l.listing_id
            ORDER BY hp.position LIMIT 1) AS thumbnail_url
    FROM listings l
    LEFT JOIN scores s ON s.listing_id = l.listing_id
    LEFT JOIN visual_scores vs ON vs.listing_id = l.listing_id
    LEFT JOIN commute c ON c.listing_id = l.listing_id
    ${where}
    ${orderBy}
  `
  return { sql, args }
}

export async function getListings(filter: ListingsFilter) {
  'use cache'
  cacheTag('listings')
  cacheLife('hours')

  const { sql, args } = buildListingsQuery(filter)
  const db = getDb()
  const result = await db.execute({ sql, args })
  return result.rows
}

export async function getListing(id: string) {
  'use cache'
  cacheTag('listings')
  cacheLife('hours')

  const db = getDb()
  const listing = await db.execute({
    sql: `
      SELECT l.*, s.commute_score, s.sqft_score, s.condition_score, s.outdoor_score,
             s.room_count_score, s.parking_score, s.hoa_score, s.composite, s.passes_filters,
             s.has_incomplete_data,
             vs.garage_attached, vs.watermarked_staging_detected,
             vs.suspected_unwatermarked_staging, vs.staging_notes,
             vs.has_layout_plan, vs.layout_plan_clarity_score, vs.photo_score_unavailable,
             c.denver_miles, c.denver_minutes, c.medtronic_miles, c.medtronic_minutes,
             (SELECT r.rejected_at FROM property_ids p
                JOIN rejections r ON r.property_id = p.property_id
               WHERE p.listing_id = l.listing_id) AS rejected_at
      FROM listings l
      LEFT JOIN scores s ON s.listing_id = l.listing_id
      LEFT JOIN visual_scores vs ON vs.listing_id = l.listing_id
      LEFT JOIN commute c ON c.listing_id = l.listing_id
      WHERE l.listing_id = ?
    `,
    args: [id],
  })
  if (listing.rows.length === 0) return null

  const [amenities, photos] = await Promise.all([
    db.execute({
      sql: 'SELECT amenity FROM amenities WHERE listing_id = ?',
      args: [id],
    }),
    db.execute({
      sql: 'SELECT position, blob_url FROM hosted_photos WHERE listing_id = ? ORDER BY position',
      args: [id],
    }),
  ])

  return {
    ...listing.rows[0],
    amenities: amenities.rows.map((r) => r.amenity as string),
    photos: photos.rows.map((r) => ({ position: r.position as number, url: r.blob_url as string })),
  }
}
