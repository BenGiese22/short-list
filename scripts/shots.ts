#!/usr/bin/env node
/**
 * Screenshots the running dev container, for before/after pairs on a PR.
 *
 *   npm run dev:shots               # → .shots/
 *   npm run dev:shots -- .shots/pr7 # → .shots/pr7/
 *
 * Run it once per branch and compare the two folders.
 *
 * It signs in through the real passcode form rather than forging a session
 * cookie. That costs one page load and buys branch independence: PR #7 changes
 * the cookie's signed payload from the literal "authenticated" to a versioned
 * claim set, so anything that mints a cookie itself would break on exactly the
 * branch this tool exists to photograph.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const BASE_URL = process.env.SHOTS_BASE_URL ?? 'http://localhost:3000'
const PASSCODE = process.env.SITE_PASSCODE ?? '1234'

interface Viewport {
  name: string
  width: number
  height: number
}

const VIEWPORTS: readonly Viewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

interface Shot {
  name: string
  path: string
  /** Full-page rather than just the viewport. */
  full?: boolean
  /** Skipped when signed out. */
  auth?: boolean
}

const SHOTS: readonly Shot[] = [
  { name: 'enter', path: '/enter' },
  // PR #7's failure state for a bad or expired share link.
  { name: 'enter-link-error', path: '/enter?error=link' },
  { name: 'list', path: '/', full: true, auth: true },
  { name: 'list-sort-cost', path: '/?sort=cost', auth: true },
  { name: 'list-sort-value', path: '/?sort=value', auth: true },
  { name: 'list-only-passes', path: '/?onlyPasses=1', auth: true },
  { name: 'list-only-staging', path: '/?onlyStaging=1', auth: true },
  { name: 'list-only-pending', path: '/?onlyPending=1', auth: true },
  { name: 'list-empty-search', path: '/?search=zzzznomatch', auth: true },
]

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/enter`, { waitUntil: 'networkidle' })
  // The gate is a single password field and a submit button; addressing it by
  // role keeps this working if the markup around it changes.
  await page.locator('input[type="password"]').fill(PASSCODE)
  await Promise.all([
    page.waitForURL((url: URL) => !url.pathname.startsWith('/enter'), { timeout: 15_000 }),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ])
}

async function firstListingPath(page: Page): Promise<string | null> {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  const href = await page.locator('a[href^="/listing/"]').first().getAttribute('href')
  return href
}

async function capture(
  browser: Browser,
  viewport: Viewport,
  outDir: string,
): Promise<number> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  let taken = 0

  const shoot = async (name: string, path: string, full = false) => {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' })
    const file = join(outDir, `${name}.${viewport.name}.png`)
    await page.screenshot({ path: file, fullPage: full })
    console.log(`  ${viewport.name.padEnd(7)} ${name}`)
    taken++
  }

  // Signed-out shots first, before the session exists.
  for (const shot of SHOTS.filter((s) => !s.auth)) {
    await shoot(shot.name, shot.path, shot.full)
  }

  await signIn(page)

  for (const shot of SHOTS.filter((s) => s.auth)) {
    await shoot(shot.name, shot.path, shot.full)
  }

  // The detail page id depends on the seed profile, so discover it rather than
  // hard-coding dev-0001 and silently shooting a 404 on a reseed.
  const listing = await firstListingPath(page)
  if (listing) {
    await shoot('detail', listing, true)
    await shoot('detail-gallery', listing)
  } else {
    console.log(`  ${viewport.name.padEnd(7)} (no listings — skipped detail)`)
  }

  await context.close()
  return taken
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let out = '.shots'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i] ?? out
    else if (argv[i]?.startsWith('--out=')) out = argv[i]!.slice('--out='.length)
  }

  await mkdir(out, { recursive: true })
  console.log(`capturing ${BASE_URL} → ${out}/`)

  const browser = await chromium.launch()
  try {
    let total = 0
    for (const viewport of VIEWPORTS) {
      total += await capture(browser, viewport, out)
    }
    console.log(`\n${total} screenshots written to ${out}/`)
  } finally {
    await browser.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
