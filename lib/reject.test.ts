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
    reason TEXT, rejected_at TEXT)`)
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
