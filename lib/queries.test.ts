import { describe, it, expect, beforeEach } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { buildListingsQuery, type SortKey } from './queries'

async function seed(db: Client) {
  await db.execute(`CREATE TABLE listings (
    listing_id TEXT PRIMARY KEY, address TEXT, city TEXT, state TEXT, zip_code TEXT,
    price TEXT, price_numeric REAL, beds INTEGER, baths REAL, sqft INTEGER,
    lot_sqft INTEGER, parking_spaces INTEGER, year_built INTEGER, description TEXT,
    listing_url TEXT, is_pinned INTEGER
  )`)
  await db.execute(`CREATE TABLE scores (
    listing_id TEXT PRIMARY KEY, commute_score REAL, sqft_score REAL,
    condition_score REAL, outdoor_score REAL, room_count_score REAL,
    parking_score REAL, composite REAL, passes_filters INTEGER,
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

  await db.execute(
    "INSERT INTO listings VALUES ('a', '1 Main St', 'Arvada', 'CO', '80002', '$600,000', 600000, 4, 3, 2000, 7000, 2, 2000, 'desc', 'https://compass.com/a', 0)"
  )
  await db.execute(
    "INSERT INTO scores VALUES ('a', 80, 70, 90, 60, 75, 100, 79, 1, 0, 't')"
  )
  await db.execute(
    "INSERT INTO listings VALUES ('b', '2 Oak Ave', 'Broomfield', 'CO', '80020', '$500,000', 500000, 3, 2, 1500, 6500, 1, 1990, 'desc', 'https://compass.com/b', 0)"
  )
  await db.execute(
    "INSERT INTO scores VALUES ('b', 60, 50, 40, 90, 50, 90, 55, 0, 1, 't')"
  )
  await db.execute(
    "INSERT INTO visual_scores VALUES ('b', 40, 90, 0, NULL, 1, 1, 0, 'watermark seen', 0, '{}', 't')"
  )
  await db.execute(
    "INSERT INTO hosted_photos VALUES ('a', 0, 'https://blob.example.com/a-0.jpg')"
  )
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

  it('filters to only listings that pass cutoffs', async () => {
    const { sql, args } = buildListingsQuery({ onlyPasses: true })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a'])
  })

  it('filters to only staging-flagged listings', async () => {
    const { sql, args } = buildListingsQuery({ onlyStaging: true })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b'])
  })

  it('includes a thumbnail_url from the first hosted photo, or null when none exist', async () => {
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    const byId = Object.fromEntries(result.rows.map((r) => [r.listing_id, r.thumbnail_url]))
    expect(byId['a']).toBe('https://blob.example.com/a-0.jpg')
    expect(byId['b']).toBeNull()
  })
})
