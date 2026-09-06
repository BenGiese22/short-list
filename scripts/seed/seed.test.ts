import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSchema, writeSeedData } from './index.ts'
import { generate, type SeedProfile } from './generate.ts'
import { buildListingsQuery, type SortKey } from '../../lib/queries.ts'

/**
 * The seed exists to make the real pages render, so the check that matters is
 * the app's own SQL against the seeded database — not the generator's output
 * shape, which generate.test.ts already covers.
 */

const ALL_SORTS: SortKey[] = [
  'composite', 'commute', 'sqft', 'condition', 'outdoor', 'room', 'parking',
  'value', 'price', 'cost',
]

const GENERATED: SeedProfile[] = ['edge-cases', 'huge', 'empty']

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'short-list-seed-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function seedTo(profile: SeedProfile): Promise<Client> {
  const db = createClient({ url: `file:${join(dir, `${profile}.db`)}` })
  await resetSchema(db)
  await writeSeedData(db, generate(profile))
  return db
}

describe.each(GENERATED)('the %s profile', (profile) => {
  let db: Client

  beforeAll(async () => {
    db = await seedTo(profile)
  })

  afterAll(() => db.close())

  it('satisfies every sort the list view accepts', async () => {
    for (const sort of ALL_SORTS) {
      const query = buildListingsQuery({ sort })
      await expect(db.execute(query)).resolves.toBeDefined()
    }
  })

  it('satisfies every filter combination', async () => {
    const filters = [
      {}, { onlyPasses: true }, { onlyStaging: true }, { onlyPending: true },
      { onlyPasses: true, onlyStaging: true, onlyPending: true },
      { search: 'Ranch' },
    ]
    for (const filter of filters) {
      await expect(db.execute(buildListingsQuery(filter))).resolves.toBeDefined()
    }
  })

  // `sort` is read straight off searchParams, so an unrecognized value must
  // fall back to composite rather than producing `ORDER BY undefined`.
  it('survives an unrecognized sort key from the URL', async () => {
    for (const sort of ['bogus', '__proto__', 'toString'] as unknown as SortKey[]) {
      await expect(db.execute(buildListingsQuery({ sort }))).resolves.toBeDefined()
    }
  })

  it('can be re-seeded over itself without duplicating rows', async () => {
    const before = (await db.execute('SELECT COUNT(*) AS n FROM listings')).rows[0]!.n
    await resetSchema(db)
    await writeSeedData(db, generate(profile))
    const after = (await db.execute('SELECT COUNT(*) AS n FROM listings')).rows[0]!.n
    expect(after).toBe(before)
  })
})

describe('the edge-cases profile in detail', () => {
  let db: Client

  beforeAll(async () => {
    db = await seedTo('edge-cases')
  })

  afterAll(() => db.close())

  // The whole point of seeding hosted_photos rather than photo_urls: the list
  // thumbnail comes from a correlated subquery against hosted_photos.
  it('gives the list view a thumbnail for every listing that has photos', async () => {
    const rows = (await db.execute(buildListingsQuery({}))).rows
    const withPhotos = rows.filter((r) => r.thumbnail_url !== null)
    expect(withPhotos.length).toBe(rows.length - 1) // the 'no photos at all' case
    for (const row of withPhotos) {
      expect(row.thumbnail_url).toBe('/dev-photos/01-front.webp')
    }
  })

  it('leaves composite null for the listing with no scores row', async () => {
    const rows = (await db.execute(buildListingsQuery({}))).rows
    expect(rows.some((r) => r.composite === null)).toBe(true)
  })

  // Both inputs NULL must sort last rather than sorting as free.
  it('sorts listings with unknown carrying cost to the end', async () => {
    const rows = (await db.execute(buildListingsQuery({ sort: 'cost' }))).rows
    const last = rows[rows.length - 1]!
    expect(last.tax_annual === null || last.hoa_annual === null).toBe(true)
  })

  it('finds a listing by a search term in its address', async () => {
    const rows = (await db.execute(buildListingsQuery({ search: 'one word address' }))).rows
    expect(rows).toHaveLength(1)
  })

  it('returns only passing listings when onlyPasses is set', async () => {
    const rows = (await db.execute(buildListingsQuery({ onlyPasses: true }))).rows
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.passes_filters).toBe(1)
  })

  // onlyPending is "no visual_scores row at all, OR scoring unavailable" --
  // both halves need a listing behind them.
  it('returns both pending shapes when onlyPending is set', async () => {
    const rows = (await db.execute(buildListingsQuery({ onlyPending: true }))).rows
    expect(rows.some((r) => r.photo_score_unavailable === 1)).toBe(true)
    expect(rows.some((r) => r.photo_score_unavailable === null)).toBe(true)
  })
})

describe('the empty profile', () => {
  it('returns no rows, so the empty state renders', async () => {
    const db = await seedTo('empty')
    const rows = (await db.execute(buildListingsQuery({}))).rows
    expect(rows).toEqual([])
    db.close()
  })
})

/**
 * The realistic profile is a committed fixture rather than generated data, so
 * these guard the artifact itself: that it is present, that the app's SQL runs
 * against it, and that the anonymizer did not leave anything real behind.
 */
describe('the realistic fixture', () => {
  let db: Client

  beforeAll(() => {
    db = createClient({ url: `file:${join(import.meta.dirname, '../../fixtures/dev-seed-realistic.db')}` })
  })

  afterAll(() => db.close())

  it('is committed and satisfies every sort', async () => {
    for (const sort of ALL_SORTS) {
      const rows = (await db.execute(buildListingsQuery({ sort }))).rows
      expect(rows.length).toBeGreaterThan(0)
    }
  })

  // 84 listings against 78 scores rows is the real gap, and it is the only
  // place this profile exercises the LEFT JOIN NULL path.
  it('preserves the real gap between listings and scored listings', async () => {
    const listings = (await db.execute('SELECT COUNT(*) AS n FROM listings')).rows[0]!.n
    const scores = (await db.execute('SELECT COUNT(*) AS n FROM scores')).rows[0]!.n
    expect(Number(listings)).toBe(84)
    expect(Number(scores)).toBe(78)
  })

  it('gives every listing a front-exterior thumbnail', async () => {
    const rows = (await db.execute(buildListingsQuery({}))).rows
    for (const row of rows) {
      expect(row.thumbnail_url).toBe('/dev-photos/01-front.webp')
    }
  })

  it('describes no real property', async () => {
    const rows = (await db.execute(
      'SELECT listing_id, listing_url, description FROM listings',
    )).rows
    for (const row of rows) {
      expect(String(row.listing_id)).toMatch(/^dev-\d{4}$/)
      expect(String(row.listing_url)).toContain('example.com')
      expect(String(row.description)).toContain('Placeholder description')
    }

    // lat/lon locate the actual house; raw_response quotes addresses back.
    const located = (await db.execute(
      'SELECT COUNT(*) AS n FROM commute WHERE lat IS NOT NULL OR lon IS NOT NULL',
    )).rows[0]!.n
    expect(Number(located)).toBe(0)

    const raw = (await db.execute(
      'SELECT COUNT(*) AS n FROM visual_scores WHERE raw_response IS NOT NULL',
    )).rows[0]!.n
    expect(Number(raw)).toBe(0)
  })
})
