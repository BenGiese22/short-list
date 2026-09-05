# Running the viewer locally

A containerised copy of the site with seeded data and local photos. No Turso
account, no Vercel credentials, no network.

```bash
npm run dev:docker      # → http://localhost:3100, passcode 1234
```

First run builds the image and seeds the database (about a minute). After that
it starts in seconds.

## Reviewing a branch

The repo is bind-mounted, so the container follows your checkout:

```bash
git checkout bgiese/expiring-share-links
# the running container hot-reloads — no rebuild, no restart
```

To capture before/after images for a pull request, run the screenshot pass on
each branch and compare the folders:

```bash
git checkout main                       && npm run dev:shots -- .shots/main
git checkout bgiese/expiring-share-links && npm run dev:shots -- .shots/pr7
```

## Seeing owner and guest views

There is no role-switching tool, because none is needed:

| View | How |
| --- | --- |
| Owner | The default. Enter the passcode. |
| Guest | Click Share as the owner, open the link in a private window. |
| Bad or expired link | Visit `/enter?error=link` directly. |

The guest path is the real redemption flow, which is the point — it exercises
`/s/<token>` end to end rather than a stand-in for it.

## Seed profiles

```bash
npm run dev:seed -- edge-cases    # swap datasets in a couple of seconds
```

This reseeds the running container and pings `/api/revalidate` so Next drops
the cached queries. Without that ping the change stays invisible for an hour,
because `getListings` and `getListing` both use `cacheLife('hours')`.

| Profile | Contents | For |
| --- | --- | --- |
| `realistic` (default) | 84 anonymized real listings | does this look right |
| `edge-cases` | 30 listings, every awkward state | does this break |
| `empty` | nothing | the empty state |
| `huge` | 500 listings | scrolling and render cost |

**`realistic` looks right but proves little.** The real data is narrow: every
listing is priced $480k–$675k, exactly one has an unknown HOA, one an unknown
tax, one a missing above-grade square footage, and every single one has at
least nine photos. It does carry one production state for free — 84 listings
against only 78 `scores` rows, so six listings exercise the `LEFT JOIN` NULL
path.

**`edge-cases` is where UI bugs surface.** Each listing names its own case in
the address (`8034 Simms St — price is zero`), so what you are looking at is
never a guess. It covers zero photos and sixty photos, tax and HOA both
unknown, missing above-grade square footage, a confirmed no-basement listing,
finished-area shortfalls either side of `SQFT_TOLERANCE`, each staging flag
alone and both together, missing `scores` / `visual_scores` / `commute` rows,
failed geocodes, a zero price, an unknown price, prices far outside the real
band, a 78-character address, a one-word address, and a listing with all 44
amenities.

## Checking a production build

`next dev` and `next build` disagree under Cache Components: dev is forgiving
about Suspense boundaries and prerendering that a real build rejects. A
component can render correctly at `:3100` and still fail to ship.

```bash
npm run dev:docker:prod     # → http://localhost:3101
```

Slower, no hot reload, and it type-checks the whole repo. Worth one run before
approving any PR that touches rendering.

## Everything else

```bash
npm run dev:stop      # stop the containers
npm run dev:reset     # stop, and delete the seeded database
npm run seed          # seed a database outside docker (--out, --profile)
./docker/run.sh build # force an image rebuild
```

`DEV_PORT` and `PROD_PORT` override the ports.

## How it works, and the parts that will surprise you

`lib/db.ts` needs no development branch. `@libsql/client` accepts a `file:` URL
and ignores `TURSO_AUTH_TOKEN` when it sees one, so `docker/env.dev` simply
points `TURSO_DATABASE_URL` at `file:/data/dev.db`.

**The seed builds the mirror schema, not `home-search`'s local one.** The
viewer reads `hosted_photos(listing_id, position, blob_url)`, which exists only
in Turso — `home-search`'s local SQLite stores photos in `photo_urls` instead.
Seeding the local shape gives you a site with no images anywhere and nothing in
the logs to explain it. `scripts/seed/schema.ts` transcribes the mirror DDL and
names the upstream commit it came from.

**Your `.env.local` is deliberately hidden from the container.** It holds the
real `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN` and `VERCEL_OIDC_TOKEN`, and
the bind mount would otherwise hand all three to a throwaway environment. It is
masked with an empty file, so the container can only ever reach its own local
database.

**Images are served unoptimized locally**, via `DEV_UNOPTIMIZED_IMAGES=1`. In
production every photo is an absolute Vercel Blob URL that the image optimizer
fetches directly. Locally the seed points `blob_url` at `/dev-photos/*.webp`
under `public/`, which `proxy.ts` gates like any other path — and the
optimizer's internal fetch carries no session cookie, so it receives the
`/enter` redirect and fails with "The requested resource isn't a valid image."
Serving the originals sidesteps that. Layout is unaffected; only the bytes on
the wire differ. The alternative, excluding `/dev-photos` from the proxy
matcher, would ship to production and publish those photos unauthenticated.

## Known noise

The dev overlay reports one error per listing:

> Only plain objects can be passed to Client Components from Server
> Components.

This is pre-existing and not caused by the local setup. `getListings` is a
`use cache` function returning `result.rows` directly, and a libSQL row is not
a plain object — it carries a non-enumerable `length` and non-enumerable
numeric indices. Both the local and remote drivers build rows identically
(`rowFromSql` in `@libsql/client`, `rowFromProto` in `@libsql/hrana-client`),
so this happens against production Turso too; it is simply invisible without a
way to run the app. It is a dev-only warning and the page renders correctly.

Mapping the rows to plain objects in `lib/queries.ts` would silence it.

## Regenerating the fixtures

These need `~/code/home-search` checked out and are **not** part of normal
setup — their outputs are committed.

```bash
node scripts/seed/profile.ts        # → fixtures/distributions.json
node scripts/seed/anonymize.ts      # → fixtures/dev-seed-realistic.db
node scripts/seed/extract-photos.ts # → public/dev-photos/
```

`anonymize.ts` keeps every score, commute time and visual flag exactly as
computed, and destroys everything that points at a real house: listing ids,
addresses, exact prices, descriptions, URLs, coordinates, and the raw
vision-model responses. City and ZIP survive, because four Front Range towns
identify nothing.

The ten photos in `public/dev-photos/` are real Compass listing photos, kept
here for local development in a private repo. They are not for redistribution.
