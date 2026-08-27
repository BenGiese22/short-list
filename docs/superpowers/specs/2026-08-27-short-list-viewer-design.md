# short-list: hosted viewer design

## Context

`home-search` (sibling repo, `~/code/home-search`) scrapes, scores, and photo-analyzes
real-estate listings into a local SQLite file (`data/listings.db`) plus local photo
JPGs (`data/photos/<listing_id>/*.jpg`). It's a personal, single-machine pipeline —
nothing about it is hosted or reachable off Ben's laptop today.

This spec covers **`short-list`**: a small, hosted, read-only web app that lets Ben and
Megan browse the pipeline's output — ranked listings, filters, search, photos, and the
full score breakdown — from any device, without either of them needing to be on Ben's
machine or home network. Design direction (layout, density, badges, sort options) was
approved via two clickable HTML mockups reviewed in chat; this spec implements the
**"Dense"** variant.

Two architecture decisions were made before this spec, both confirmed with Ben:

1. **Data hosting**: a new one-way sync script (`publish.py`, in `home-search`) pushes
   the local SQLite DB to **Turso** (libSQL — wire-compatible with SQLite, a first-party
   Vercel Marketplace integration) and local photos to **Vercel Blob**, run manually
   whenever Ben wants the hosted view refreshed. `home-search`'s actual scrape/score
   pipeline is untouched — zero risk to it.
2. **Access control**: a shared-passcode gate (`proxy.ts` + a signed cookie), no IP
   restriction — chosen specifically so Megan can open the site from any device,
   on or off the home network. The data itself isn't sensitive, but the pipeline that
   produces it touches Ben's Compass.com login, so the site stays off search engines
   and out of casual reach rather than fully public.

## Goals

- A ranked, searchable, filterable list view and a per-listing detail view, matching
  the approved "Dense" mockup's layout, badges, and interactions exactly (see
  "Feature parity with the mockup" below).
- Sortable by composite score, each individual sub-score (commute/sqft/condition/
  outdoor/room-count/parking), value-per-$100k, and price — same as the mockup.
- Every listing card links out to the original Compass.com listing, not just the
  detail page.
- Staging warnings and garage-attached/detached are visually prominent facts, not
  buried — carried over from the mockup's design intent.
- A listing missing `scores` or `visual_scores` rows (photo scoring not yet run, or
  a fresh scrape not yet re-synced) degrades gracefully to a "not yet scored" state,
  never a crash.
- `home-search`'s own pipeline (`scrape.py`, `check.py`, `compute_commutes.py`,
  `score.py`, `score_photos.py`) is not modified in any way.
- Hosted on Vercel, gated by a shared passcode, reachable from any device/network.

## Non-goals

- No user accounts or third-party auth — one shared passcode for both of you.
- No live/bidirectional sync. `publish.py` is one-way (local → cloud) and manually
  triggered; the app never writes back to Turso or to `home-search`.
- No listing feedback/voting (upvote/downvote scores). That idea is real and was
  discussed, but explicitly deferred — Ben is writing up the six-house tour feedback
  first, and any vote feature is its own future spec.
- No rate-limiting or lockout on the passcode gate. Personal, two-user scale; keep it
  simple per Ben's "firm within reason" bar, not bank-grade.
- No photo re-processing (cropping, thumbnails, format conversion) beyond what
  `next/image` and Vercel Blob already give for free.
- No CI beyond Vercel's standard git-push preview/production deploys.

## Feature parity with the mockup

Carried over from the approved "Dense" HTML mockup, unchanged:

- List: search box (address/city substring), sort dropdown (8 options above), a
  "Passes cutoffs" filter chip, "Staging flagged" filter chip, "Not yet scored" filter
  chip.
- Card: thumbnail, composite score pill, 6-bar mini score-equalizer with weight %
  labels, value-per-$100k chip, badge row (staging / below-cutoff / pending / garage
  attached-or-detached / estimated-data), address/price/beds/baths/sqft, a Compass
  link.
- Detail: photo gallery + thumbnail strip, staging alert box (only if flagged),
  cutoff alert box (only if failing), quick-facts stat strip, composite score + gauge,
  full 6-factor score breakdown with weights, a facts grid (garage / staging / floor
  plan / data quality), description, amenities, a sticky "Open on Compass" CTA.

## Architecture

```
home-search (existing, Python)                    short-list (new, Next.js/TS)
──────────────────────────────                     ─────────────────────────────
scrape.py / check.py / score.py /                  proxy.ts (passcode gate)
score_photos.py  →  data/listings.db                     ↓
        │            data/photos/*.jpg              app/page.tsx (list)
        ↓                                            app/listing/[id]/page.tsx
   publish.py (new)  ────────────────→  Turso   ←────┘  lib/db.ts, lib/queries.ts
        │                              (DB mirror              ↑ 'use cache'
        └──────────────→ Vercel Blob   + hosted_photos)         │
                          (photo files)                app/api/revalidate/route.ts
                                 ↑                              ↑
                                 └──────────── publish.py's last step calls this
```

### Turso (DB)

`publish.py` mirrors `home-search`'s existing SQLite schema into Turso exactly as-is
— `listings`, `amenities`, `photo_urls`, `commute`, `scores`, `visual_scores` — no
column renames, no dialect changes, since libSQL is SQLite-wire-compatible. A full
upsert of every row on every run (not incremental diffing) — at ~115 listings this is
cheap and matches this project's existing "cheap to just redo" precedent
(`scrape.py`'s full re-fetch, `score.py`'s full rescore).

One new table exists **only in Turso**, not in local SQLite (it's a sync artifact, not
pipeline data):

```sql
CREATE TABLE IF NOT EXISTS hosted_photos (
    listing_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    blob_url TEXT NOT NULL,
    PRIMARY KEY (listing_id, position)
);
```

### Vercel Blob (photos)

`publish.py` uploads each local photo not yet in `hosted_photos` to
`photos/<listing_id>/<NN>.jpg` (public access — matches the mockup's plain `<img>`
usage, and nothing here is sensitive), records the resulting URL, and skips any photo
already uploaded on a rerun (idempotent, safe to interrupt).

### `publish.py` (new, in `home-search`)

Mirrors the shape of `compute_commutes.py`/`score_photos.py`: a manually-run,
top-level orchestration script, safe to rerun, log-and-continue on a single
listing/photo failure rather than aborting the whole sync.

1. Connect to local `data/listings.db` and to Turso (`TURSO_DATABASE_URL` /
   `TURSO_AUTH_TOKEN`).
2. Ensure the Turso schema exists (idempotent `CREATE TABLE IF NOT EXISTS` for every
   mirrored table plus `hosted_photos`).
3. Upsert every row of every pipeline table into Turso.
4. For each listing, for each local photo not yet in `hosted_photos`: upload to Vercel
   Blob (`BLOB_READ_WRITE_TOKEN`, plain `requests` PUT against Blob's REST API — no
   Node dependency needed), upsert the returned URL.
5. POST to `short-list`'s revalidate endpoint (`SHORT_LIST_URL` + `REVALIDATE_SECRET`)
   so the hosted site shows fresh data immediately rather than waiting out the cache
   window.
6. Print a short summary (rows synced, photos uploaded, any failures).

No test file, matching `score.py`/`compute_commutes.py`'s existing untested-
orchestration precedent — the logic worth testing (idempotency: "already uploaded,
skip") is simple enough to eyeball, and the real network calls aren't unit-testable
without an integration environment this project doesn't have.

### `short-list` app (new Next.js 16, App Router, TypeScript)

- **`proxy.ts`**: reads a signed session cookie. Missing/invalid → redirect to
  `/enter`. `/enter` posts a passcode to a server action; correct passcode (compared
  against `SITE_PASSCODE`) sets an httpOnly, secure, `sameSite=lax` cookie signed with
  `COOKIE_SECRET` (HMAC, stateless — no session store needed), ~90-day expiry so
  Megan enters it once per device. Wrong passcode re-renders `/enter` with an inline
  error, no lockout.
- **`lib/db.ts`**: lazy `getDb()` over `@libsql/client` (module-level lazy `let`, not
  a Proxy wrapper and not a top-level throwing call — avoids the build-time crash and
  the Proxy/adapter footgun both called out in Vercel's own storage guidance).
- **`lib/queries.ts`**: `getListings(params)` builds one parameterized SQL query from
  URL `searchParams` (search substring, sort key, cutoffs-only/staging/pending
  filters) mirroring the mockup's `getVisible()` logic exactly; `getListing(id)` joins
  `listings` + `amenities` + `commute` + `scores` + `visual_scores` +
  `hosted_photos` for one listing. Both wrapped in `'use cache'` with `cacheTag('listings')`
  and a `cacheLife` of a few hours — `publish.py`'s `revalidateTag` call makes a fresh
  sync visible immediately regardless of that window.
- **`app/page.tsx`** / **`app/listing/[id]/page.tsx`**: Server Components, no client
  data-fetching library. Filter/sort/search state lives entirely in `searchParams` —
  bookmarkable, shareable, no client state management.
- **`app/api/revalidate/route.ts`**: POST-only, checks a shared secret
  (`REVALIDATE_SECRET`) against a header, calls `revalidateTag('listings')`.
- Styling ports the mockup's existing hand-written CSS (custom-property tokens, the
  same class structure) directly into global CSS — no new styling dependency
  (Tailwind, component library) introduced, since the mockup is already a complete,
  approved design system and re-implementing it in a different styling approach would
  be pure risk with no benefit.
- Photos render via `next/image` against the `hosted_photos` Blob URLs.

## Config

**`short-list`** (Vercel project env vars): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
(read-only token), `SITE_PASSCODE`, `COOKIE_SECRET`, `REVALIDATE_SECRET`.

**`home-search`** (`.env` additions, local-only, never committed):
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (read-write token — distinct from the app's
read-only one), `BLOB_READ_WRITE_TOKEN`, `SHORT_LIST_URL`, `REVALIDATE_SECRET` (must
match the value set on Vercel).

## Error handling

- `publish.py`: a single row-upsert or photo-upload failure logs and continues,
  matching every other orchestration script in `home-search`. A revalidate-call
  failure at the end logs a warning but doesn't fail the sync — the cache just
  expires naturally instead of updating immediately.
- `short-list` list/detail queries: a listing with no `scores` row (not yet scored)
  or no `visual_scores` row (photo scoring not run / below the photo floor) renders
  the mockup's existing "pending" states — never a thrown error from a missing join.
- Passcode gate: wrong passcode is a normal re-render with an inline message, not an
  error page.

## Testing

- `short-list`: unit tests for `lib/queries.ts`'s filter/sort SQL-building logic (the
  one place a real bug could hide) against a local libSQL file (in-memory or
  `tmp_path`-style), matching `home-search`'s own "pure logic gets tests, thin network
  wrappers don't" convention. No e2e tests, given the two-user personal scale.
- `publish.py`: no test file, per the precedent noted above.

## Open questions (not blocking this spec)

- Listing feedback/voting (upvote/downvote, per-person) — real idea, explicitly
  deferred until after the six-house tour write-up is done; its own future spec.
- Whether `publish.py` should eventually run on a schedule (cron) rather than
  manually — deliberately out of scope; manual is the whole point of "zero risk to
  the pipeline you just got running."
