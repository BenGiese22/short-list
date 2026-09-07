import { describe, it, expect, beforeEach } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { buildListingsQuery, type SortKey } from './queries'

async function seed(db: Client) {
  await db.execute(`CREATE TABLE listings (
    listing_id TEXT PRIMARY KEY, address TEXT, city TEXT, state TEXT, zip_code TEXT,
    price TEXT, price_numeric REAL, beds INTEGER, baths REAL, sqft INTEGER,
    lot_sqft INTEGER, parking_spaces INTEGER, year_built INTEGER, description TEXT,
    listing_url TEXT, is_pinned INTEGER, hoa_annual REAL,
    tax_annual REAL, sqft_above_grade INTEGER, sqft_below_grade INTEGER,
    outdoor_spaces TEXT, localized_status TEXT
  )`)
  await db.execute(`CREATE TABLE scores (
    listing_id TEXT PRIMARY KEY, commute_score REAL, sqft_score REAL,
    condition_score REAL, outdoor_score REAL, room_count_score REAL,
    parking_score REAL, hoa_score REAL, composite REAL, passes_filters INTEGER,
    has_incomplete_data INTEGER, computed_at TEXT
  )`)
  await db.execute(`CREATE TABLE visual_scores (
    listing_id TEXT PRIMARY KEY, condition_photo_score REAL, outdoor_photo_score REAL,
    has_layout_plan INTEGER, layout_plan_clarity_score REAL, garage_attached INTEGER,
    watermarked_staging_detected INTEGER, suspected_unwatermarked_staging INTEGER,
    staging_notes TEXT, photo_score_unavailable INTEGER, raw_response TEXT, computed_at TEXT
  )`)
  await db.execute(`CREATE TABLE hosted_photos (
    listing_id TEXT NOT NULL, position INTEGER NOT NULL, blob_url TEXT NOT NULL,
    PRIMARY KEY (listing_id, position)
  )`)
  await db.execute(`CREATE TABLE commute (
    listing_id TEXT PRIMARY KEY, denver_miles REAL, denver_minutes REAL,
    medtronic_miles REAL, medtronic_minutes REAL
  )`)

  await db.execute(
    "INSERT INTO listings VALUES ('a', '1 Main St', 'Arvada', 'CO', '80002', '$600,000', 600000, 4, 3, 2000, 7000, 2, 2000, 'desc', 'https://compass.com/a', 0, 0, 3160, 1404, 360, '[\"Deck\",\"Patio\"]', 'Active')"
  )
  await db.execute(
    "INSERT INTO scores VALUES ('a', 80, 70, 90, 60, 75, 100, 52.5, 79, 1, 0, 't')"
  )
  await db.execute(
    "INSERT INTO listings VALUES ('b', '2 Oak Ave', 'Broomfield', 'CO', '80020', '$500,000', 500000, 3, 2, 1500, 6500, 1, 1990, 'desc', 'https://compass.com/b', 0, NULL, NULL, NULL, NULL, NULL, 'Pending')"
  )
  await db.execute(
    "INSERT INTO scores VALUES ('b', 60, 50, 40, 90, 50, 90, 50, 55, 0, 1, 't')"
  )
  await db.execute(
    "INSERT INTO visual_scores VALUES ('b', 40, 90, 0, NULL, 1, 1, 0, 'watermark seen', 0, '{}', 't')"
  )
  await db.execute(
    "INSERT INTO hosted_photos VALUES ('a', 0, 'https://blob.example.com/a-0.jpg')"
  )
  await db.execute(
    "INSERT INTO commute VALUES ('a', 12.4, 20.063333, 15.1, 25.5)"
  )
  // 'b' intentionally has no commute row, matching a listing whose address
  // will not geocode -- the commute column must come back NULL, not throw.
}

describe('buildListingsQuery', () => {
  let db: Client

  beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await seed(db)
  })

  it('returns every listing with no filters, sorted by composite by default', async () => {
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a', 'b'])
  })

  it('filters by an address/city search substring', async () => {
    const { sql, args } = buildListingsQuery({ search: 'oak' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b'])
  })

  it('sorts by an individual sub-score', async () => {
    const { sql, args } = buildListingsQuery({ sort: 'outdoor' as SortKey })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b', 'a'])
  })

  it('falls back to composite ordering for an unrecognized sort key instead of throwing', async () => {
    const { sql, args } = buildListingsQuery({ sort: 'not-a-real-key' as SortKey })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a', 'b'])
  })

  it('falls back to composite ordering for a prototype-polluting sort key instead of throwing', async () => {
    const { sql, args } = buildListingsQuery({ sort: '__proto__' as SortKey })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a', 'b'])
  })

  it('filters to houses we can still buy', async () => {
    const { sql, args } = buildListingsQuery({ availability: 'available' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a'])
  })

  it('filters to the ones already under contract', async () => {
    const { sql, args } = buildListingsQuery({ availability: 'unavailable' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b'])
  })

  it('shows everything when no availability is asked for', async () => {
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id).sort()).toEqual(['a', 'b'])
  })

  it('does not hide a listing whose status we failed to read', async () => {
    // Hiding a house because we could not parse its status is the wrong
    // error to make -- a missing status is not evidence it has sold.
    await db.execute("UPDATE listings SET localized_status = NULL WHERE listing_id = 'b'")
    const { sql, args } = buildListingsQuery({ availability: 'available' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id).sort()).toEqual(['a', 'b'])
  })

  it('matches the status however Compass cased or padded it', async () => {
    await db.execute("UPDATE listings SET localized_status = '  PENDING ' WHERE listing_id = 'b'")
    const { sql, args } = buildListingsQuery({ availability: 'available' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a'])
  })

  it('includes a thumbnail_url from the first hosted photo, or null when none exist', async () => {
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    const byId = Object.fromEntries(result.rows.map((r) => [r.listing_id, r.thumbnail_url]))
    expect(byId['a']).toBe('https://blob.example.com/a-0.jpg')
    expect(byId['b']).toBeNull()
  })

  it('includes medtronic_minutes from the commute table, or null when no commute row exists', async () => {
    // The Medtronic (Lafayette) leg specifically. The card showed
    // denver_minutes until 2026-09-05, which is a different destination from
    // the one commute_score is built on -- so "Sort: Commute" reordered the
    // list by a number the cards never displayed.
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    const byId = Object.fromEntries(result.rows.map((r) => [r.listing_id, r.medtronic_minutes]))
    expect(byId['a']).toBeCloseTo(25.5)
    expect(byId['b']).toBeNull()
  })

  it('does not select the Denver leg for the card', async () => {
    // Still computed and stored, and still on the detail query -- but the
    // list card must not show a destination the score does not measure.
    const { sql } = buildListingsQuery({})
    expect(sql).not.toMatch(/c\.denver_minutes/)
  })
})

describe('HOA', () => {
  let db: Client

  beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await seed(db)
  })

  it('exposes hoa_annual on cards but not hoa_score, which only the detail view needs', async () => {
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    const a = result.rows.find((r) => r.listing_id === 'a')!
    expect(a.hoa_annual).toBe(0)
    // Deliberately unselected: the list view shows no HOA stat, and selecting
    // it would break the entire list page against a mirror not yet synced
    // since the HOA migration.
    expect(a.hoa_score).toBeUndefined()
  })

  it('returns a null hoa_annual for a listing whose fee was never disclosed', async () => {
    // 81 of 85 production listings are in this state -- the UI must be able to
    // tell "not disclosed" apart from a confirmed $0, and they score
    // differently upstream (50.0 neutral vs 52.5 with the no-fee bonus).
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    const b = result.rows.find((r) => r.listing_id === 'b')!
    expect(b.hoa_annual).toBeNull()
  })
})

describe('post-migration, pre-backfill mirror (new columns exist, all NULL)', () => {
  let db: Client

  beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await seed(db)
  })

  // This UI reads a Turso mirror that only changes when home-search/publish.py
  // runs, and ensure_schema() ALTERs new columns in before any backfill lands.
  // So "columns exist, every value NULL" is a real state the site serves, not a
  // hypothetical -- and no query may break in it.
  it('returns such listings with NULLs, and every sort still works', async () => {
    for (const sort of [undefined, 'composite', 'value', 'price', 'cost'] as const) {
      const { sql, args } = buildListingsQuery(sort ? { sort: sort as SortKey } : {})
      const result = await db.execute({ sql, args })
      const b = result.rows.find((r) => r.listing_id === 'b')!
      expect(b.tax_annual).toBeNull()
      expect(b.sqft_above_grade).toBeNull()
      expect(b.sqft_below_grade).toBeNull()
      expect(b.outdoor_spaces).toBeNull()
    }
  })

  it('surfaces the new columns on a populated listing without naming them in SQL', async () => {
    // buildListingsQuery selects l.* and never references these columns
    // explicitly -- which is what keeps the page alive against a mirror that
    // predates the migration entirely.
    const { sql, args } = buildListingsQuery({})
    expect(sql).not.toContain('tax_annual')
    expect(sql).not.toContain('sqft_above_grade')
    const result = await db.execute({ sql, args })
    const a = result.rows.find((r) => r.listing_id === 'a')!
    expect(a.tax_annual).toBe(3160)
    expect(a.sqft_above_grade).toBe(1404)
    expect(a.sqft_below_grade).toBe(360)
  })
})

describe('cost sort', () => {
  let db: Client

  beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await seed(db)
  })

  it('orders by derived monthly carrying cost, cheapest first', async () => {
    // 'a' has tax 3160 and hoa 0 -> 263.33/mo. 'b' has neither, so it has no
    // computable cost and must fall to the end rather than sorting as free.
    const { sql, args } = buildListingsQuery({ sort: 'cost' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a', 'b'])
  })

  it('treats an unknown HOA as unknown, not as zero', async () => {
    // The whole reason the ORDER BY guards on both columns. A listing with a
    // known tax but NULL hoa_annual must NOT sort as though its HOA were $0 --
    // that would rank it cheaper than a listing whose fee is merely disclosed.
    await db.execute(
      "INSERT INTO listings (listing_id, address, city, state, price_numeric, listing_url, tax_annual, hoa_annual) " +
        "VALUES ('c', '3 Elm', 'Arvada', 'CO', 400000, 'https://compass.com/c', 120, NULL)"
    )
    const { sql, args } = buildListingsQuery({ sort: 'cost' })
    const result = await db.execute({ sql, args })
    const ids = result.rows.map((r) => r.listing_id)
    // 'c' would be the cheapest at $10/mo if NULL were coalesced to 0; instead
    // it has no computable cost and joins 'b' at the end.
    expect(ids[0]).toBe('a')
    expect(ids.slice(1)).toContain('c')
  })

  it('never reaches SORT_COLUMNS, so the prototype-safe fallback is untouched', async () => {
    const { sql } = buildListingsQuery({ sort: 'cost' })
    expect(sql).toContain('tax_annual')
    expect(sql).not.toContain('s.composite DESC')
  })
})
