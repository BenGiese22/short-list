#!/usr/bin/env node
/**
 * One-off: measures the real mirror and writes `fixtures/distributions.json`.
 *
 *   node scripts/seed/profile.ts
 *
 * Requires `~/code/home-search` checked out. Its OUTPUT is committed, so this
 * never runs on a clean checkout — it exists so the numbers hard-coded in
 * `generate.ts` have a dated, reproducible source rather than being folklore.
 *
 * Re-run it when the real data changes shape enough that the generated
 * profiles stop resembling production.
 */
import { createClient } from '@libsql/client'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../../fixtures/distributions.json')
const SOURCE =
  process.env.HOME_SEARCH_DB ?? '/home/bengi/code/home-search/data/listings.db'

async function main(): Promise<void> {
  const db = createClient({ url: `file:${SOURCE}` })

  const one = async (sql: string) => (await db.execute(sql)).rows[0]!

  const listings = await one(`
    SELECT COUNT(*) AS n,
           MIN(price_numeric) AS price_min, MAX(price_numeric) AS price_max,
           MIN(sqft) AS sqft_min, MAX(sqft) AS sqft_max,
           MIN(year_built) AS year_min, MAX(year_built) AS year_max,
           SUM(hoa_annual IS NULL) AS hoa_null,
           SUM(tax_annual IS NULL) AS tax_null,
           SUM(sqft_above_grade IS NULL) AS above_grade_null,
           SUM(sqft_below_grade IS NULL OR sqft_below_grade = 0) AS no_basement,
           MAX(LENGTH(address)) AS address_max_len
    FROM listings`)

  const scores = await one(`
    SELECT COUNT(*) AS n,
           MIN(composite) AS composite_min, MAX(composite) AS composite_max,
           SUM(passes_filters) AS passes, SUM(has_incomplete_data) AS incomplete
    FROM scores`)

  const visual = await one(`
    SELECT COUNT(*) AS n,
           SUM(photo_score_unavailable) AS photo_score_unavailable,
           SUM(watermarked_staging_detected) AS watermarked,
           SUM(suspected_unwatermarked_staging) AS suspected,
           SUM(has_layout_plan) AS has_layout_plan,
           SUM(garage_attached IS NULL) AS garage_unknown
    FROM visual_scores`)

  const commute = await one(`
    SELECT COUNT(*) AS n, SUM(geocode_failed) AS geocode_failed,
           SUM(denver_minutes IS NULL) AS denver_minutes_null
    FROM commute`)

  const photos = await one(`
    SELECT MIN(c) AS min, MAX(c) AS max, ROUND(AVG(c), 1) AS avg FROM (
      SELECT listing_id, COUNT(*) AS c FROM photo_urls GROUP BY listing_id)`)

  const amenities = await one(`
    SELECT MIN(c) AS min, MAX(c) AS max FROM (
      SELECT listing_id, COUNT(*) AS c FROM amenities GROUP BY listing_id)`)

  const noPhotos = await one(`
    SELECT COUNT(*) AS n FROM listings l
    WHERE NOT EXISTS (SELECT 1 FROM photo_urls p WHERE p.listing_id = l.listing_id)`)

  const profile = {
    _comment:
      'Measured from the real home-search mirror. Source of the numbers in ' +
      'scripts/seed/generate.ts. Regenerate with: node scripts/seed/profile.ts',
    measured_at: new Date().toISOString().slice(0, 10),
    source: SOURCE,
    listings: { ...listings, listings_without_photos: noPhotos.n },
    scores,
    visual_scores: visual,
    commute,
    photos_per_listing: photos,
    amenities_per_listing: amenities,
  }

  await writeFile(OUT, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  console.log(`wrote ${OUT}`)
  console.log(JSON.stringify(profile, null, 2))
  db.close()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
