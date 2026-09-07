import { describe, it, expect, beforeEach } from 'vitest'
import { createClient } from '@libsql/client'
import { rejectListing, unrejectProperty } from './reject'

// The client is injected, so no token, no network and no module mocking --
// the same seam the Python side uses for http_get and delete_fn.
async function seed() {
  const db = createClient({ url: ':memory:' })
  await db.execute(`CREATE TABLE listings (
    listing_id TEXT PRIMARY KEY, address TEXT, city TEXT, listing_url TEXT)`)
  await db.execute(`CREATE TABLE property_ids (
    listing_id TEXT PRIMARY KEY, property_id TEXT, resolved_at TEXT)`)
  await db.execute(`CREATE TABLE rejections (
    property_id TEXT PRIMARY KEY, address TEXT, city TEXT, listing_url TEXT,
    listing_ref TEXT, reason TEXT, rejected_at TEXT, compass_synced_at TEXT)`)
  await db.execute(
    "INSERT INTO listings VALUES ('L1','145 Caria Drive','Lafayette','https://x/l')")
  await db.execute(
    "INSERT INTO listings VALUES ('L2','No Property St','Arvada','https://x/l2')")
  await db.execute("INSERT INTO property_ids VALUES ('L1','1272DA','2026-09-07')")
  return db
}

let db: Awaited<ReturnType<typeof seed>>

beforeEach(async () => {
  db = await seed()
})

describe('rejectListing', () => {
  it('records the rejection against the property, not the listing', async () => {
    const result = await rejectListing('L1', db)
    expect(result).toEqual({ kind: 'rejected', address: '145 Caria Drive', propertyId: '1272DA' })

    const rows = (await db.execute('SELECT * FROM rejections')).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].property_id).toBe('1272DA')
  })

  it('stores the address, because a rejection outlives its listing', async () => {
    await rejectListing('L1', db)
    await db.execute("DELETE FROM listings WHERE listing_id = 'L1'")

    const row = (await db.execute('SELECT * FROM rejections')).rows[0]
    expect(row.address).toBe('145 Caria Drive')
    expect(row.city).toBe('Lafayette')
  })

  it('refuses when the property id is unresolved', async () => {
    // Falling back to the listing id would look identical until the house
    // relisted, at which point the rejection would have silently evaporated.
    const result = await rejectListing('L2', db)
    expect(result.kind).toBe('no-property-id')
    expect((await db.execute('SELECT * FROM rejections')).rows).toHaveLength(0)
  })

  it('reports an unknown listing rather than inventing one', async () => {
    expect((await rejectListing('nope', db)).kind).toBe('not-found')
  })

  it('captures the Compass listing id, which nothing will know later', async () => {
    // The pipeline pushes the rejection to Compass, and Compass keys its
    // notInterested on the listing. Rejecting is what removes the listing
    // from the corpus, taking property_ids with it, so this write is the
    // last moment anything knows which listing the house was.
    await rejectListing('L1', db)
    await db.execute("DELETE FROM listings WHERE listing_id = 'L1'")
    await db.execute("DELETE FROM property_ids WHERE listing_id = 'L1'")

    const row = (await db.execute('SELECT * FROM rejections')).rows[0]
    expect(row.listing_ref).toBe('L1')
  })

  it('does not claim Compass has been told', async () => {
    // This process cannot reach Compass. A non-null compass_synced_at here
    // would mean the pipeline skips the one request that actually tells it.
    await rejectListing('L1', db)
    const row = (await db.execute('SELECT * FROM rejections')).rows[0]
    expect(row.compass_synced_at).toBeNull()
  })

  it('a relisted house becomes pending for Compass again', async () => {
    // Ours survives a relist; Compass's does not, because the new listing
    // carries an id Compass has never been told about.
    await rejectListing('L1', db)
    await db.execute("UPDATE rejections SET compass_synced_at = '2026-09-07'")
    await db.execute("INSERT INTO listings VALUES ('L9','145 Caria Drive','Lafayette','https://x/l9')")
    await db.execute("INSERT INTO property_ids VALUES ('L9','1272DA','2026-09-08')")

    await rejectListing('L9', db)

    const row = (await db.execute('SELECT * FROM rejections')).rows[0]
    expect(row.listing_ref).toBe('L9')
    expect(row.compass_synced_at).toBeNull()
  })

  it('rejecting twice keeps one row and does not blank the reason', async () => {
    await rejectListing('L1', db)
    await db.execute("UPDATE rejections SET reason = 'backyard is dirt'")
    await rejectListing('L1', db)

    const rows = (await db.execute('SELECT * FROM rejections')).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('backyard is dirt')
  })
})

describe('unrejectProperty', () => {
  it('removes the rejection', async () => {
    await rejectListing('L1', db)
    await unrejectProperty('1272DA', db)
    expect((await db.execute('SELECT * FROM rejections')).rows).toHaveLength(0)
  })

  it('is safe for a property that was never rejected', async () => {
    await expect(unrejectProperty('never-seen', db)).resolves.toBeTruthy()
  })
})
