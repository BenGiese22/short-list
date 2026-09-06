import { makeRng, type Rng } from './rng.ts'
import { photosForListing, type HostedPhotoRow } from './photos.ts'

/**
 * Deterministic seed data for every profile except `realistic`, which is a
 * committed fixture derived from the real mirror (see `anonymize.ts`).
 *
 * Numbers here track the real distributions measured off
 * `home-search/data/listings.db` and recorded in `fixtures/distributions.json`
 * — prices $480k-$675k, 1,176-3,177 sqft, composite scores on a ~44-77 range
 * of a 100-point scale. The `edge-cases` profile then deliberately leaves that
 * band, because the real data almost never does.
 */

export type SeedProfile = 'realistic' | 'edge-cases' | 'empty' | 'huge'

export const SEED_PROFILES: readonly SeedProfile[] = [
  'realistic',
  'edge-cases',
  'empty',
  'huge',
] as const

export function isSeedProfile(value: string): value is SeedProfile {
  return (SEED_PROFILES as readonly string[]).includes(value)
}

export interface ListingRow {
  listing_id: string
  address: string
  city: string
  state: string
  zip_code: string
  price: string
  price_numeric: number | null
  beds: number
  baths: number
  sqft: number
  lot_sqft: number
  parking_spaces: number
  year_built: number
  description: string
  listing_url: string
  is_pinned: number
  property_type: string
  localized_status: string
  hoa_annual: number | null
  tax_annual: number | null
  sqft_above_grade: number | null
  sqft_below_grade: number | null
  outdoor_spaces: string | null
}

export interface ScoreRow {
  listing_id: string
  commute_score: number
  sqft_score: number
  condition_score: number
  outdoor_score: number
  room_count_score: number
  parking_score: number
  hoa_score: number
  composite: number
  passes_filters: number
  has_incomplete_data: number
  computed_at: string
}

export interface VisualScoreRow {
  listing_id: string
  condition_photo_score: number | null
  outdoor_photo_score: number | null
  has_layout_plan: number
  layout_plan_clarity_score: number | null
  garage_attached: number | null
  watermarked_staging_detected: number
  suspected_unwatermarked_staging: number
  staging_notes: string | null
  photo_score_unavailable: number
  raw_response: string | null
  computed_at: string
}

export interface CommuteRow {
  listing_id: string
  lat: number | null
  lon: number | null
  denver_miles: number | null
  denver_minutes: number | null
  medtronic_miles: number | null
  medtronic_minutes: number | null
  geocode_failed: number
  computed_at: string
}

export interface AmenityRow {
  listing_id: string
  amenity: string
}

export interface SeedData {
  listings: ListingRow[]
  scores: ScoreRow[]
  visual_scores: VisualScoreRow[]
  commute: CommuteRow[]
  amenities: AmenityRow[]
  hosted_photos: HostedPhotoRow[]
}

const COMPUTED_AT = '2026-09-05T12:00:00Z'

const CITIES = [
  { city: 'Arvada', zip: '80004' },
  { city: 'Broomfield', zip: '80020' },
  { city: 'Westminster', zip: '80031' },
  { city: 'Lafayette', zip: '80026' },
] as const

const STREETS = [
  'Maple', 'Kipling', 'Quaker', 'Alkire', 'Simms', 'Yarrow', 'Zephyr',
  'Braun', 'Coors', 'Devinney', 'Eldridge', 'Flower', 'Garrison', 'Holland',
  'Independence', 'Johnson', 'Lamar', 'Newland', 'Otis', 'Pierce',
] as const

const SUFFIXES = ['St', 'Dr', 'Ct', 'Way', 'Ln', 'Cir', 'Pl'] as const

const PROPERTY_TYPES = ['Single Family Residence', 'Townhouse', 'Condominium'] as const

const STATUSES = ['Active', 'Active', 'Active', 'Pending', 'Coming Soon'] as const

const AMENITY_POOL = [
  'Central Air', 'Forced Air', 'Fireplace', 'Granite Counters', 'Quartz Counters',
  'Walk-In Closet', 'Primary Suite', 'Finished Basement', 'Covered Patio', 'Deck',
  'Fenced Yard', 'Sprinkler System', 'Mature Trees', 'Mountain Views', 'Open Floorplan',
  'Vaulted Ceilings', 'Hardwood Floors', 'Tile Floors', 'Stainless Appliances',
  'Gas Range', 'Double Oven', 'Kitchen Island', 'Pantry', 'Mud Room', 'Laundry Room',
  'Attached Garage', 'Oversized Garage', 'RV Parking', 'Storage Shed', 'Garden Beds',
  'Solar Panels', 'Radon Mitigation', 'New Roof', 'New Windows', 'Updated Electrical',
  'Smart Thermostat', 'EV Charger', 'Water Softener', 'Sump Pump', 'Egress Windows',
  'Hot Tub', 'Pergola', 'Fire Pit', 'Dog Run',
] as const

const OUTDOOR_POOL = ['Deck', 'Patio', 'Covered Patio', 'Balcony', 'Porch'] as const

const DESCRIPTION_OPENERS = [
  'Beautifully maintained home on a quiet cul-de-sac',
  'Move-in ready with thoughtful updates throughout',
  'Rare opportunity in an established neighborhood',
  'Light-filled floorplan backing to open space',
  'Well-cared-for ranch with a finished lower level',
] as const

function fmtPrice(value: number): string {
  return `$${value.toLocaleString('en-US')}`
}

function makeDescription(rng: Rng, city: string): string {
  return (
    `${rng.pick(DESCRIPTION_OPENERS)} in ${city}. ` +
    'Generated placeholder copy for local development — this is not a real listing. ' +
    'Kitchen opens to the living area, the yard is fully fenced, and the ' +
    'mechanicals have been kept current.'
  )
}

/** A listing in the middle of the real distribution. `overrides` bends it. */
function baseListing(
  rng: Rng,
  index: number,
  overrides: Partial<ListingRow> = {},
): ListingRow {
  const place = rng.pick(CITIES)
  const priceNumeric = rng.int(480_000, 675_000)
  const sqft = rng.int(1176, 3177)
  const aboveGrade = Math.round(sqft * rng.float(0.6, 1.0))
  const hasBasement = rng.chance(0.6)

  return {
    listing_id: `dev-${String(index).padStart(4, '0')}`,
    address: `${rng.int(1000, 9999)} ${rng.pick(STREETS)} ${rng.pick(SUFFIXES)}`,
    city: place.city,
    state: 'CO',
    zip_code: place.zip,
    price: fmtPrice(priceNumeric),
    price_numeric: priceNumeric,
    beds: rng.int(2, 5),
    baths: rng.pick([1, 1.5, 2, 2.5, 3, 3.5, 4]),
    sqft,
    lot_sqft: rng.int(3000, 14000),
    parking_spaces: rng.int(0, 3),
    year_built: rng.int(1953, 2005),
    description: makeDescription(rng, place.city),
    listing_url: `https://example.com/listing/dev-${String(index).padStart(4, '0')}`,
    is_pinned: 0,
    property_type: rng.pick(PROPERTY_TYPES),
    localized_status: rng.pick(STATUSES),
    hoa_annual: rng.chance(0.45) ? rng.float(180, 3600) : null,
    tax_annual: rng.float(1800, 5200),
    sqft_above_grade: aboveGrade,
    sqft_below_grade: hasBasement ? rng.int(200, 1200) : 0,
    outdoor_spaces: rng.chance(0.7) ? rng.pick(OUTDOOR_POOL) : null,
    ...overrides,
  }
}

function baseScore(
  rng: Rng,
  listingId: string,
  overrides: Partial<ScoreRow> = {},
): ScoreRow {
  const composite = rng.float(44.3, 76.6, 3)
  return {
    listing_id: listingId,
    commute_score: rng.float(0, 100, 2),
    sqft_score: rng.float(0, 100, 2),
    condition_score: rng.float(0, 100, 2),
    outdoor_score: rng.float(0, 100, 2),
    room_count_score: rng.float(0, 100, 2),
    parking_score: rng.float(0, 100, 2),
    hoa_score: rng.float(0, 100, 2),
    composite,
    // 73 of 78 pass upstream, so most do here too.
    passes_filters: rng.chance(0.94) ? 1 : 0,
    has_incomplete_data: rng.chance(0.13) ? 1 : 0,
    computed_at: COMPUTED_AT,
    ...overrides,
  }
}

function baseVisualScore(
  rng: Rng,
  listingId: string,
  overrides: Partial<VisualScoreRow> = {},
): VisualScoreRow {
  const suspected = rng.chance(0.38) ? 1 : 0
  const watermarked = rng.chance(0.09) ? 1 : 0
  return {
    listing_id: listingId,
    condition_photo_score: rng.float(0, 100, 2),
    outdoor_photo_score: rng.float(0, 100, 2),
    has_layout_plan: rng.chance(0.46) ? 1 : 0,
    layout_plan_clarity_score: rng.chance(0.46) ? rng.float(0, 100, 2) : null,
    garage_attached: rng.chance(0.92) ? (rng.chance(0.7) ? 1 : 0) : null,
    watermarked_staging_detected: watermarked,
    suspected_unwatermarked_staging: suspected,
    staging_notes:
      suspected || watermarked
        ? 'Furniture appears digitally inserted in several rooms.'
        : null,
    photo_score_unavailable: 0,
    raw_response: null,
    computed_at: COMPUTED_AT,
    ...overrides,
  }
}

function baseCommute(
  rng: Rng,
  listingId: string,
  overrides: Partial<CommuteRow> = {},
): CommuteRow {
  const failed = rng.chance(0.095)
  if (failed) {
    return {
      listing_id: listingId,
      lat: null,
      lon: null,
      denver_miles: null,
      denver_minutes: null,
      medtronic_miles: null,
      medtronic_minutes: null,
      geocode_failed: 1,
      computed_at: COMPUTED_AT,
      ...overrides,
    }
  }
  return {
    listing_id: listingId,
    lat: rng.float(39.7, 40.05, 5),
    lon: rng.float(-105.2, -105.0, 5),
    denver_miles: rng.float(8, 26, 1),
    denver_minutes: rng.float(15, 48, 1),
    medtronic_miles: rng.float(3, 22, 1),
    medtronic_minutes: rng.float(8, 40, 1),
    geocode_failed: 0,
    computed_at: COMPUTED_AT,
    ...overrides,
  }
}

function amenitiesFor(rng: Rng, listingId: string, count: number): AmenityRow[] {
  return rng
    .shuffle(AMENITY_POOL)
    .slice(0, count)
    .map((amenity) => ({ listing_id: listingId, amenity }))
}

function emptyData(): SeedData {
  return {
    listings: [],
    scores: [],
    visual_scores: [],
    commute: [],
    amenities: [],
    hosted_photos: [],
  }
}

/**
 * One deliberately awkward listing.
 *
 * `score`, `visual` and `commute` are `null` to mean **no row at all** — the
 * LEFT JOIN case, which is different from a row full of NULLs and which the
 * real mirror produces for six of its 84 listings.
 */
interface EdgeCase {
  /** Shows up in the address, so the case is identifiable on screen. */
  label: string
  listing?: Partial<ListingRow>
  score?: Partial<ScoreRow> | null
  visual?: Partial<VisualScoreRow> | null
  commute?: Partial<CommuteRow> | null
  photoCount?: number
  amenityCount?: number
}

/**
 * Every state the real data has too little of. Each is a named case rather
 * than a random draw, so `generate.test.ts` can assert the row exists instead
 * of trusting the generator to have rolled it.
 */
export const EDGE_CASES: readonly EdgeCase[] = [
  {
    label: 'no photos at all',
    listing: {},
    photoCount: 0,
  },
  {
    label: 'sixty photos',
    listing: {},
    photoCount: 60,
  },
  {
    label: 'tax and hoa both unknown',
    // The `cost` sort divides on these; both NULL must fall to NULLS LAST
    // rather than sorting as free.
    listing: { hoa_annual: null, tax_annual: null },
  },
  {
    label: 'hoa unknown, tax known',
    listing: { hoa_annual: null, tax_annual: 4100 },
  },
  {
    label: 'above grade sqft missing',
    // lib/facts.ts::basementFact returns "Not available" on this path.
    listing: { sqft_above_grade: null, sqft_below_grade: null },
  },
  {
    label: 'confirmed no basement',
    // above-grade present with below-grade 0 is Compass's encoding for
    // "Basement: No" — a confirmed absence, not missing data.
    listing: { sqft: 1800, sqft_above_grade: 1800, sqft_below_grade: 0 },
  },
  {
    label: 'finished area shortfall',
    // 1404 + 360 = 1764 against 2100 listed: a 336 sqft gap, far past
    // SQFT_TOLERANCE, so the explanatory sub-line renders.
    listing: { sqft: 2100, sqft_above_grade: 1404, sqft_below_grade: 360 },
  },
  {
    label: 'shortfall inside tolerance',
    // A 4 sqft gap must NOT trigger the sub-line.
    listing: { sqft: 1800, sqft_above_grade: 1400, sqft_below_grade: 396 },
  },
  {
    label: 'photo scoring unavailable',
    visual: { photo_score_unavailable: 1, condition_photo_score: null, outdoor_photo_score: null },
  },
  {
    label: 'watermarked staging',
    visual: { watermarked_staging_detected: 1, suspected_unwatermarked_staging: 0 },
  },
  {
    label: 'suspected staging',
    visual: { watermarked_staging_detected: 0, suspected_unwatermarked_staging: 1 },
  },
  {
    label: 'both staging flags',
    visual: { watermarked_staging_detected: 1, suspected_unwatermarked_staging: 1 },
  },
  {
    label: 'no scores row',
    listing: {},
    score: null,
  },
  {
    label: 'no visual scores row',
    listing: {},
    visual: null,
  },
  {
    label: 'no commute row',
    listing: {},
    commute: null,
  },
  {
    label: 'geocode failed',
    // Every figure must go, not just the Denver pair: a failed geocode means
    // no coordinates, so no leg can have been computed. The list card reads
    // whichever leg lib/queries.ts selects (medtronic_minutes as of cfa6cc3),
    // and leaving the other populated renders a commute time for a listing
    // that has no location -- which is the opposite of what this case is for.
    commute: {
      geocode_failed: 1,
      lat: null,
      lon: null,
      denver_miles: null,
      denver_minutes: null,
      medtronic_miles: null,
      medtronic_minutes: null,
    },
  },
  {
    label: 'fails filters',
    score: { passes_filters: 0, composite: 21.4 },
  },
  {
    label: 'incomplete data',
    score: { has_incomplete_data: 1 },
  },
  {
    label: 'very long address',
    // The real maximum is 26 characters. This is 78.
    listing: {
      address: '13847 West Nottingham Heights Terrace Circle Court Extension Number Seventeen B',
      city: 'Broomfield',
    },
  },
  {
    label: 'one word address',
    listing: { address: 'Ranch', city: 'Arvada' },
  },
  {
    label: 'price is zero',
    // The `value` sort divides by price_numeric / 100000.
    listing: { price: 'Contact agent', price_numeric: 0 },
  },
  {
    label: 'price unknown',
    listing: { price: 'Price withheld', price_numeric: null },
  },
  {
    label: 'far below the band',
    listing: { price: '$180,000', price_numeric: 180_000, sqft: 720, beds: 1, baths: 1 },
  },
  {
    label: 'far above the band',
    listing: { price: '$3,400,000', price_numeric: 3_400_000, sqft: 6400, beds: 6, baths: 5.5 },
  },
  {
    label: 'no amenities',
    amenityCount: 0,
  },
  {
    label: 'every amenity',
    amenityCount: AMENITY_POOL.length,
  },
  {
    label: 'pinned listing',
    listing: { is_pinned: 1 },
  },
  {
    label: 'zero parking',
    listing: { parking_spaces: 0 },
    visual: { garage_attached: null },
  },
  {
    label: 'top composite',
    score: { composite: 98.7, passes_filters: 1, has_incomplete_data: 0 },
  },
  {
    label: 'bottom composite',
    score: { composite: 3.2, passes_filters: 0 },
  },
]

function buildEdgeCases(rng: Rng): SeedData {
  const data = emptyData()

  EDGE_CASES.forEach((edge, index) => {
    const listing = baseListing(rng, index + 1, edge.listing ?? {})
    // Name the case in the address so it is identifiable in the list view
    // without cross-referencing this file.
    listing.address = `${listing.address} — ${edge.label}`
    data.listings.push(listing)

    if (edge.score !== null) {
      data.scores.push(baseScore(rng, listing.listing_id, edge.score ?? {}))
    }
    if (edge.visual !== null) {
      data.visual_scores.push(baseVisualScore(rng, listing.listing_id, edge.visual ?? {}))
    }
    if (edge.commute !== null) {
      data.commute.push(baseCommute(rng, listing.listing_id, edge.commute ?? {}))
    }

    const photoCount = edge.photoCount ?? rng.int(9, 50)
    data.hosted_photos.push(...photosForListing(listing.listing_id, photoCount, rng))

    const amenityCount = edge.amenityCount ?? rng.int(5, 20)
    data.amenities.push(...amenitiesFor(rng, listing.listing_id, amenityCount))
  })

  return data
}

function buildBulk(rng: Rng, count: number): SeedData {
  const data = emptyData()

  for (let index = 1; index <= count; index++) {
    const listing = baseListing(rng, index)
    data.listings.push(listing)

    // Mirror the real 84-vs-78 gap: a small share of listings have no score
    // or visual score row at all.
    if (rng.chance(0.93)) {
      data.scores.push(baseScore(rng, listing.listing_id))
    }
    if (rng.chance(0.93)) {
      data.visual_scores.push(baseVisualScore(rng, listing.listing_id))
    }
    data.commute.push(baseCommute(rng, listing.listing_id))
    data.hosted_photos.push(
      ...photosForListing(listing.listing_id, rng.int(9, 50), rng),
    )
    data.amenities.push(...amenitiesFor(rng, listing.listing_id, rng.int(5, 44)))
  }

  return data
}

/**
 * Seed data for a generated profile.
 *
 * `realistic` is not generated — it is the committed fixture — so this throws
 * rather than quietly returning something that looks plausible.
 */
export function generate(profile: SeedProfile, seed = 20260905): SeedData {
  const rng = makeRng(seed)

  switch (profile) {
    case 'edge-cases':
      return buildEdgeCases(rng)
    case 'huge':
      return buildBulk(rng, 500)
    case 'empty':
      return emptyData()
    case 'realistic':
      throw new Error(
        "the 'realistic' profile is the committed fixture at " +
          'fixtures/dev-seed-realistic.db, not generated data',
      )
  }
}
