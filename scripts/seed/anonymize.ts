#!/usr/bin/env node
/**
 * One-off: builds `fixtures/dev-seed-realistic.db` from the real pipeline data.
 *
 *   node scripts/seed/anonymize.ts
 *
 * Requires `~/code/home-search` checked out. Its OUTPUT is committed, so a
 * clean checkout never runs it.
 *
 * What is preserved and what is destroyed, and why:
 *
 *   KEPT — every score, commute duration, and visual flag, exactly as computed.
 *   These are the reason the fixture is worth having: they carry the real
 *   spread, the real NULL pattern, and the real 84-vs-78 gap between listings
 *   and score rows. None of them identifies a property.
 *
 *   DESTROYED — anything that points at a real house: listing ids (Compass's
 *   own), street addresses, exact prices, descriptions, listing URLs, lat/lon,
 *   and the raw vision-model responses (which quote addresses back). City and
 *   ZIP survive, because four Front Range towns identify nothing and the list
 *   view groups by them.
 *
 * The result is a database that behaves like production and describes no real
 * property.
 */
import { createClient, type Client } from '@libsql/client'
import { rm, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRng } from './rng.ts'
import { photosForListing } from './photos.ts'
import { resetSchema, writeSeedData } from './index.ts'
import type { SeedData } from './generate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../../fixtures/dev-seed-realistic.db')
const SOURCE =
  process.env.HOME_SEARCH_DB ?? '/home/bengi/code/home-search/data/listings.db'

const STREETS = [
  'Maple', 'Kipling', 'Quaker', 'Alkire', 'Simms', 'Yarrow', 'Zephyr', 'Braun',
  'Coors', 'Devinney', 'Eldridge', 'Flower', 'Garrison', 'Holland', 'Newland',
  'Otis', 'Pierce', 'Reed', 'Saulsbury', 'Teller', 'Upham', 'Vance', 'Wadsworth',
] as const

const SUFFIXES = ['St', 'Dr', 'Ct', 'Way', 'Ln', 'Cir', 'Pl'] as const

const DESCRIPTION =
  'Placeholder description for local development. The real listing text has ' +
  'been removed; scores, commute times and photo flags on this listing are ' +
  'the genuine computed values.'

const STAGING_NOTE = 'Furniture appears digitally inserted in several rooms.'

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function int(value: unknown): number | null {
  const n = num(value)
  return n === null ? null : Math.round(n)
}

async function main(): Promise<void> {
  const source = createClient({ url: `file:${SOURCE}` })
  const rng = makeRng(20260905)

  const listings = (await source.execute('SELECT * FROM listings ORDER BY listing_id')).rows

  // Stable id remapping, applied to every child table so the joins survive.
  const idMap = new Map<string, string>()
  listings.forEach((row, i) => {
    idMap.set(String(row.listing_id), `dev-${String(i + 1).padStart(4, '0')}`)
  })
  const remap = (id: unknown): string => {
    const mapped = idMap.get(String(id))
    if (!mapped) throw new Error(`child row references unknown listing ${String(id)}`)
    return mapped
  }

  const data: SeedData = {
    listings: [],
    scores: [],
    visual_scores: [],
    commute: [],
    amenities: [],
    hosted_photos: [],
  }

  for (const row of listings) {
    const id = remap(row.listing_id)
    // ±7%, so the band and the ordering stay realistic while no figure is the
    // real asking price.
    const rawPrice = num(row.price_numeric)
    const price = rawPrice === null ? null : Math.round((rawPrice * rng.float(0.93, 1.07, 4)) / 500) * 500

    data.listings.push({
      listing_id: id,
      address: `${rng.int(1000, 9999)} ${rng.pick(STREETS)} ${rng.pick(SUFFIXES)}`,
      city: String(row.city),
      state: String(row.state),
      zip_code: String(row.zip_code),
      price: price === null ? String(row.price) : `$${price.toLocaleString('en-US')}`,
      price_numeric: price,
      beds: int(row.beds) ?? 0,
      baths: num(row.baths) ?? 0,
      sqft: int(row.sqft) ?? 0,
      lot_sqft: int(row.lot_sqft) ?? 0,
      parking_spaces: int(row.parking_spaces) ?? 0,
      year_built: int(row.year_built) ?? 0,
      description: DESCRIPTION,
      listing_url: `https://example.com/listing/${id}`,
      is_pinned: int(row.is_pinned) ?? 0,
      property_type: String(row.property_type ?? ''),
      localized_status: String(row.localized_status ?? ''),
      hoa_annual: num(row.hoa_annual),
      tax_annual: num(row.tax_annual),
      sqft_above_grade: int(row.sqft_above_grade),
      sqft_below_grade: int(row.sqft_below_grade),
      outdoor_spaces: row.outdoor_spaces === null ? null : String(row.outdoor_spaces),
    })
  }

  const scores = (await source.execute('SELECT * FROM scores')).rows
  for (const row of scores) {
    data.scores.push({
      listing_id: remap(row.listing_id),
      commute_score: num(row.commute_score) ?? 0,
      sqft_score: num(row.sqft_score) ?? 0,
      condition_score: num(row.condition_score) ?? 0,
      outdoor_score: num(row.outdoor_score) ?? 0,
      room_count_score: num(row.room_count_score) ?? 0,
      parking_score: num(row.parking_score) ?? 0,
      hoa_score: num(row.hoa_score) ?? 0,
      composite: num(row.composite) ?? 0,
      passes_filters: int(row.passes_filters) ?? 0,
      has_incomplete_data: int(row.has_incomplete_data) ?? 0,
      computed_at: String(row.computed_at),
    })
  }

  const visual = (await source.execute('SELECT * FROM visual_scores')).rows
  for (const row of visual) {
    data.visual_scores.push({
      listing_id: remap(row.listing_id),
      condition_photo_score: num(row.condition_photo_score),
      outdoor_photo_score: num(row.outdoor_photo_score),
      has_layout_plan: int(row.has_layout_plan) ?? 0,
      layout_plan_clarity_score: num(row.layout_plan_clarity_score),
      garage_attached: int(row.garage_attached),
      watermarked_staging_detected: int(row.watermarked_staging_detected) ?? 0,
      suspected_unwatermarked_staging: int(row.suspected_unwatermarked_staging) ?? 0,
      // The real note is model prose that quotes the address back; the detail
      // page renders it, so it needs a value, not a NULL.
      staging_notes: row.staging_notes === null ? null : STAGING_NOTE,
      photo_score_unavailable: int(row.photo_score_unavailable) ?? 0,
      raw_response: null,
      computed_at: String(row.computed_at),
    })
  }

  const commute = (await source.execute('SELECT * FROM commute')).rows
  for (const row of commute) {
    data.commute.push({
      listing_id: remap(row.listing_id),
      // lat/lon locate the actual house and no page reads them.
      lat: null,
      lon: null,
      denver_miles: num(row.denver_miles),
      denver_minutes: num(row.denver_minutes),
      medtronic_miles: num(row.medtronic_miles),
      medtronic_minutes: num(row.medtronic_minutes),
      geocode_failed: int(row.geocode_failed) ?? 0,
      computed_at: String(row.computed_at),
    })
  }

  const amenities = (await source.execute('SELECT * FROM amenities')).rows
  for (const row of amenities) {
    data.amenities.push({
      listing_id: remap(row.listing_id),
      amenity: String(row.amenity),
    })
  }

  // Real photo COUNTS, dev photo CONTENT: the gallery's paging and the
  // "12 / 49" counter behave exactly as they do in production, without
  // shipping 763 MB of someone's house.
  const counts = (await source.execute(
    'SELECT listing_id, COUNT(*) AS c FROM photo_urls GROUP BY listing_id',
  )).rows
  for (const row of counts) {
    data.hosted_photos.push(
      ...photosForListing(remap(row.listing_id), Number(row.c), rng),
    )
  }

  source.close()

  await mkdir(dirname(OUT), { recursive: true })
  await rm(OUT, { force: true })
  const out: Client = createClient({ url: `file:${OUT}` })
  await resetSchema(out)
  await writeSeedData(out, data)
  out.close()

  console.log(
    `wrote ${OUT}\n` +
      `  listings=${data.listings.length} scores=${data.scores.length} ` +
      `visual_scores=${data.visual_scores.length} commute=${data.commute.length} ` +
      `amenities=${data.amenities.length} hosted_photos=${data.hosted_photos.length}`,
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
