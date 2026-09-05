import type { Rng } from './rng.ts'

/**
 * The ten dev photos in `public/dev-photos/`, in the order a Compass gallery
 * tends to run: outside, living space, sleeping, utility, outside again.
 *
 * Aspect ratios are deliberately mixed. A uniform set of 3:2 images would make
 * the gallery and the list thumbnails look better than they are, and hide the
 * layout problems that show up on a portrait bathroom shot or a square
 * floorplan.
 */
export interface DevPhoto {
  file: string
  /** Room type, used only to keep the ordering sensible and to label output. */
  kind: string
  width: number
  height: number
}

export const DEV_PHOTOS: readonly DevPhoto[] = [
  { file: '01-front.webp', kind: 'front', width: 1200, height: 800 },
  { file: '02-living.webp', kind: 'living', width: 1200, height: 800 },
  { file: '03-kitchen.webp', kind: 'kitchen', width: 1200, height: 800 },
  { file: '04-primary-bed.webp', kind: 'bedroom', width: 1200, height: 800 },
  { file: '05-bath.webp', kind: 'bath', width: 800, height: 1200 },
  { file: '06-basement.webp', kind: 'basement', width: 1200, height: 800 },
  { file: '07-backyard.webp', kind: 'backyard', width: 1200, height: 800 },
  { file: '08-family.webp', kind: 'family', width: 1200, height: 800 },
  { file: '09-aerial.webp', kind: 'aerial', width: 1600, height: 900 },
  { file: '10-floorplan.webp', kind: 'floorplan', width: 1000, height: 1000 },
] as const

/** Same-origin path, so `next/image` serves it without a `remotePatterns` entry. */
export function photoUrl(photo: DevPhoto): string {
  return `/dev-photos/${photo.file}`
}

export interface HostedPhotoRow {
  listing_id: string
  position: number
  blob_url: string
  source_url: string | null
}

/**
 * Photo rows for one listing.
 *
 * Two invariants the UI depends on:
 *
 *   - **Position 0 is always the front exterior.** `lib/queries.ts` builds the
 *     list thumbnail from `ORDER BY hp.position LIMIT 1`, so anything else here
 *     gives you a grid of bathrooms.
 *   - **Positions are contiguous from 0.** `hosted_photos` is keyed on
 *     (listing_id, position), and the gallery's "12 / 49" counter assumes a
 *     dense array.
 *
 * With only ten images and up to 60 photos on a listing, the set repeats. That
 * is fine for layout review and obvious enough on screen that nobody mistakes
 * it for real data.
 */
export function photosForListing(
  listingId: string,
  count: number,
  rng: Rng,
): HostedPhotoRow[] {
  if (count <= 0) return []

  const front = DEV_PHOTOS[0]!
  const rest = DEV_PHOTOS.slice(1)

  const rows: HostedPhotoRow[] = [
    {
      listing_id: listingId,
      position: 0,
      blob_url: photoUrl(front),
      source_url: `https://example.com/photos/${listingId}/0`,
    },
  ]

  // Shuffle once per cycle rather than picking at random each time, so a
  // listing with 30 photos shows all ten kinds instead of six bathrooms.
  let pool: DevPhoto[] = []
  for (let position = 1; position < count; position++) {
    if (pool.length === 0) pool = rng.shuffle(rest)
    const photo = pool.pop()!
    rows.push({
      listing_id: listingId,
      position,
      blob_url: photoUrl(photo),
      source_url: `https://example.com/photos/${listingId}/${position}`,
    })
  }

  return rows
}
