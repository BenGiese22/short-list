# Local development environment — design

**Original Author:** Benjamin Giese
**Date:** 2026-09-05
**Status:** Approved for planning

## Problem

The viewer has no way to run outside production. Reviewing a UI change — PR #7,
the expiring share links, is the case that prompted this — means reading a diff
and imagining the result. There is no environment to open, click through, or
show to anyone.

Two things block one today. The app reads a Turso mirror that only
`home-search/publish.py` populates, and it renders photos from Vercel Blob URLs
that require production credentials. Both are remote, both are shared, and
neither belongs in a loop that should be `docker compose up`.

## Goals

Run the whole viewer on `localhost:3100` from a clean checkout, with no cloud
credentials and no network. Seed it with data that looks like production and,
on demand, with data that is deliberately hostile. Move between git branches
without rebuilding. Capture screenshots for a PR.

## Non-goals

Access control is not part of this. The site is personal: guests see what the
owners see, the owner role carries no privileges, and acting on a listing
requires a Compass login the site never holds. The environment therefore builds
no role-switching tooling and no token minting. The owner view is the default
after entering the dev passcode; the guest view is one Share click and a private
window; the failure state is `/enter?error=link` typed into the address bar.

Production parity beyond the UI is also out of scope. `vercel.json` crons are a
platform feature that `next dev` never fires, so `/api/pipeline/*` is inert
locally with no work required.

## Key constraint discovered

`lib/db.ts` builds its client from `TURSO_DATABASE_URL` and passes
`TURSO_AUTH_TOKEN` straight through. `@libsql/client` accepts a `file:` URL and
ignores the token when it sees one, verified directly:

```
createClient({ url: 'file:/tmp/probe.db', authToken: 'ignored-token' })
  → OK, {"c":1}
```

**Almost no application code changes.** Nothing under `app/` or `lib/` is
touched. One line is added to `next.config.ts` — see "As built" — and it is
gated on an environment variable only `docker/env.dev` sets.

## Schema: mirror, not local

The seed must build the **Turso mirror** schema, which differs from
`home-search`'s local SQLite in the one place that matters for the UI.
`lib/queries.ts:88` joins:

```sql
(SELECT hp.blob_url FROM hosted_photos hp WHERE hp.listing_id = l.listing_id
 ORDER BY hp.position LIMIT 1) AS thumbnail_url
```

`hosted_photos(listing_id, position, blob_url, source_url)` is created by
`home-search/src/turso_db.py` and exists only in the mirror. Local
`listings.db` has `photo_urls(listing_id, position, url)` instead. Seeding the
local shape produces a site with no photos anywhere and no error to explain it.

Tables the app reads: `listings`, `scores`, `visual_scores`, `commute`,
`amenities`, `hosted_photos`.

## Architecture

```
docker/
  Dockerfile.dev        node:24-slim, npm ci, next dev
  Dockerfile.shots      playwright + chromium, built on demand
  run.sh                the driver the npm scripts call
  entrypoint.sh         seed if needed, then next dev
  env.dev               committed dev defaults (no secrets)
  empty-env             masks the host .env.local inside the container
scripts/seed/
  profile.ts            one-off: home-search db → fixtures/distributions.json
  anonymize.ts          one-off: home-search db → fixtures/dev-seed-realistic.db
  generate.ts           deterministic generator, SEED_PROFILE-driven
  photos.ts             assigns public/dev-photos/* into hosted_photos
  schema.ts             the mirror DDL, transcribed from src/turso_db.py
  index.ts              npm run seed
fixtures/
  dev-seed-realistic.db ~200 KB, committed
  distributions.json    committed profile of the real data
public/dev-photos/      10 webp, ~500 KB
scripts/shots.ts        screenshot capture
docs/DEV-ENVIRONMENT.md
```

`profile.ts` and `anonymize.ts` run once, against a database that exists only on
Ben's machine. Their **outputs** are committed; a clean checkout never needs
`home-search` present.

## Running

The repo is bind-mounted and `node_modules` / `.next` are anonymous volumes, so
the container's Linux binaries never collide with the host tree. `git checkout`
on the host hot-reloads the container — no rebuild to move between a PR branch
and `main`.

```bash
npm run dev:docker      # → http://localhost:3100, passcode 1234
```

`docker/env.dev` is committed and holds only throwaway values: `SITE_PASSCODE=1234`,
a fixed `COOKIE_SECRET` labelled as dev-only, a fixed `REVALIDATE_SECRET` that
live reseed reuses, `TURSO_DATABASE_URL=file:/data/dev.db`, and a
`TURSO_AUTH_TOKEN` that is never read.

The filename has **no leading dot** on purpose. `.gitignore` carries `.env*`
with a single `!.env.example` exemption, so a file named `.env.dev` would be
silently untracked and every clean checkout would fail to boot.

`/data` is a named volume, so the database survives restarts while
`docker compose down -v` resets it.

## A production-build profile

`next dev` is the default because hot reload is what makes branch-hopping cheap.
But `next.config.ts` sets `cacheComponents: true`, and under Cache Components a
dev server and a production build do not agree: dev is forgiving about Suspense
boundaries and prerendering that `next build` rejects. A component can render
correctly at `localhost:3100` and still fail to build.

PR #7 is exactly this case — it mounts `ShareControl` behind its own `<Suspense>`
specifically to satisfy that constraint, and its test plan leans on
`npm run build` to prove it.

So a second compose profile runs `next build && next start` against the same
seeded database:

```bash
npm run dev:docker:prod     # → http://localhost:3101
```

Slower, no hot reload, and it surfaces build-time failures a dev server hides.
Worth running once before approving any PR that touches rendering.

## Seed profiles

`SEED_PROFILE` selects the dataset. The entrypoint seeds `/data/dev.db` when it
is missing or when the recorded profile differs from the requested one.

| Profile | Contents | Purpose |
| --- | --- | --- |
| `realistic` (default) | the anonymized 84-listing fixture | does this look right |
| `edge-cases` | ~30 generated listings, every awkward state | does this break |
| `empty` | 0 listings | the empty state |
| `huge` | 500 generated listings | scrolling and render cost |

### What `realistic` actually covers

Measured against `home-search/data/listings.db`, the real data is narrow:

- 84 listings, all $480,000–$675,000, 1,176–3,177 sqft
- composite scores 44.3–76.6 (a ~100 scale, not 0–1); 73 of 78 pass filters
- exactly **one** NULL `hoa_annual`, **one** NULL `tax_annual`, **one** missing
  `sqft_above_grade`
- 34 of 84 with no basement
- every listing has photos — 9 to 50, averaging 34
- 30 suspected unwatermarked staging, 7 watermarked, 2 with photo scoring
  unavailable
- 8 of 84 with a failed geocode and therefore NULL `denver_minutes`

One production state it carries for free: **84 listings but only 78 `scores`
and `visual_scores` rows**, so six listings exercise the `LEFT JOIN` NULL path
that `app/page.tsx` and the detail view must survive.

Anonymization scrambles addresses to generated street names, jitters prices ±7%,
replaces descriptions with generated prose, and rewrites `listing_url` to
`example.com`. Scores, commute figures, and visual flags are preserved exactly —
they are the part worth keeping honest, and they identify nothing.

### What `edge-cases` adds

Everything the real data has too little of, all deterministic under a fixed RNG:

- a listing with **zero** photos, and one with 60
- both `tax_annual` and `hoa_annual` NULL together, so the `cost` sort's
  `NULLS LAST` branch has something to sort
- `sqft_above_grade` **absent as a column value** — `lib/facts.ts` treats NULL
  and `undefined` alike and both paths need a row
- `sqft_below_grade` present and 0, the confirmed-no-basement encoding
- a finished-area shortfall past `SQFT_TOLERANCE`, triggering the explanatory
  sub-line
- `photo_score_unavailable = 1`, `watermarked_staging_detected = 1`, and
  `suspected_unwatermarked_staging = 1` in isolation and together
- missing `scores` row, missing `visual_scores` row, missing `commute` row
- `passes_filters = 0` and `has_incomplete_data = 1`
- a 90-character address (the real maximum is 38) and a one-word address
- `price_numeric` of 0 and NULL, which the `value` sort divides by
- 0 amenities and 44 amenities
- prices far outside the real band, at $180,000 and $3,400,000

## Photos

Ten images from `home-search/data/photos`, downscaled to webp and committed to
`public/dev-photos/`, covering the Compass taxonomy: front, living, kitchen,
primary bedroom, bath, basement, backyard, garage, aerial, floorplan. Mixed
aspect ratios — one portrait, one wide, one square — because uniform 3:2 images
would hide real layout problems in the gallery.

`blob_url` holds a same-origin path, `/dev-photos/03-kitchen.webp`, so
`next/image` serves them with no change to `remotePatterns` in `next.config.ts`
(which allows only `*.public.blob.vercel-storage.com`). The front exterior is
always `position` 0, since that is what the list thumbnail subquery reads.

`docs/DEV-ENVIRONMENT.md` records that these came from real Compass listings and
are committed for local development in a private repo, not for redistribution.

## Live reseed

```bash
npm run dev:seed -- --profile edge-cases
```

Execs into the running container, rebuilds `/data/dev.db`, then POSTs
`/api/revalidate` with the dev secret so Next drops its `use cache` entries —
`getListings` and `getListing` both call `cacheLife('hours')`, so without the
ping a reseed is invisible until the cache ages out. Seconds, and the session
cookie survives.

## Screenshot capture

```bash
npm run dev:shots -- --out .shots/pr7
```

A Playwright container walks a fixed route list at 1440×900 and 390×844, writing
PNGs to a gitignored folder. The route list lives in `scripts/shots.ts` and
covers the list view, each sort, each filter, a detail page, the gallery, and
the enter page. Running it once per branch produces the before/after pair for a
PR description.

Playwright and its browser dependencies live in a **separate image**, built on
first use, so the everyday dev image stays small.

## Testing

The seed scripts are ordinary TypeScript and get ordinary vitest coverage, in
the repo's existing style of testing the data layer and leaving pages untested:

- `generate.ts` is deterministic — the same seed produces byte-identical output
- every profile satisfies the app's queries: `buildListingsQuery` runs against
  each seeded database for every `SortKey` without error and returns rows
- `edge-cases` actually contains each state it claims to; the test asserts the
  specific rows exist rather than trusting the generator
- `photos.ts` puts the front exterior at position 0 for every listing that has
  photos at all

The environment itself is verified by using it: `docker compose up`, then the
list view, a detail page, and the gallery all render.

## Risks

**The fixture drifts from the mirror schema.** `src/turso_db.py` is the source
of truth and lives in another repo. If a migration adds a column there,
`schema.ts` goes stale and the dev environment diverges from production
silently. Mitigated by transcribing the DDL with a comment naming the file and
commit it came from, and by `lib/facts.ts` already being written to survive
columns that are absent entirely.

**`realistic` inspires false confidence.** It is narrow by construction. The
`edge-cases` profile is not optional polish; it is where UI bugs will surface.

## As built

Differences between this design and the delivered environment, and why.

**Compose was dropped.** The Compose plugin is not installed on this machine
(`/usr/libexec/docker/cli-plugins/` holds only `docker-trust`, and there is no
standalone `docker-compose`). Rather than require an install before the first
run, `docker/run.sh` drives plain `docker build` / `docker run`, and the npm
scripts call it. Three independent containers sharing one named volume did not
need Compose.

**`next.config.ts` gained one gated line.** `images.unoptimized` is switched on
by `DEV_UNOPTIMIZED_IMAGES=1`, which only `docker/env.dev` sets. This is not
cosmetic — the environment does not work without it. In production `blob_url`
is an absolute Vercel Blob URL, so the image optimizer fetches it directly and
never meets `proxy.ts`. Locally `blob_url` is `/dev-photos/*.webp` under
`public/`, which the proxy matcher gates like any other path, and the
optimizer's *internal* fetch carries no session cookie: it gets the `/enter`
redirect and fails with "The requested resource isn't a valid image." Excluding
`/dev-photos` from the matcher was rejected because that change ships to
production and would publish ten real house photos unauthenticated.

**The host `.env.local` is masked inside the container.** Not anticipated, and
a security matter rather than a tidiness one: the bind mount exposed the real
`TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN` and `VERCEL_OIDC_TOKEN` to a
container whose whole purpose is to touch nothing real. Next loads `.env.local`
automatically, so an empty file is bind-mounted over it.

**`tsconfig.json` excludes `scripts/`.** `next build` type-checks with the app's
config, and these scripts run under Node's native type stripping, which needs
the explicit `.ts` import extensions that `moduleResolution: "bundler"`
rejects. `scripts/tsconfig.json` checks them separately
(`npx tsc -p scripts --noEmit`). Found by the production-build profile on its
first run, which is a fair advertisement for having it.

**Sizes.** `public/dev-photos/` is ~970 KB rather than ~500 KB, and
`fixtures/dev-seed-realistic.db` ~460 KB rather than ~200 KB. Foliage-heavy
exteriors compress poorly and pushing quality lower started showing artifacts.

**The taxonomy lost the garage.** The garage shot in the source listing is
another front-of-house view, near-identical to `01-front` once cropped. It was
replaced with a fireplace room, which is actually distinguishable at thumbnail
size. The floorplan had the real street address printed across its top margin;
that band is cropped off.

**Measured corrections.** The longest real address is 26 characters, not 38
(38 was address plus city). Real `year_built` runs 1953–2005. Both are recorded
in `fixtures/distributions.json` and reflected in the generator.

## Found by building it

The environment immediately surfaced a pre-existing issue it was not looking
for: the dev overlay reports one React error per listing, "Only plain objects
can be passed to Client Components from Server Components", labelled `Cache`.
`getListings` is a `use cache` function returning `result.rows` directly, and a
libSQL row is not a plain object — it carries a non-enumerable `length` and
non-enumerable numeric indices.

Both drivers construct rows identically (`rowFromSql` in `@libsql/client`,
`rowFromProto` in `@libsql/hrana-client`), so this happens against production
Turso too. It is a dev-only warning and pages render correctly, but it puts 84
errors behind the devtools badge while reviewing. Mapping rows to plain objects
in `lib/queries.ts` would fix it. Left alone here: it is application code, and
outside what this work was asked to change.

## Open decisions deferred

None. Data source, photo source, extras, and scope are settled.
