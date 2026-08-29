# The Short List

A private, passcode-gated viewer for ranked home listings produced by the
[home-search](../home-search) pipeline. It shows Ben & Megan's Front Range
search results — sortable, filterable, with per-listing detail and photos —
reading from a Turso (libSQL) mirror that `publish.py` keeps in sync with the
pipeline's local SQLite database.

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | Turso database URL the app reads from. |
| `TURSO_AUTH_TOKEN` | Turso auth token. Use the **read-only** token here — `publish.py` uses a separate read-write token to sync data. |
| `SITE_PASSCODE` | Passcode required to enter the site. |
| `COOKIE_SECRET` | Secret used to sign the session cookie issued after a correct passcode. |
| `REVALIDATE_SECRET` | Shared secret `publish.py` sends to `/api/revalidate` after a sync, so the viewer picks up fresh data without waiting for cache expiry. |

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
the passcode gate until you enter `SITE_PASSCODE`.

## How data gets here

This app never scrapes or scores listings itself. The `home-search` pipeline
does that against a local SQLite database, and its `publish.py` script mirrors
the relevant tables (and listing photos) into Turso and Vercel Blob, then
calls this app's `/api/revalidate` endpoint so pages regenerate with the new
data. This site only reads from Turso — it never writes back to the pipeline.
