import { describe, it, expect } from 'vitest'
import { makeRng } from './rng.ts'
import { photosForListing, photoUrl, DEV_PHOTOS } from './photos.ts'

describe('photosForListing', () => {
  it('returns nothing for a listing with no photos', () => {
    expect(photosForListing('dev-0001', 0, makeRng(1))).toEqual([])
  })

  // lib/queries.ts builds the list thumbnail from `ORDER BY hp.position LIMIT 1`,
  // so anything but the front exterior at position 0 gives a grid of bathrooms.
  it('always puts the front exterior at position 0', () => {
    for (const count of [1, 3, 9, 34, 60]) {
      const rows = photosForListing('dev-0001', count, makeRng(count))
      expect(rows[0]!.position).toBe(0)
      expect(rows[0]!.blob_url).toBe('/dev-photos/01-front.webp')
    }
  })

  // hosted_photos is keyed on (listing_id, position) and the gallery's
  // "12 / 49" counter assumes a dense array.
  it('numbers positions contiguously from zero', () => {
    const rows = photosForListing('dev-0001', 47, makeRng(7))
    expect(rows.map((r) => r.position)).toEqual([...Array(47).keys()])
  })

  it('serves same-origin paths, so next/image needs no remotePatterns entry', () => {
    const rows = photosForListing('dev-0001', 12, makeRng(3))
    for (const row of rows) {
      expect(row.blob_url.startsWith('/dev-photos/')).toBe(true)
    }
  })

  // Picking at random each time would show six bathrooms in a row; cycling a
  // shuffled pool shows every kind before repeating any.
  it('uses every non-front photo before repeating one', () => {
    const rows = photosForListing('dev-0001', DEV_PHOTOS.length, makeRng(5))
    const used = new Set(rows.slice(1).map((r) => r.blob_url))
    expect(used.size).toBe(DEV_PHOTOS.length - 1)
  })

  it('is deterministic for a given seed', () => {
    const a = photosForListing('dev-0001', 30, makeRng(42))
    const b = photosForListing('dev-0001', 30, makeRng(42))
    expect(a).toEqual(b)
  })
})

describe('photoUrl', () => {
  it('builds a root-relative path', () => {
    expect(photoUrl(DEV_PHOTOS[0]!)).toBe('/dev-photos/01-front.webp')
  })
})
