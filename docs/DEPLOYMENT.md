# short-list — provisioning and first deploy

This is the plan's **Task 9**, which was deliberately not executed: every step below is
interactive, provisions real cloud resources, or publishes a public site. Those are your
calls to make, not an agent's. Run them yourself in this order.

Everything else in the plan is done. The code is written, reviewed, and green
(`npm test` 20/20, `tsc` clean, `npm run build` clean, `pytest` 207 passing) — but
**nothing has ever run against a real service.** This runbook is where that first
contact happens, so expect to find things here that no test could catch.

## Before you start

You need the Vercel CLI on your PATH. `publish.py` shells out to `vercel blob put` for
every photo and now preflights for it, so a missing CLI fails fast with a clear message
instead of 3000 silent per-photo failures.

```bash
vercel --version      # 59.5.0 worked during development; newer is fine
```

## 1. Create the Vercel project

```bash
cd ~/code/short-list
vercel link
```

## 2. Provision Turso and Blob

```bash
vercel integration add turso
vercel integration add blob
```

These set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `BLOB_READ_WRITE_TOKEN` as
project env vars.

## 3. Set the remaining app secrets

```bash
vercel env add SITE_PASSCODE production      # the passcode you and Megan will type
vercel env add COOKIE_SECRET production      # openssl rand -hex 32
vercel env add REVALIDATE_SECRET production  # openssl rand -hex 32
```

`COOKIE_SECRET` signs the session cookie — rotating it logs everyone out, which is your
revocation mechanism if a passcode ever leaks.

## 4. Deploy

```bash
vercel env pull .env.local
vercel deploy --prod
```

## 5. Wire up `home-search`

Add to `~/code/home-search/.env` (never committed — see `.env.example`):

```
TURSO_DATABASE_URL=      # same database as the app
TURSO_AUTH_TOKEN=        # READ-WRITE token — distinct from the app's
BLOB_READ_WRITE_TOKEN=   # from step 2
SHORT_LIST_URL=          # the deployed URL
REVALIDATE_SECRET=       # must match step 3 exactly
```

**Use two different Turso tokens.** The app only ever reads, so give it a read-only
token; `publish.py` needs read-write. Issue the second with `turso db tokens create`.
The app's token being read-only is the thing that makes a compromised site unable to
corrupt your data.

## 6. First sync

```bash
cd ~/code/home-search
venv/bin/python publish.py
```

Expect: a row-sync count, a prune count, a photo-upload count, and
`revalidated the hosted site`. If you see the revalidate *warning* instead, `SHORT_LIST_URL`
or `REVALIDATE_SECRET` doesn't match step 3.

**Budget real time for this.** Photo upload spawns one `vercel` process per photo at
roughly 0.6s of startup each. At ~3000 photos that is around 30 minutes before the first
run finishes, serially. Reruns are cheap — already-uploaded photos are skipped.

`publish.py` now exits non-zero if any row, listing, or photo failed, so check the exit
code rather than trusting the printed summary alone.

## 7. Verify end-to-end

Visit the deployed URL. You should be redirected to `/enter`, and the passcode should
get you in for ~90 days per device. Then confirm real listings render with real photos,
search/sort/filter work, and a listing opens its detail page and its Compass link.

## Known trade-offs, decided deliberately

- **Photo upload shells out to the Vercel CLI.** The spec asked for a plain `requests`
  PUT against Blob's REST API with no Node dependency; the implementation plan
  substituted the CLI and that is what shipped. It works, but it costs the ~30 minutes
  above and makes `vercel` an undeclared dependency that `requirements.txt` cannot
  express. Rewriting to REST is a real improvement if the sync time annoys you — it was
  left as your call rather than swapped in blind, since a hand-rolled REST client that
  has never run is its own risk.
- **A missing listing returns HTTP 200** with a "Listing not found." message rather than
  a 404 status. Under Partial Prerendering the response shell commits before the lookup
  resolves, so the status cannot be corrected. The visible behavior is right.
- **No rate limiting or lockout on the passcode**, per the spec. Rotate `COOKIE_SECRET`
  to revoke all sessions.
- **`ensure_schema` migrates added columns** on an existing mirror, but cannot add a
  `NOT NULL` column that has no `DEFAULT` — SQLite forbids it once rows exist. Every
  column added so far carries a default. If a future one doesn't, the sync will crash
  loudly rather than silently skip, which is the behavior you want.
