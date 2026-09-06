#!/usr/bin/env node
/**
 * One-off: builds `public/dev-photos/` from the real photo cache.
 *
 *   node scripts/seed/extract-photos.ts
 *
 * Requires `~/code/home-search` checked out with its photo cache present. Its
 * OUTPUT is committed, so a clean checkout of this repo never needs to run it —
 * this file exists to record where those ten images came from and to make them
 * reproducible if the set ever needs revisiting.
 *
 * Source: listing 2130635071954589457, a single Arvada tri-level whose 51
 * photos happen to cover almost the whole Compass taxonomy. Using one house
 * rather than ten is deliberate — the images repeat across seeded listings
 * either way, and one house at least looks coherent within a gallery.
 *
 * Aspect ratios are intentionally mixed. A uniform set of 3:2 images would
 * make the gallery look better than it is and hide the layout problems that
 * only a portrait bathroom shot or a square floorplan will surface.
 */
import sharp from 'sharp'
import { readdir, mkdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../../public/dev-photos')
const SOURCE_DIR =
  process.env.HOME_SEARCH_PHOTOS ??
  '/home/bengi/code/home-search/data/photos/2130635071954589457'

/**
 * Note on source indices: the cache directory holds two files for some
 * positions (`01-46704567.jpg` alongside `01-869c97e1.jpg`) — the relisting
 * case `src/turso_db.py` documents, where a listing came back with different
 * photos in the same positions. `index` is therefore the 1-based position in
 * the **sorted directory listing**, which is what these were chosen from, and
 * it will not line up with the numeric prefix on the source filename.
 */
interface Pick {
  index: number
  file: string
  width: number
  height: number
  /** Floorplans must not be cropped, so they letterbox onto white instead. */
  contain?: boolean
  /** Fraction of the source height to trim off the top before resizing. */
  cropTop?: number
}

const PICKS: readonly Pick[] = [
  { index: 4, file: '01-front.webp', width: 1200, height: 800 },
  { index: 12, file: '02-living.webp', width: 1200, height: 800 },
  { index: 19, file: '03-kitchen.webp', width: 1200, height: 800 },
  { index: 34, file: '04-primary-bed.webp', width: 1200, height: 800 },
  { index: 38, file: '05-bath.webp', width: 800, height: 1200 },
  { index: 27, file: '06-basement.webp', width: 1200, height: 800 },
  { index: 41, file: '07-backyard.webp', width: 1200, height: 800 },
  // Sheet position 8 is another front-of-house shot, near-identical to
  // 01-front once cropped; the fireplace room gives the set an interior that
  // is actually distinguishable from 02-living at thumbnail size.
  { index: 22, file: '08-family.webp', width: 1200, height: 800 },
  { index: 47, file: '09-aerial.webp', width: 1600, height: 900 },
  // The source floorplan prints the real street address across its top
  // margin. Trimming the top 6% removes it, and loses nothing but whitespace.
  { index: 50, file: '10-floorplan.webp', width: 1000, height: 1000, contain: true, cropTop: 0.06 },
]

async function main(): Promise<void> {
  const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.jpg')).sort()
  if (files.length === 0) {
    throw new Error(`no photos in ${SOURCE_DIR} — is home-search checked out?`)
  }

  await mkdir(OUT_DIR, { recursive: true })

  for (const pick of PICKS) {
    const source = files[pick.index - 1]
    if (!source) {
      throw new Error(`source photo ${pick.index} missing (only ${files.length} present)`)
    }

    let image = sharp(join(SOURCE_DIR, source))

    if (pick.cropTop) {
      const meta = await image.metadata()
      const top = Math.round(meta.height! * pick.cropTop)
      image = image.extract({ left: 0, top, width: meta.width!, height: meta.height! - top })
    }

    const info = await image
      .resize(pick.width, pick.height, {
        fit: pick.contain ? 'contain' : 'cover',
        background: '#ffffff',
      })
      // Quality 62 holds the whole set near 500 KB. These exist to review
      // layout, not image fidelity; at this size compression artifacts are
      // invisible at the dimensions the UI actually renders them.
      .webp({ quality: 62 })
      .toFile(join(OUT_DIR, pick.file))

    console.log(
      `${pick.file.padEnd(22)} ${String(info.width).padStart(4)}x${String(info.height).padEnd(4)} ` +
        `${String(Math.round(info.size / 1024)).padStart(3)} KB  ← ${source}`,
    )
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
