# Short List Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a passcode-gated Next.js viewer for `home-search`'s listing data, hosted
on Vercel, backed by a Turso mirror of the local SQLite DB and Vercel Blob for photos —
plus the small `publish.py` sync script in `home-search` that populates them.

**Architecture:** Two repos. `home-search` (existing, Python) gets one new orchestration
script (`publish.py`) plus two new testable modules (`src/turso_sync.py`,
`src/blob_upload.py`) that push its local SQLite data and photos to the cloud on
demand — the scrape/score pipeline itself is untouched. `short-list` (this repo,
Next.js 16 App Router) reads that cloud copy via Server Components with `'use cache'`,
gated by a `proxy.ts` passcode check.

**Tech Stack:** Python 3 (`turso_serverless`, `requests`, stdlib `subprocess`) for the
sync side. Next.js 16 (App Router, TypeScript, Cache Components), `@libsql/client` for
Turso reads, Vercel Blob + `next/image` for photos.

**Spec:** `docs/superpowers/specs/2026-08-27-short-list-viewer-design.md`

## Global Constraints

- `home-search`'s `scrape.py`, `check.py`, `compute_commutes.py`, `score.py`,
  `score_photos.py` are never modified.
- `publish.py` and its two support modules are the only new files in `home-search`.
- No IP restriction, no third-party auth provider, no rate limiting on the passcode
  gate — shared passcode only, per the approved spec.
- `short-list` styling ports the approved "Dense" mockup's existing CSS
  (custom-property tokens, class names) directly — no Tailwind, no component library.
- Turso schema is an exact mirror of `home-search`'s local SQLite schema (same table
  and column names) plus one Turso-only table, `hosted_photos`.
- Every new Python module with real branching logic gets unit tests against a local
  in-memory `sqlite3` connection (no live network calls in tests). Orchestration
  scripts (`publish.py` itself) stay untested, matching `home-search`'s existing
  precedent (`score_photos.py`, `compute_commutes.py`).
- Every new TypeScript data-layer function with real branching logic gets a unit test
  against a local libSQL file. No e2e tests.

---

## Phase 1 — `home-search`: sync to the cloud

### Task 1: Turso schema + row-sync helpers

**Files:**
- Create: `home-search/src/turso_sync.py`
- Test: `home-search/tests/test_turso_sync.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `TURSO_SCHEMA_EXTRA: str` (the `hosted_photos` table DDL),
  `ensure_schema(conn) -> None`, `upsert_row(conn, table: str, row: sqlite3.Row) -> None`,
  `replace_listing_rows(conn, table: str, listing_id: str, rows: list[sqlite3.Row]) -> None`.
  All three accept any DB-API-style connection (local `sqlite3.Connection` in tests,
  `turso_serverless`'s connection in production) — they only use `.execute()`.

`home-search`'s existing schema lives in `src/db.py` as the module-level string
`_SCHEMA` (leading underscore — a same-repo convention marker, not a real access
restriction). Reuse it directly rather than duplicating the DDL, so the two schemas
can never drift.

- [ ] **Step 1: Write the failing tests**

```python
# home-search/tests/test_turso_sync.py
import sqlite3

from src.db import _SCHEMA
from src.turso_sync import ensure_schema, upsert_row, replace_listing_rows


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    return conn


def test_ensure_schema_creates_every_mirrored_table_and_hosted_photos():
    conn = _connect()

    ensure_schema(conn)

    tables = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "listings", "amenities", "photo_urls", "commute", "scores",
        "visual_scores", "hosted_photos",
    } <= tables


def test_ensure_schema_is_idempotent():
    conn = _connect()

    ensure_schema(conn)
    ensure_schema(conn)  # must not raise


def test_upsert_row_inserts_using_the_source_rows_own_columns():
    source = _connect()
    source.executescript(_SCHEMA)
    source.execute(
        "INSERT INTO commute (listing_id, lat, lon, denver_miles, denver_minutes, "
        "medtronic_miles, medtronic_minutes, geocode_failed, computed_at) "
        "VALUES ('abc', 39.8, -105.1, 14.2, 24.0, 9.8, 18.0, 0, '2026-08-27T00:00:00Z')"
    )
    row = source.execute("SELECT * FROM commute WHERE listing_id = 'abc'").fetchone()

    dest = _connect()
    ensure_schema(dest)

    upsert_row(dest, "commute", row)

    result = dest.execute("SELECT * FROM commute WHERE listing_id = 'abc'").fetchone()
    assert result["denver_minutes"] == 24.0
    assert result["medtronic_minutes"] == 18.0


def test_upsert_row_replaces_existing_row_with_same_key():
    dest = _connect()
    ensure_schema(dest)
    source = _connect()
    source.executescript(_SCHEMA)

    source.execute(
        "INSERT INTO commute (listing_id, lat, lon, denver_miles, denver_minutes, "
        "medtronic_miles, medtronic_minutes, geocode_failed, computed_at) "
        "VALUES ('abc', 1, 1, 1, 1, 1, 1, 0, 't1')"
    )
    row_v1 = source.execute("SELECT * FROM commute WHERE listing_id = 'abc'").fetchone()
    upsert_row(dest, "commute", row_v1)

    source.execute("UPDATE commute SET denver_minutes = 99 WHERE listing_id = 'abc'")
    row_v2 = source.execute("SELECT * FROM commute WHERE listing_id = 'abc'").fetchone()
    upsert_row(dest, "commute", row_v2)

    rows = dest.execute("SELECT * FROM commute WHERE listing_id = 'abc'").fetchall()
    assert len(rows) == 1
    assert rows[0]["denver_minutes"] == 99


def test_replace_listing_rows_drops_stale_rows_not_in_the_new_set():
    source = _connect()
    source.executescript(_SCHEMA)
    source.execute("INSERT INTO amenities (listing_id, amenity) VALUES ('abc', 'Pool')")
    source.execute("INSERT INTO amenities (listing_id, amenity) VALUES ('abc', 'Deck')")
    old_rows = source.execute(
        "SELECT * FROM amenities WHERE listing_id = 'abc'"
    ).fetchall()

    dest = _connect()
    ensure_schema(dest)
    replace_listing_rows(dest, "amenities", "abc", old_rows)

    source.execute("DELETE FROM amenities WHERE listing_id = 'abc'")
    source.execute("INSERT INTO amenities (listing_id, amenity) VALUES ('abc', 'New roof')")
    new_rows = source.execute(
        "SELECT * FROM amenities WHERE listing_id = 'abc'"
    ).fetchall()

    replace_listing_rows(dest, "amenities", "abc", new_rows)

    result = [
        r["amenity"]
        for r in dest.execute("SELECT * FROM amenities WHERE listing_id = 'abc'")
    ]
    assert result == ["New roof"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd home-search && venv/bin/python -m pytest tests/test_turso_sync.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.turso_sync'`

- [ ] **Step 3: Write the implementation**

```python
# home-search/src/turso_sync.py
import sqlite3

TURSO_SCHEMA_EXTRA = """
CREATE TABLE IF NOT EXISTS hosted_photos (
    listing_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    blob_url TEXT NOT NULL,
    PRIMARY KEY (listing_id, position)
);
"""


def ensure_schema(conn) -> None:
    """Mirrors home-search's local SQLite schema into the given connection
    (Turso in production, plain sqlite3 in tests), plus the Turso-only
    hosted_photos table. Reuses src.db._SCHEMA directly so the two schemas
    can never drift apart."""
    from src.db import _SCHEMA

    conn.executescript(_SCHEMA)
    conn.executescript(TURSO_SCHEMA_EXTRA)
    conn.commit()


def upsert_row(conn, table: str, row: sqlite3.Row) -> None:
    """Inserts or replaces one row using its own column names -- works for
    every mirrored table that has a real primary key (listings, commute,
    scores, visual_scores), since it never hardcodes a column list."""
    columns = row.keys()
    col_list = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    values = tuple(row[c] for c in columns)
    conn.execute(
        f"INSERT OR REPLACE INTO {table} ({col_list}) VALUES ({placeholders})",
        values,
    )
    conn.commit()


def replace_listing_rows(conn, table: str, listing_id: str, rows: list[sqlite3.Row]) -> None:
    """For tables with no per-row primary key (amenities, photo_urls):
    deletes every existing row for this listing_id, then inserts the
    current set. Avoids duplicate accumulation across reruns."""
    conn.execute(f"DELETE FROM {table} WHERE listing_id = ?", (listing_id,))
    for row in rows:
        upsert_row(conn, table, row)
    conn.commit()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd home-search && venv/bin/python -m pytest tests/test_turso_sync.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
cd home-search
git add src/turso_sync.py tests/test_turso_sync.py
git commit -m "feat(sync): add Turso schema mirror and row-sync helpers"
```

---

### Task 2: Vercel Blob photo upload

**Files:**
- Create: `home-search/src/blob_upload.py`
- Test: `home-search/tests/test_blob_upload.py`

**Interfaces:**
- Consumes: nothing from other tasks (used standalone by `publish.py` in Task 3).
- Produces: `already_uploaded(conn, listing_id: str, position: int) -> bool`,
  `upload_photo(local_path: Path, listing_id: str, position: int, rw_token: str, run=subprocess.run) -> str`
  (returns the blob URL; raises `RuntimeError` on a non-zero exit).

Uploads shell out to the Vercel CLI (`vercel blob put`), which is already installed on
this machine and handles auth, retries, and multipart upload — there's no documented
raw REST endpoint worth hand-rolling. `run` is injected so tests never invoke a real
subprocess.

- [ ] **Step 1: Write the failing tests**

```python
# home-search/tests/test_blob_upload.py
import sqlite3
from pathlib import Path

from src.turso_sync import ensure_schema
from src.blob_upload import already_uploaded, upload_photo


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def test_already_uploaded_false_when_no_row_exists():
    conn = _connect()

    assert already_uploaded(conn, "abc", 1) is False


def test_already_uploaded_true_after_a_row_exists():
    conn = _connect()
    conn.execute(
        "INSERT INTO hosted_photos (listing_id, position, blob_url) "
        "VALUES ('abc', 1, 'https://example.public.blob.vercel-storage.com/abc/01.jpg')"
    )
    conn.commit()

    assert already_uploaded(conn, "abc", 1) is True


class _FakeCompletedProcess:
    def __init__(self, stdout: str, returncode: int = 0):
        self.stdout = stdout
        self.returncode = returncode


def test_upload_photo_returns_the_url_from_stdout():
    calls = []

    def fake_run(cmd, capture_output, text, check):
        calls.append(cmd)
        return _FakeCompletedProcess(
            stdout="https://example.public.blob.vercel-storage.com/abc/01.jpg\n"
        )

    url = upload_photo(
        Path("data/photos/abc/01.jpg"), "abc", 1, rw_token="rwtoken123", run=fake_run,
    )

    assert url == "https://example.public.blob.vercel-storage.com/abc/01.jpg"
    assert calls[0][:3] == ["vercel", "blob", "put"]
    assert "--pathname" in calls[0]
    assert calls[0][calls[0].index("--pathname") + 1] == "photos/abc/01.jpg"
    assert "--rw-token" in calls[0]
    assert calls[0][calls[0].index("--rw-token") + 1] == "rwtoken123"
    assert "--allow-overwrite" in calls[0]
    assert "--access" in calls[0]
    assert calls[0][calls[0].index("--access") + 1] == "public"


def test_upload_photo_raises_on_nonzero_exit():
    def fake_run(cmd, capture_output, text, check):
        raise RuntimeError("vercel blob put failed: 401 unauthorized")

    try:
        upload_photo(Path("data/photos/abc/01.jpg"), "abc", 1, rw_token="bad", run=fake_run)
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd home-search && venv/bin/python -m pytest tests/test_blob_upload.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.blob_upload'`

- [ ] **Step 3: Write the implementation**

```python
# home-search/src/blob_upload.py
import subprocess
from pathlib import Path
from typing import Callable


def already_uploaded(conn, listing_id: str, position: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM hosted_photos WHERE listing_id = ? AND position = ?",
        (listing_id, position),
    ).fetchone()
    return row is not None


def upload_photo(
    local_path: Path,
    listing_id: str,
    position: int,
    rw_token: str,
    run: Callable = subprocess.run,
) -> str:
    """Uploads one photo via the Vercel CLI and returns the resulting public
    URL. --allow-overwrite makes a rerun after a photo changes safe;
    --access public matches the mockup's plain <img>/next/image usage --
    nothing in this project is sensitive at the photo level."""
    pathname = f"photos/{listing_id}/{position:02d}.jpg"
    result = run(
        [
            "vercel", "blob", "put", str(local_path),
            "--pathname", pathname,
            "--access", "public",
            "--allow-overwrite",
            "--rw-token", rw_token,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd home-search && venv/bin/python -m pytest tests/test_blob_upload.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd home-search
git add src/blob_upload.py tests/test_blob_upload.py
git commit -m "feat(sync): add Vercel Blob photo upload via CLI"
```

---

### Task 3: `publish.py` orchestrator

**Files:**
- Create: `home-search/publish.py`
- Modify: `home-search/.env.example`
- Modify: `home-search/requirements.txt`

**Interfaces:**
- Consumes: `ensure_schema`, `upsert_row`, `replace_listing_rows` (Task 1);
  `already_uploaded`, `upload_photo` (Task 2); `get_connection`, `query_listings`
  from `src/db.py` (existing). Photo files are read directly off disk
  (`PHOTOS_DIR / listing_id / *.jpg`) rather than through `src/photos.py`, since this
  script only needs the already-downloaded file list, not the download logic itself.
- Produces: nothing consumed by other tasks — this is the top-level script Ben runs
  manually (`python publish.py`).

No test file, matching `score_photos.py`/`compute_commutes.py`'s existing untested-
orchestration precedent — the logic worth testing already has tests in Tasks 1-2; this
script is thin wiring plus real network calls.

- [ ] **Step 1: Add the new dependency**

```bash
cd home-search
echo "turso_serverless" >> requirements.txt
venv/bin/pip install turso_serverless
```

- [ ] **Step 2: Add the new env vars to `.env.example`**

```bash
# home-search/.env.example -- append:
cat >> .env.example << 'EOF'

# Cloud sync (publish.py) -- pushes the local DB + photos to the hosted viewer
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
BLOB_READ_WRITE_TOKEN=
SHORT_LIST_URL=
REVALIDATE_SECRET=
EOF
```

- [ ] **Step 3: Write `publish.py`**

```python
# home-search/publish.py
import os
from pathlib import Path

import requests
import turso_serverless
from dotenv import dotenv_values

from src.db import get_connection, query_listings
from src.turso_sync import ensure_schema, replace_listing_rows, upsert_row
from src.blob_upload import already_uploaded, upload_photo

DATA_DIR = Path("data")
DB_PATH = DATA_DIR / "listings.db"
PHOTOS_DIR = DATA_DIR / "photos"

# Every mirrored table that has a real per-row primary key -- synced with
# upsert_row. amenities/photo_urls are handled separately (Step 6 below)
# since they have no primary key of their own.
KEYED_TABLES = ["listings", "commute", "scores", "visual_scores"]


def _sync_keyed_tables(local_conn, turso_conn) -> int:
    synced = 0
    for table in KEYED_TABLES:
        for row in local_conn.execute(f"SELECT * FROM {table}"):
            upsert_row(turso_conn, table, row)
            synced += 1
    return synced


def _sync_per_listing_tables(local_conn, turso_conn, listing_ids: list[str]) -> None:
    for listing_id in listing_ids:
        amenity_rows = local_conn.execute(
            "SELECT * FROM amenities WHERE listing_id = ?", (listing_id,)
        ).fetchall()
        replace_listing_rows(turso_conn, "amenities", listing_id, amenity_rows)

        photo_url_rows = local_conn.execute(
            "SELECT * FROM photo_urls WHERE listing_id = ?", (listing_id,)
        ).fetchall()
        replace_listing_rows(turso_conn, "photo_urls", listing_id, photo_url_rows)


def _upload_new_photos(turso_conn, listing_ids: list[str], rw_token: str) -> int:
    uploaded = 0
    for listing_id in listing_ids:
        photo_dir = PHOTOS_DIR / listing_id
        if not photo_dir.exists():
            continue
        for photo_path in sorted(photo_dir.glob("*.jpg")):
            position = int(photo_path.stem)
            if already_uploaded(turso_conn, listing_id, position):
                continue
            try:
                url = upload_photo(photo_path, listing_id, position, rw_token)
            except Exception as exc:
                print(f"  {listing_id}/{photo_path.name}: upload failed ({exc})")
                continue
            turso_conn.execute(
                "INSERT OR REPLACE INTO hosted_photos (listing_id, position, blob_url) "
                "VALUES (?, ?, ?)",
                (listing_id, position, url),
            )
            turso_conn.commit()
            uploaded += 1
    return uploaded


def _revalidate(short_list_url: str, secret: str) -> None:
    try:
        response = requests.post(
            f"{short_list_url.rstrip('/')}/api/revalidate",
            headers={"Authorization": f"Bearer {secret}"},
            timeout=10,
        )
        response.raise_for_status()
        print("revalidated the hosted site")
    except Exception as exc:
        print(f"warning: revalidate call failed ({exc}) -- cache will expire naturally")


def main() -> None:
    env = {**dotenv_values(".env"), **os.environ}

    local_conn = get_connection(DB_PATH)
    turso_conn = turso_serverless.connect(
        env["TURSO_DATABASE_URL"], auth_token=env["TURSO_AUTH_TOKEN"]
    )
    ensure_schema(turso_conn)

    rows = query_listings(local_conn)
    listing_ids = [row["listing_id"] for row in rows]

    synced = _sync_keyed_tables(local_conn, turso_conn)
    _sync_per_listing_tables(local_conn, turso_conn, listing_ids)
    print(f"synced {synced} rows across {len(KEYED_TABLES)} tables for {len(listing_ids)} listings")

    uploaded = _upload_new_photos(turso_conn, listing_ids, env["BLOB_READ_WRITE_TOKEN"])
    print(f"uploaded {uploaded} new photos")

    _revalidate(env["SHORT_LIST_URL"], env["REVALIDATE_SECRET"])

    local_conn.close()
    turso_conn.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Smoke-test against real Turso credentials**

This step needs `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`/`BLOB_READ_WRITE_TOKEN` from
Task 9 (Vercel/Turso/Blob provisioning) to actually run — if that hasn't happened yet,
skip this step for now and come back to it after Task 9.

Run: `cd home-search && venv/bin/python publish.py`
Expected: prints a row-sync count, a photo-upload count, and either "revalidated the
hosted site" or a revalidate warning (expected before `short-list` is deployed).

- [ ] **Step 5: Commit**

```bash
cd home-search
git add publish.py .env.example requirements.txt
git commit -m "feat(sync): add publish.py to push local data to Turso and Blob"
```

---

## Phase 2 — `short-list`: the Next.js app

### Task 4: Scaffold the app, config, and shared styles

**Files:**
- Create: `short-list/` (via `create-next-app`)
- Create: `short-list/app/globals.css`
- Modify: `short-list/next.config.ts`
- Modify: `short-list/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the project skeleton every later task builds inside; `app/globals.css`
  (the full token/class system ported from the approved "Dense" mockup) that
  `app/page.tsx` (Task 7) and `app/listing/[id]/page.tsx` (Task 8) both import.

- [ ] **Step 1: Scaffold the project**

```bash
cd ~/code
npx create-next-app@latest short-list --typescript --app --no-tailwind --eslint --no-src-dir --import-alias "@/*"
cd short-list
npm install @libsql/client
```

When prompted, accept defaults for everything except Tailwind (declined — the mockup's
CSS is ported directly, see Global Constraints).

- [ ] **Step 2: Enable Cache Components**

```ts
// short-list/next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
    ],
  },
}

export default nextConfig
```

- [ ] **Step 3: Port the mockup's CSS into `app/globals.css`**

Open the approved "Dense" mockup artifact and copy everything inside its `<style>`
tag verbatim into `short-list/app/globals.css` (the `:root` tokens, the
`@media (prefers-color-scheme: dark)` block, the `:root[data-theme="dark"]` block, and
every class from `.app-inner` through `.sticky-cta`). Delete Next.js's generated
placeholder rules in that file first (the default `create-next-app` starter CSS).

Import it once, at the root layout:

```tsx
// short-list/app/layout.tsx -- add this import at the top, keep the rest of the
// generated file as-is
import './globals.css'
```

- [ ] **Step 4: Verify the dev server boots**

Run: `cd short-list && npm run dev`
Expected: starts on `localhost:3000` with no errors (the page content is still the
`create-next-app` placeholder — later tasks replace it).

- [ ] **Step 5: Commit**

```bash
cd short-list
git add -A
git commit -m "feat: scaffold Next.js app with Cache Components and mockup styles"
```

---

### Task 5: Data layer — `lib/db.ts`, `lib/queries.ts`, revalidate route

**Files:**
- Create: `short-list/lib/db.ts`
- Create: `short-list/lib/queries.ts`
- Create: `short-list/app/api/revalidate/route.ts`
- Test: `short-list/lib/queries.test.ts`
- Modify: `short-list/package.json` (test runner)

**Interfaces:**
- Consumes: the `hosted_photos`, `listings`, `amenities`, `commute`, `scores`,
  `visual_scores` schema from Phase 1 Task 1.
- Produces: `getDb(): Client` (from `lib/db.ts`); `type ListingSummary`,
  `type ListingDetail`, `type SortKey`, `getListings(params: { search?: string; sort?: SortKey; onlyPasses?: boolean; onlyStaging?: boolean; onlyPending?: boolean }): Promise<ListingSummary[]>`,
  `getListing(id: string): Promise<ListingDetail | null>` (from `lib/queries.ts`) —
  used by `app/page.tsx` (Task 7) and `app/listing/[id]/page.tsx` (Task 8).

**Important semantic note for this task:** the mockup's demo data represented an
unscored listing with `composite: null`. In the real pipeline, `score.py` always
writes a `scores` row (with a keyword-based fallback) once it has run at all — a
`null` composite only happens for a listing that has *never* been scored (freshly
synced, `score.py` hasn't run since). "Not yet scored" in this app means
`visual_scores` is missing or `photo_score_unavailable = 1` (photo scoring hasn't run
for this listing yet) — the composite itself is still a real, displayable number in
that case, computed from the keyword fallback. Only render "Pending" in place of the
composite number when there is no `scores` row at all.

- [ ] **Step 1: Install the test runner**

```bash
cd short-list
npm install -D vitest
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write `lib/db.ts`**

```ts
// short-list/lib/db.ts
import { createClient, type Client } from '@libsql/client'

let _db: Client | null = null

export function getDb(): Client {
  if (!_db) {
    _db = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    })
  }
  return _db
}
```

- [ ] **Step 3: Write the failing tests for `lib/queries.ts`**

```ts
// short-list/lib/queries.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { buildListingsQuery, type SortKey } from './queries'

async function seed(db: Client) {
  await db.execute(`CREATE TABLE listings (
    listing_id TEXT PRIMARY KEY, address TEXT, city TEXT, state TEXT, zip_code TEXT,
    price TEXT, price_numeric REAL, beds INTEGER, baths REAL, sqft INTEGER,
    lot_sqft INTEGER, parking_spaces INTEGER, year_built INTEGER, description TEXT,
    listing_url TEXT, is_pinned INTEGER
  )`)
  await db.execute(`CREATE TABLE scores (
    listing_id TEXT PRIMARY KEY, commute_score REAL, sqft_score REAL,
    condition_score REAL, outdoor_score REAL, room_count_score REAL,
    parking_score REAL, composite REAL, passes_filters INTEGER,
    has_incomplete_data INTEGER, computed_at TEXT
  )`)
  await db.execute(`CREATE TABLE visual_scores (
    listing_id TEXT PRIMARY KEY, condition_photo_score REAL, outdoor_photo_score REAL,
    has_layout_plan INTEGER, layout_plan_clarity_score REAL, garage_attached INTEGER,
    watermarked_staging_detected INTEGER, suspected_unwatermarked_staging INTEGER,
    staging_notes TEXT, photo_score_unavailable INTEGER, raw_response TEXT, computed_at TEXT
  )`)

  await db.execute(
    "INSERT INTO listings VALUES ('a', '1 Main St', 'Arvada', 'CO', '80002', '$600,000', 600000, 4, 3, 2000, 7000, 2, 2000, 'desc', 'https://compass.com/a', 0)"
  )
  await db.execute(
    "INSERT INTO scores VALUES ('a', 80, 70, 90, 60, 75, 100, 79, 1, 0, 't')"
  )
  await db.execute(
    "INSERT INTO listings VALUES ('b', '2 Oak Ave', 'Broomfield', 'CO', '80020', '$500,000', 500000, 3, 2, 1500, 6500, 1, 1990, 'desc', 'https://compass.com/b', 0)"
  )
  await db.execute(
    "INSERT INTO scores VALUES ('b', 60, 50, 40, 90, 50, 90, 55, 0, 1, 't')"
  )
  await db.execute(
    "INSERT INTO visual_scores VALUES ('b', 40, 90, 0, NULL, 1, 1, 0, 'watermark seen', 0, '{}', 't')"
  )
}

describe('buildListingsQuery', () => {
  let db: Client

  beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await seed(db)
  })

  it('returns every listing with no filters, sorted by composite by default', async () => {
    const { sql, args } = buildListingsQuery({})
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a', 'b'])
  })

  it('filters by an address/city search substring', async () => {
    const { sql, args } = buildListingsQuery({ search: 'oak' })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b'])
  })

  it('sorts by an individual sub-score', async () => {
    const { sql, args } = buildListingsQuery({ sort: 'outdoor' as SortKey })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b', 'a'])
  })

  it('filters to only listings that pass cutoffs', async () => {
    const { sql, args } = buildListingsQuery({ onlyPasses: true })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['a'])
  })

  it('filters to only staging-flagged listings', async () => {
    const { sql, args } = buildListingsQuery({ onlyStaging: true })
    const result = await db.execute({ sql, args })
    expect(result.rows.map((r) => r.listing_id)).toEqual(['b'])
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd short-list && npx vitest run lib/queries.test.ts`
Expected: FAIL — `queries.ts` doesn't exist yet.

- [ ] **Step 5: Write `lib/queries.ts`**

```ts
// short-list/lib/queries.ts
import { unstable_cacheLife as cacheLife, unstable_cacheTag as cacheTag } from 'next/cache'
import { getDb } from './db'

export type SortKey =
  | 'composite' | 'commute' | 'sqft' | 'condition' | 'outdoor' | 'room' | 'parking'
  | 'value' | 'price'

const SORT_COLUMNS: Record<Exclude<SortKey, 'value' | 'price'>, string> = {
  composite: 's.composite',
  commute: 's.commute_score',
  sqft: 's.sqft_score',
  condition: 's.condition_score',
  outdoor: 's.outdoor_score',
  room: 's.room_count_score',
  parking: 's.parking_score',
}

export interface ListingsFilter {
  search?: string
  sort?: SortKey
  onlyPasses?: boolean
  onlyStaging?: boolean
  onlyPending?: boolean
}

export function buildListingsQuery(filter: ListingsFilter): { sql: string; args: unknown[] } {
  const clauses: string[] = []
  const args: unknown[] = []

  if (filter.search) {
    clauses.push('(l.address LIKE ? OR l.city LIKE ?)')
    args.push(`%${filter.search}%`, `%${filter.search}%`)
  }
  if (filter.onlyPasses) {
    clauses.push('s.passes_filters = 1')
  }
  if (filter.onlyStaging) {
    clauses.push('(vs.watermarked_staging_detected = 1 OR vs.suspected_unwatermarked_staging = 1)')
  }
  if (filter.onlyPending) {
    clauses.push("(vs.listing_id IS NULL OR vs.photo_score_unavailable = 1)")
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  let orderBy: string
  if (filter.sort === 'value') {
    orderBy = "ORDER BY (CASE WHEN l.price_numeric > 0 THEN s.composite / (l.price_numeric / 100000.0) END) DESC NULLS LAST"
  } else if (filter.sort === 'price') {
    orderBy = 'ORDER BY l.price_numeric ASC NULLS LAST'
  } else {
    const column = SORT_COLUMNS[filter.sort ?? 'composite']
    orderBy = `ORDER BY ${column} DESC NULLS LAST`
  }

  const sql = `
    SELECT l.*, s.commute_score, s.sqft_score, s.condition_score, s.outdoor_score,
           s.room_count_score, s.parking_score, s.composite, s.passes_filters,
           s.has_incomplete_data,
           vs.garage_attached, vs.watermarked_staging_detected,
           vs.suspected_unwatermarked_staging, vs.has_layout_plan,
           vs.layout_plan_clarity_score, vs.photo_score_unavailable
    FROM listings l
    LEFT JOIN scores s ON s.listing_id = l.listing_id
    LEFT JOIN visual_scores vs ON vs.listing_id = l.listing_id
    ${where}
    ${orderBy}
  `
  return { sql, args }
}

export async function getListings(filter: ListingsFilter) {
  'use cache'
  cacheTag('listings')
  cacheLife('hours')

  const { sql, args } = buildListingsQuery(filter)
  const db = getDb()
  const result = await db.execute({ sql, args })
  return result.rows
}

export async function getListing(id: string) {
  'use cache'
  cacheTag('listings')
  cacheLife('hours')

  const db = getDb()
  const listing = await db.execute({
    sql: `
      SELECT l.*, s.commute_score, s.sqft_score, s.condition_score, s.outdoor_score,
             s.room_count_score, s.parking_score, s.composite, s.passes_filters,
             s.has_incomplete_data,
             vs.garage_attached, vs.watermarked_staging_detected,
             vs.suspected_unwatermarked_staging, vs.staging_notes,
             vs.has_layout_plan, vs.layout_plan_clarity_score, vs.photo_score_unavailable,
             c.denver_miles, c.denver_minutes, c.medtronic_miles, c.medtronic_minutes
      FROM listings l
      LEFT JOIN scores s ON s.listing_id = l.listing_id
      LEFT JOIN visual_scores vs ON vs.listing_id = l.listing_id
      LEFT JOIN commute c ON c.listing_id = l.listing_id
      WHERE l.listing_id = ?
    `,
    args: [id],
  })
  if (listing.rows.length === 0) return null

  const [amenities, photos] = await Promise.all([
    db.execute({
      sql: 'SELECT amenity FROM amenities WHERE listing_id = ?',
      args: [id],
    }),
    db.execute({
      sql: 'SELECT position, blob_url FROM hosted_photos WHERE listing_id = ? ORDER BY position',
      args: [id],
    }),
  ])

  return {
    ...listing.rows[0],
    amenities: amenities.rows.map((r) => r.amenity as string),
    photos: photos.rows.map((r) => ({ position: r.position as number, url: r.blob_url as string })),
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd short-list && npx vitest run lib/queries.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Write the revalidate route**

```ts
// short-list/app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.REVALIDATE_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  revalidateTag('listings')
  return NextResponse.json({ revalidated: true })
}
```

- [ ] **Step 8: Commit**

```bash
cd short-list
git add lib/db.ts lib/queries.ts lib/queries.test.ts app/api/revalidate/route.ts package.json
git commit -m "feat: add Turso data layer and cache revalidation endpoint"
```

---

### Task 6: Passcode gate

**Files:**
- Create: `short-list/proxy.ts`
- Create: `short-list/lib/auth.ts`
- Create: `short-list/app/enter/page.tsx`
- Create: `short-list/app/enter/actions.ts`
- Test: `short-list/lib/auth.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `SESSION_COOKIE = 'short_list_session'`, `signSession(): string`,
  `isValidSession(value: string | undefined): boolean` (from `lib/auth.ts`) — used by
  both `proxy.ts` and `app/enter/actions.ts`.

- [ ] **Step 1: Write the failing tests for `lib/auth.ts`**

```ts
// short-list/lib/auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { signSession, isValidSession } from './auth'

describe('session signing', () => {
  const originalSecret = process.env.COOKIE_SECRET

  beforeEach(() => {
    process.env.COOKIE_SECRET = 'test-secret'
  })
  afterEach(() => {
    process.env.COOKIE_SECRET = originalSecret
  })

  it('a freshly signed session is valid', () => {
    const token = signSession()
    expect(isValidSession(token)).toBe(true)
  })

  it('an undefined cookie value is invalid', () => {
    expect(isValidSession(undefined)).toBe(false)
  })

  it('a tampered token is invalid', () => {
    const token = signSession()
    expect(isValidSession(token + 'x')).toBe(false)
  })

  it('a token signed with a different secret is invalid', () => {
    const token = signSession()
    process.env.COOKIE_SECRET = 'a-different-secret'
    expect(isValidSession(token)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd short-list && npx vitest run lib/auth.test.ts`
Expected: FAIL — `auth.ts` doesn't exist yet.

- [ ] **Step 3: Write `lib/auth.ts`**

```ts
// short-list/lib/auth.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'short_list_session'
const PAYLOAD = 'authenticated'

function sign(payload: string): string {
  return createHmac('sha256', process.env.COOKIE_SECRET!).update(payload).digest('hex')
}

export function signSession(): string {
  return `${PAYLOAD}.${sign(PAYLOAD)}`
}

export function isValidSession(value: string | undefined): boolean {
  if (!value) return false
  const [payload, signature] = value.split('.')
  if (!payload || !signature || payload !== PAYLOAD) return false

  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd short-list && npx vitest run lib/auth.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write `proxy.ts`**

```ts
// short-list/proxy.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, isValidSession } from './lib/auth'

export function proxy(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value
  if (isValidSession(cookie)) {
    return NextResponse.next()
  }
  const url = new URL('/enter', request.url)
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!enter|api/revalidate|_next/static|_next/image|favicon.ico).*)',
  ],
}
```

- [ ] **Step 6: Write the passcode entry page and server action**

```ts
// short-list/app/enter/actions.ts
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, signSession } from '@/lib/auth'

export async function submitPasscode(formData: FormData) {
  const passcode = formData.get('passcode')
  const next = (formData.get('next') as string) || '/'

  if (passcode !== process.env.SITE_PASSCODE) {
    redirect(`/enter?error=1&next=${encodeURIComponent(next)}`)
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, signSession(), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  })
  redirect(next)
}
```

```tsx
// short-list/app/enter/page.tsx
import { submitPasscode } from './actions'

export default async function EnterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next = '/', error } = await searchParams

  return (
    <main className="enter-page">
      <form action={submitPasscode}>
        <input type="hidden" name="next" value={next} />
        <h1>The Short List</h1>
        <label htmlFor="passcode">Passcode</label>
        <input id="passcode" name="passcode" type="password" autoFocus required />
        {error && <p className="enter-error">Wrong passcode — try again.</p>}
        <button type="submit">Enter</button>
      </form>
    </main>
  )
}
```

Add a small `.enter-page` / `.enter-error` rule to `app/globals.css` (centered card,
reusing existing `--surface`/`--line`/`--warn` tokens) — a few lines, not a new design
system.

- [ ] **Step 7: Manual verification**

Run: `cd short-list && SITE_PASSCODE=test123 COOKIE_SECRET=devsecret npm run dev`
Visit `localhost:3000` → expect a redirect to `/enter`. Submit the wrong passcode →
expect the inline error. Submit `test123` → expect a redirect back to `/` and the
cookie set (check DevTools → Application → Cookies).

- [ ] **Step 8: Commit**

```bash
cd short-list
git add proxy.ts lib/auth.ts lib/auth.test.ts app/enter app/globals.css
git commit -m "feat: add passcode gate via proxy.ts and signed session cookie"
```

---

### Task 7: List view

**Files:**
- Create: `short-list/app/page.tsx`
- Create: `short-list/app/ListControls.tsx`
- Test: none (thin rendering + a client component with no branching logic worth a
  unit test — matches the "skip e2e, keep it simple" testing philosophy from the spec)

**Interfaces:**
- Consumes: `getListings`, `SortKey` (Task 5).
- Produces: the `/` route.

- [ ] **Step 1: Write the client controls component**

Ports the mockup's search box, sort `<select>`, and filter chips. State lives in the
URL via `useRouter`/`useSearchParams` — no client data fetching, it only ever
navigates.

```tsx
// short-list/app/ListControls.tsx
'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'composite', label: 'Sort: Composite' },
  { value: 'value', label: 'Sort: Value / $100k' },
  { value: 'price', label: 'Sort: Price (low first)' },
  { value: 'commute', label: 'Sort: Commute' },
  { value: 'sqft', label: 'Sort: Sqft score' },
  { value: 'condition', label: 'Sort: Condition' },
  { value: 'outdoor', label: 'Sort: Outdoor' },
  { value: 'room', label: 'Sort: Room count' },
  { value: 'parking', label: 'Sort: Parking' },
]

export function ListControls() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    startTransition(() => router.push(`/?${params.toString()}`))
  }

  const activeFilter =
    searchParams.get('onlyPasses') === '1' ? 'passes'
    : searchParams.get('onlyStaging') === '1' ? 'staging'
    : searchParams.get('onlyPending') === '1' ? 'pending'
    : 'all'

  function setFilter(next: 'all' | 'passes' | 'staging' | 'pending') {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('onlyPasses')
    params.delete('onlyStaging')
    params.delete('onlyPending')
    if (next === 'passes') params.set('onlyPasses', '1')
    if (next === 'staging') params.set('onlyStaging', '1')
    if (next === 'pending') params.set('onlyPending', '1')
    startTransition(() => router.push(`/?${params.toString()}`))
  }

  return (
    <div className="controls">
      <div className="row-controls">
        <label className="search">
          <input
            type="text"
            placeholder="Search address or city…"
            defaultValue={searchParams.get('search') ?? ''}
            onChange={(e) => updateParam('search', e.target.value || null)}
          />
        </label>
        <select
          className="sort"
          defaultValue={searchParams.get('sort') ?? 'composite'}
          onChange={(e) => updateParam('sort', e.target.value)}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="chips">
        <button className="chip" aria-pressed={activeFilter === 'all'} onClick={() => setFilter('all')}>All</button>
        <button className="chip" aria-pressed={activeFilter === 'passes'} onClick={() => setFilter('passes')}>Passes cutoffs</button>
        <button className="chip" aria-pressed={activeFilter === 'staging'} onClick={() => setFilter('staging')}>Staging flagged</button>
        <button className="chip" aria-pressed={activeFilter === 'pending'} onClick={() => setFilter('pending')}>Not yet scored</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write the list page**

```tsx
// short-list/app/page.tsx
import Image from 'next/image'
import Link from 'next/link'
import { Suspense } from 'react'
import { getListings, type SortKey } from '@/lib/queries'
import { ListControls } from './ListControls'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  return (
    <>
      <header className="app-inner">
        <h1>The Short List</h1>
        <Suspense fallback={<div className="controls" />}>
          <ListControls />
        </Suspense>
      </header>
      <Suspense fallback={<p>Loading…</p>}>
        <ListingCards
          search={params.search}
          sort={params.sort as SortKey | undefined}
          onlyPasses={params.onlyPasses === '1'}
          onlyStaging={params.onlyStaging === '1'}
          onlyPending={params.onlyPending === '1'}
        />
      </Suspense>
    </>
  )
}

async function ListingCards({
  search, sort, onlyPasses, onlyStaging, onlyPending,
}: {
  search?: string; sort?: SortKey; onlyPasses: boolean; onlyStaging: boolean; onlyPending: boolean
}) {
  const listings = await getListings({ search, sort, onlyPasses, onlyStaging, onlyPending })

  if (listings.length === 0) {
    return <p className="empty-state">No listings match that search or filter.</p>
  }

  return (
    <div className="listing-rows">
      {listings.map((l) => {
        const composite = l.composite as number | null
        const staged = l.watermarked_staging_detected === 1 || l.suspected_unwatermarked_staging === 1
        const belowCutoff = l.passes_filters === 0
        const pending = l.photo_score_unavailable === 1 || l.photo_score_unavailable === null

        return (
          <article key={l.listing_id as string} className="listing-row">
            <Link href={`/listing/${l.listing_id}`}>
              <div className="thumb-wrap">
                {/* photo thumbnail: first hosted_photos entry, added in a follow-up
                    once at least one publish.py run has uploaded real photos */}
              </div>
              <h2>{l.address as string}</h2>
              <p>{l.city as string}, {l.state as string} · {l.beds as number} bd · {l.baths as number} ba · {l.sqft as number} sqft</p>
              <p className="price">${(l.price_numeric as number)?.toLocaleString()}</p>
              {composite === null ? (
                <span className="pending-badge">Pending</span>
              ) : (
                <span className="score-pill">{composite}<span className="of">/100</span></span>
              )}
              <div className="badge-row">
                {staged && <span className="badge staged">Staged</span>}
                {belowCutoff && <span className="badge cutoff">Below cutoff</span>}
                {pending && <span className="badge pending">Photo scoring pending</span>}
              </div>
            </Link>
            <a className="compass-link" href={l.listing_url as string} target="_blank" rel="noopener">
              Compass ↗
            </a>
          </article>
        )
      })}
    </div>
  )
}
```

This uses the mockup's class names (`.listing-row`, `.thumb-wrap`, `.score-pill`,
`.badge`, `.compass-link`, etc.) so `app/globals.css` from Task 4 already styles it —
no new CSS needed here. The thumbnail `<Image>` is deliberately left as a follow-up
comment: it needs at least one real `publish.py` run (Task 9) to have a `hosted_photos`
row to point at, so wiring it in now would be untestable until then. Fill it in as
part of Task 9's manual verification once real photos exist:

```tsx
{l.thumbnail_url && (
  <Image src={l.thumbnail_url as string} alt="" fill sizes="120px" />
)}
```

- [ ] **Step 3: Manual verification**

Run: `cd short-list && npm run dev`, log in via `/enter`, confirm the list renders,
search/sort/filter all update the URL and the results.

- [ ] **Step 4: Commit**

```bash
cd short-list
git add app/page.tsx app/ListControls.tsx
git commit -m "feat: add list view with search, sort, and filter chips"
```

---

### Task 8: Detail view

**Files:**
- Create: `short-list/app/listing/[id]/page.tsx`

**Interfaces:**
- Consumes: `getListing` (Task 5).
- Produces: the `/listing/[id]` route.

- [ ] **Step 1: Write the detail page**

```tsx
// short-list/app/listing/[id]/page.tsx
import { notFound } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { getListing } from '@/lib/queries'

const WEIGHTS: Record<string, number> = {
  commute: 30, sqft: 20, condition: 20, outdoor: 15, room: 10, parking: 5,
}
const LABELS: Record<string, string> = {
  commute: 'Commute', sqft: 'Sqft', condition: 'Condition', outdoor: 'Outdoor',
  room: 'Rooms', parking: 'Parking',
}
const SCORE_FIELD: Record<string, string> = {
  commute: 'commute_score', sqft: 'sqft_score', condition: 'condition_score',
  outdoor: 'outdoor_score', room: 'room_count_score', parking: 'parking_score',
}

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) notFound()

  const composite = listing.composite as number | null
  const staged = listing.watermarked_staging_detected === 1 || listing.suspected_unwatermarked_staging === 1
  const belowCutoff = listing.passes_filters === 0
  const priceNumeric = listing.price_numeric as number | null
  const value = composite !== null && priceNumeric ? composite / (priceNumeric / 100000) : null

  return (
    <main>
      <Link href="/" className="back-link">← All listings</Link>
      <a className="detail-compass" href={listing.listing_url as string} target="_blank" rel="noopener">
        View on Compass ↗
      </a>

      <div className="gallery">
        {(listing.photos as { position: number; url: string }[]).map((p) => (
          <Image
            key={p.position}
            src={p.url}
            alt=""
            width={400}
            height={300}
            sizes="(max-width: 640px) 100vw, 400px"
          />
        ))}
      </div>

      {staged && (
        <div className="staging-alert">
          <p className="t">Staging suspected in listing photos</p>
          <p className="d">{listing.staging_notes as string}</p>
        </div>
      )}
      {belowCutoff && (
        <div className="cutoff-alert">
          <p className="t">Below hard cutoffs — still shown for comparison</p>
        </div>
      )}

      <h1>{listing.address as string}</h1>
      <p>{listing.city as string}, {listing.state as string} {listing.zip_code as string} · Built {listing.year_built as number}</p>
      <p className="detail-price">${priceNumeric?.toLocaleString()}</p>

      <div className="stat-strip">
        <div className="stat"><div className="v">{listing.beds as number}</div><div className="k">Beds</div></div>
        <div className="stat"><div className="v">{listing.baths as number}</div><div className="k">Baths</div></div>
        <div className="stat"><div className="v">{listing.sqft as number}</div><div className="k">Sqft</div></div>
        <div className="stat"><div className="v">{listing.lot_sqft as number}</div><div className="k">Lot sqft</div></div>
        <div className="stat"><div className="v">{listing.parking_spaces as number}</div><div className="k">Parking</div></div>
      </div>

      <section>
        <h3>Composite score</h3>
        {composite === null ? (
          <p>Not yet scored — run score.py after the next sync.</p>
        ) : (
          <>
            <div className="composite-num">{composite}</div>
            {value !== null && (
              <div className="value-chip">
                <span className="n">{value.toFixed(1)}</span> pts / $100k
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <h3>Score breakdown</h3>
        <div className="eq">
          {Object.keys(WEIGHTS).map((key) => {
            const raw = listing[SCORE_FIELD[key]] as number | null
            return (
              <div key={key} className="eq-bar">
                <div className="val">{raw ?? '—'}</div>
                <div className="lbl">{LABELS[key]}</div>
                <div className="wt">{WEIGHTS[key]}%</div>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h3>Facts worth knowing</h3>
        <div className="fact-grid">
          <div className="fact-card">
            <div className="k">Garage</div>
            <div className="v">
              {listing.garage_attached === 1 ? 'Attached' : listing.garage_attached === 0 ? 'Detached' : 'Unknown'}
            </div>
          </div>
          <div className="fact-card">
            <div className="k">Staging</div>
            <div className="v">{staged ? 'Flagged' : 'None noted'}</div>
          </div>
          <div className="fact-card">
            <div className="k">Floor plan</div>
            <div className="v">
              {listing.has_layout_plan === 1
                ? `Found · clarity ${listing.layout_plan_clarity_score}/10`
                : 'Not found'}
            </div>
          </div>
          <div className="fact-card">
            <div className="k">Data quality</div>
            <div className="v">{listing.has_incomplete_data === 1 ? 'Some estimated' : 'Complete'}</div>
          </div>
        </div>
      </section>

      <section>
        <h3>Description</h3>
        <p className="desc">{listing.description as string}</p>
      </section>

      <section>
        <h3>Amenities</h3>
        <div className="amenities">
          {(listing.amenities as string[]).map((a) => (
            <span key={a} className="amenity">{a}</span>
          ))}
        </div>
      </section>

      <div className="sticky-cta">
        <a href={listing.listing_url as string} target="_blank" rel="noopener">
          Open full listing on Compass ↗
        </a>
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Manual verification**

Click into a listing from `/`. Confirm the score breakdown, facts grid, description,
amenities, and Compass links all render. Confirm a listing with no `visual_scores`
row shows "Unknown" garage / "Not found" floor plan rather than crashing.

- [ ] **Step 3: Commit**

```bash
cd short-list
git add app/listing
git commit -m "feat: add listing detail view"
```

---

### Task 9: Provision Vercel, deploy, and run the first real sync

**Files:** none — this task is manual setup and verification, not code.

- [ ] **Step 1: Create the Vercel project**

```bash
cd short-list
vercel link
```

Follow the prompts to create a new project under your existing Vercel account.

- [ ] **Step 2: Provision Turso and Vercel Blob**

```bash
vercel integration add turso
vercel integration add blob
```

These auto-provision `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` and
`BLOB_READ_WRITE_TOKEN` as Vercel project env vars.

- [ ] **Step 3: Set the remaining env vars**

```bash
vercel env add SITE_PASSCODE production
vercel env add COOKIE_SECRET production
vercel env add REVALIDATE_SECRET production
```

Pick a real passcode, and generate two random secrets, e.g.
`openssl rand -hex 32` for each of `COOKIE_SECRET` and `REVALIDATE_SECRET`.

- [ ] **Step 4: Pull env vars locally and deploy**

```bash
vercel env pull .env.local
vercel deploy --prod
```

- [ ] **Step 5: Wire `home-search`'s `.env` to the same values**

Copy the read-write `TURSO_AUTH_TOKEN` (Turso's dashboard distinguishes read-only vs.
read-write tokens — the one Vercel provisioned for the app should be read-only; issue
a separate read-write one for `publish.py` via `turso db tokens create`), the
`BLOB_READ_WRITE_TOKEN` from Step 2, the deployed URL as `SHORT_LIST_URL`, and the same
`REVALIDATE_SECRET` from Step 3 into `home-search/.env`.

- [ ] **Step 6: Run the first real sync**

```bash
cd ~/code/home-search
venv/bin/python publish.py
```

Expected: row-sync and photo-upload counts printed, "revalidated the hosted site" at
the end (not the warning — this confirms `SHORT_LIST_URL`/`REVALIDATE_SECRET` match).

- [ ] **Step 7: Verify end-to-end**

Visit the deployed URL. Confirm the passcode gate appears, log in, confirm real
listings render with real photos (go back and wire in the thumbnail `<Image>` from
Task 7 Step 2 now that `hosted_photos` has real rows, then redeploy).

- [ ] **Step 8: Commit the thumbnail follow-up**

```bash
cd short-list
git add app/page.tsx
git commit -m "feat: wire in real listing thumbnails from Vercel Blob"
vercel deploy --prod
```
