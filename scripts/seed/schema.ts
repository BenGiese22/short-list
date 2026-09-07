/**
 * The Turso *mirror* schema — the shape the viewer actually reads.
 *
 * Transcribed from home-search @ 408a089:
 *   - `listings`, `amenities`, `commute`, `scores`, `visual_scores` from
 *     `src/db.py::_SCHEMA`
 *   - `hosted_photos` from `src/turso_db.py::TURSO_SCHEMA_EXTRA`
 *
 * The distinction matters and is the easiest way to build a dev database that
 * renders a site with no photos and nothing in the logs to explain it:
 * home-search's LOCAL sqlite stores photos in `photo_urls(listing_id, position,
 * url)`, but the mirror stores them in `hosted_photos(..., blob_url)`, and
 * `lib/queries.ts` joins against the latter. Seeding the local shape produces a
 * silently image-less site.
 *
 * Only the six tables the viewer reads are created. The mirror also carries
 * `pipeline_lock` and `vision_batches`, which exist for the pipeline's own
 * coordination and which no page or query in this repo touches.
 *
 * If a migration upstream adds a column, this file goes stale and dev diverges
 * from production. `lib/facts.ts` is written to survive columns that are absent
 * entirely, which softens the failure, but the fix is to re-transcribe.
 */
export const MIRROR_SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
    listing_id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip_code TEXT NOT NULL,
    price TEXT NOT NULL,
    price_numeric REAL,
    beds INTEGER NOT NULL,
    baths REAL NOT NULL,
    sqft INTEGER NOT NULL,
    lot_sqft INTEGER NOT NULL,
    parking_spaces INTEGER NOT NULL,
    year_built INTEGER NOT NULL,
    description TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    property_type TEXT NOT NULL DEFAULT '',
    localized_status TEXT NOT NULL DEFAULT '',
    hoa_annual REAL,
    tax_annual REAL,
    sqft_above_grade INTEGER,
    sqft_below_grade INTEGER,
    outdoor_spaces TEXT
);

CREATE TABLE IF NOT EXISTS amenities (
    listing_id TEXT NOT NULL REFERENCES listings(listing_id),
    amenity TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commute (
    listing_id TEXT PRIMARY KEY REFERENCES listings(listing_id),
    lat REAL,
    lon REAL,
    denver_miles REAL,
    denver_minutes REAL,
    medtronic_miles REAL,
    medtronic_minutes REAL,
    geocode_failed INTEGER NOT NULL,
    computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
    listing_id TEXT PRIMARY KEY REFERENCES listings(listing_id),
    commute_score REAL NOT NULL,
    sqft_score REAL NOT NULL,
    condition_score REAL NOT NULL,
    outdoor_score REAL NOT NULL,
    room_count_score REAL NOT NULL DEFAULT 0,
    parking_score REAL NOT NULL,
    hoa_score REAL NOT NULL DEFAULT 0,
    composite REAL NOT NULL,
    passes_filters INTEGER NOT NULL,
    has_incomplete_data INTEGER NOT NULL,
    computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visual_scores (
    listing_id TEXT PRIMARY KEY REFERENCES listings(listing_id),
    condition_photo_score REAL,
    outdoor_photo_score REAL,
    has_layout_plan INTEGER NOT NULL DEFAULT 0,
    layout_plan_clarity_score REAL,
    garage_attached INTEGER,
    watermarked_staging_detected INTEGER NOT NULL DEFAULT 0,
    suspected_unwatermarked_staging INTEGER NOT NULL DEFAULT 0,
    staging_notes TEXT,
    photo_score_unavailable INTEGER NOT NULL,
    raw_response TEXT,
    computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hosted_photos (
    listing_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    blob_url TEXT NOT NULL,
    source_url TEXT,
    PRIMARY KEY (listing_id, position)
);

CREATE TABLE IF NOT EXISTS property_ids (
    listing_id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL,
    resolved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rejections (
    property_id TEXT PRIMARY KEY,
    address TEXT,
    city TEXT,
    listing_url TEXT,
    reason TEXT,
    rejected_at TEXT NOT NULL
);
`

/** Every table the seed writes, child-first, for a clean re-seed. */
export const MIRROR_TABLES = [
  'hosted_photos',
  'amenities',
  'commute',
  'scores',
  'visual_scores',
  'listings',
] as const
