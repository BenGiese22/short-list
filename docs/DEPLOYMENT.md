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

Turso is a Marketplace integration; **Blob is first-party and is NOT** — `vercel
integration add blob` fails with "No integration found matching blob".

```bash
vercel integration add turso              # opens a browser to accept Turso's terms,
                                          # then re-run this command to finish
vercel blob create-store short-list-photos --access public --yes
```

Turso sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; the Blob store sets
`BLOB_READ_WRITE_TOKEN`. Photos must be `--access public`: the app serves them through
`next/image` against plain URLs and implements no signed-URL flow, so a private store
would render nothing.

## 3. Set the remaining app secrets

```bash
vercel env add SITE_PASSCODE production      # the passcode you and Megan will type
vercel env add COOKIE_SECRET production      # openssl rand -hex 32
vercel env add REVALIDATE_SECRET production  # openssl rand -hex 32
vercel env add SHARE_KEY_VERSION production  # optional; "1" -- bump to kill all share links
```

`COOKIE_SECRET` signs the session cookie *and* every share link. Rotating it logs
everyone out and kills every link — use it if the secret itself may have leaked. For
the lighter case of "a share link got forwarded further than I wanted", bump
`SHARE_KEY_VERSION` instead: every outstanding link dies, and you and Megan re-enter
the passcode once. There is no per-link revocation by design (no server-side state;
the app's Turso token is read-only).

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

Then, as the passcode session, use "Share for 24 hours → Create link", open the link in
a private window, and confirm it shows the list *without* the share control. Its cookie
should expire when the link does, not in 90 days.

## Known trade-offs, decided deliberately

- **Share links are stateless bearer tokens.** Anyone holding an unexpired link can view
  the list and can forward the link; the only controls are the expiry you picked
  (24h/7d/30d) and the all-or-nothing `SHARE_KEY_VERSION` bump. Deploying the
  share-link change invalidated every previously issued session cookie once (the payload
  format changed); that was accepted rather than carrying a dual-format grace period in
  a security module.

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
