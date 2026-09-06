import { describe, it, expect } from 'vitest'
import { generate, EDGE_CASES, isSeedProfile, type ListingRow } from './generate.ts'

/** Finds the listing seeded for a named edge case. */
function caseListing(listings: ListingRow[], label: string): ListingRow {
  const found = listings.find((l) => l.address.endsWith(`— ${label}`))
  if (!found) throw new Error(`no listing seeded for edge case '${label}'`)
  return found
}

describe('isSeedProfile', () => {
  it('accepts the four known profiles', () => {
    for (const p of ['realistic', 'edge-cases', 'empty', 'huge']) {
      expect(isSeedProfile(p)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isSeedProfile('production')).toBe(false)
    expect(isSeedProfile('')).toBe(false)
  })
})

describe('generate', () => {
  // Screenshots from two branches are only comparable if the data behind them
  // is identical, and a bug found at listing #14 has to stay at listing #14.
  it('is deterministic for a given seed', () => {
    expect(generate('edge-cases', 99)).toEqual(generate('edge-cases', 99))
    expect(generate('huge', 99)).toEqual(generate('huge', 99))
  })

  it('produces different data for a different seed', () => {
    expect(generate('edge-cases', 1)).not.toEqual(generate('edge-cases', 2))
  })

  it('refuses the realistic profile, which is a committed fixture', () => {
    expect(() => generate('realistic')).toThrow(/committed fixture/)
  })

  it('builds nothing for the empty profile', () => {
    const data = generate('empty')
    expect(data.listings).toEqual([])
    expect(data.hosted_photos).toEqual([])
  })

  it('builds 500 listings for the huge profile', () => {
    expect(generate('huge').listings).toHaveLength(500)
  })

  // The huge profile mirrors the real 84-vs-78 gap, so the LEFT JOIN NULL path
  // gets exercised at scale rather than only in edge-cases.
  it('leaves some huge-profile listings without a scores row', () => {
    const data = generate('huge')
    expect(data.scores.length).toBeLessThan(data.listings.length)
    expect(data.scores.length).toBeGreaterThan(data.listings.length * 0.85)
  })
})

describe('edge-cases profile', () => {
  const data = generate('edge-cases')
  const listings = data.listings

  it('seeds one listing per declared edge case', () => {
    expect(listings).toHaveLength(EDGE_CASES.length)
  })

  it('names each case in the address so it is identifiable on screen', () => {
    for (const edge of EDGE_CASES) {
      expect(() => caseListing(listings, edge.label)).not.toThrow()
    }
  })

  it('includes a listing with no photos and one with sixty', () => {
    const none = caseListing(listings, 'no photos at all')
    const many = caseListing(listings, 'sixty photos')
    expect(data.hosted_photos.filter((p) => p.listing_id === none.listing_id)).toHaveLength(0)
    expect(data.hosted_photos.filter((p) => p.listing_id === many.listing_id)).toHaveLength(60)
  })

  // The cost sort divides on both; both NULL must fall to NULLS LAST rather
  // than sorting as free.
  it('includes a listing with tax and hoa both unknown', () => {
    const listing = caseListing(listings, 'tax and hoa both unknown')
    expect(listing.hoa_annual).toBeNull()
    expect(listing.tax_annual).toBeNull()
  })

  // lib/facts.ts::basementFact returns "Not available" on this path.
  it('includes a listing missing above-grade sqft', () => {
    expect(caseListing(listings, 'above grade sqft missing').sqft_above_grade).toBeNull()
  })

  // above-grade present with below-grade 0 is Compass's encoding for
  // "Basement: No" -- a confirmed absence, not missing data.
  it('includes a confirmed no-basement listing', () => {
    const listing = caseListing(listings, 'confirmed no basement')
    expect(listing.sqft_above_grade).toBe(1800)
    expect(listing.sqft_below_grade).toBe(0)
  })

  // SQFT_TOLERANCE is 10, so a 336 sqft gap renders the sub-line and a 4 sqft
  // gap must not.
  it('includes shortfalls on both sides of SQFT_TOLERANCE', () => {
    const past = caseListing(listings, 'finished area shortfall')
    expect(past.sqft - (past.sqft_above_grade! + past.sqft_below_grade!)).toBe(336)

    const inside = caseListing(listings, 'shortfall inside tolerance')
    expect(inside.sqft - (inside.sqft_above_grade! + inside.sqft_below_grade!)).toBe(4)
  })

  it('includes each staging flag alone and both together', () => {
    const flags = (label: string) => {
      const id = caseListing(listings, label).listing_id
      const row = data.visual_scores.find((v) => v.listing_id === id)!
      return [row.watermarked_staging_detected, row.suspected_unwatermarked_staging]
    }
    expect(flags('watermarked staging')).toEqual([1, 0])
    expect(flags('suspected staging')).toEqual([0, 1])
    expect(flags('both staging flags')).toEqual([1, 1])
  })

  it('includes a listing whose photos could not be scored', () => {
    const id = caseListing(listings, 'photo scoring unavailable').listing_id
    const row = data.visual_scores.find((v) => v.listing_id === id)!
    expect(row.photo_score_unavailable).toBe(1)
  })

  // A missing row is not the same as a row full of NULLs, and the real mirror
  // produces it for six of its 84 listings.
  it('omits the scores, visual_scores and commute rows entirely for three listings', () => {
    const noScore = caseListing(listings, 'no scores row').listing_id
    expect(data.scores.some((s) => s.listing_id === noScore)).toBe(false)

    const noVisual = caseListing(listings, 'no visual scores row').listing_id
    expect(data.visual_scores.some((v) => v.listing_id === noVisual)).toBe(false)

    const noCommute = caseListing(listings, 'no commute row').listing_id
    expect(data.commute.some((c) => c.listing_id === noCommute)).toBe(false)
  })

  // The value sort divides by price_numeric / 100000.
  it('includes a zero price and an unknown price', () => {
    expect(caseListing(listings, 'price is zero').price_numeric).toBe(0)
    expect(caseListing(listings, 'price unknown').price_numeric).toBeNull()
  })

  it('includes prices far outside the real $480k-$675k band', () => {
    expect(caseListing(listings, 'far below the band').price_numeric).toBe(180_000)
    expect(caseListing(listings, 'far above the band').price_numeric).toBe(3_400_000)
  })

  // The real maximum is 26 characters.
  it('includes an address far longer than any real one', () => {
    expect(caseListing(listings, 'very long address').address.length).toBeGreaterThan(78)
  })

  it('includes a listing with no amenities and one with every amenity', () => {
    const none = caseListing(listings, 'no amenities').listing_id
    expect(data.amenities.filter((a) => a.listing_id === none)).toHaveLength(0)

    const all = caseListing(listings, 'every amenity').listing_id
    expect(data.amenities.filter((a) => a.listing_id === all).length).toBeGreaterThan(40)
  })

  it('includes a listing that fails filters and one with incomplete data', () => {
    const failing = caseListing(listings, 'fails filters').listing_id
    expect(data.scores.find((s) => s.listing_id === failing)!.passes_filters).toBe(0)

    const incomplete = caseListing(listings, 'incomplete data').listing_id
    expect(data.scores.find((s) => s.listing_id === incomplete)!.has_incomplete_data).toBe(1)
  })

  // A failed geocode means no coordinates, so NO leg can have been computed.
  // The list card reads whichever one lib/queries.ts selects, so leaving
  // either populated renders a commute time for a listing with no location.
  it('includes a listing whose geocode failed, with every commute figure null', () => {
    const id = caseListing(listings, 'geocode failed').listing_id
    const row = data.commute.find((c) => c.listing_id === id)!
    expect(row.geocode_failed).toBe(1)
    expect(row.lat).toBeNull()
    expect(row.lon).toBeNull()
    expect(row.denver_miles).toBeNull()
    expect(row.denver_minutes).toBeNull()
    expect(row.medtronic_miles).toBeNull()
    expect(row.medtronic_minutes).toBeNull()
  })

  // Holds for every generated row, not just the named edge case, so a future
  // profile cannot reintroduce the inconsistency.
  it('never leaves a commute figure on a failed geocode in any profile', () => {
    for (const profile of ['edge-cases', 'huge'] as const) {
      for (const row of generate(profile).commute) {
        if (row.geocode_failed !== 1) continue
        expect(row.denver_minutes).toBeNull()
        expect(row.medtronic_minutes).toBeNull()
        expect(row.denver_miles).toBeNull()
        expect(row.medtronic_miles).toBeNull()
      }
    }
  })
})
