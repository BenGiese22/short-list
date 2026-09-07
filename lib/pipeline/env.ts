/**
 * The environment handed to the pipeline running inside a Sandbox.
 *
 * An allowlist, deliberately. The sandbox runs Chromium against a
 * third-party site; copying the function's whole environment into it would
 * hand that VM every secret Vercel injects, including ones this project has
 * no business exposing.
 */

/** Required. A run cannot start without every one of these. */
export const REQUIRED_VARS = [
  'COMPASS_EMAIL',
  'COMPASS_PASSWORD',
  'COMPASS_COLLECTION_URL',
  'TURSO_DATABASE_URL',
  // NOT short-list's own TURSO_AUTH_TOKEN: that one is read-only by design,
  // because the viewer only ever reads. A pipeline writes, so it needs its
  // own read-write token under a distinct name.
  'PIPELINE_TURSO_AUTH_TOKEN',
  'BLOB_READ_WRITE_TOKEN',
  'REVALIDATE_SECRET',
  'VERCEL_PROJECT_PRODUCTION_URL',
  // Required rather than optional so a run that cannot compute commutes
  // never starts. Optional would mean finding out three stages in, after
  // Chromium has scraped the collection and the photos have uploaded, and
  // the whole run would be discarded anyway.
  //
  // The cost of that choice: REQUIRED_VARS is checked for every job, so
  // until this variable exists in the environment the canary fails too --
  // for a reason that has nothing to do with what the canary watches. Add
  // the variable to the project BEFORE deploying this.
  'MAPBOX_ACCESS_TOKEN',
] as const

/** Passed through when present, omitted when not. */
const OPTIONAL_VARS = [
  'COMPASS_COLLECTION_TABS',
  'ANTHROPIC_API_KEY',
  'NTFY_TOPIC',
  'MAX_PHOTOS_PER_LISTING',
  // The change digest and failure alerts. Optional, not required: a run that
  // cannot send an email is still a run worth having, and the pipeline
  // treats an unset key as "no email" rather than an error. That is the
  // opposite call from MAPBOX_ACCESS_TOKEN, and deliberately so -- without
  // routing the run produces wrong data, without email it produces right
  // data quietly.
  'RESEND_API_KEY',
  'DIGEST_EMAIL_TO',
  'RESEND_FROM',
  // The address a person can open, for links in the digest. Distinct from
  // SHORT_LIST_URL above, which is derived per-deployment for the revalidate
  // POST and can rotate.
  'SITE_URL',
] as const

export function buildRunnerEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const missing = REQUIRED_VARS.filter((name) => !source[name])
  if (missing.length > 0) {
    // Names only, never values: this message reaches logs and a 500 body.
    throw new Error(
      `pipeline runner is missing required environment variable(s): ${missing.join(', ')}`,
    )
  }

  const env: Record<string, string> = {
    COMPASS_EMAIL: source.COMPASS_EMAIL!,
    COMPASS_PASSWORD: source.COMPASS_PASSWORD!,
    COMPASS_COLLECTION_URL: source.COMPASS_COLLECTION_URL!,
    TURSO_DATABASE_URL: source.TURSO_DATABASE_URL!,
    TURSO_AUTH_TOKEN: source.PIPELINE_TURSO_AUTH_TOKEN!,
    BLOB_READ_WRITE_TOKEN: source.BLOB_READ_WRITE_TOKEN!,
    REVALIDATE_SECRET: source.REVALIDATE_SECRET!,
    // Scoped to Directions and Geocoding only. The commutes stage is the
    // one consumer; see docs/routing-provider-terms.md in home-search for
    // why the key being revoked is the failure this system is sized against.
    MAPBOX_ACCESS_TOKEN: source.MAPBOX_ACCESS_TOKEN!,
    SHORT_LIST_URL: `https://${source.VERCEL_PROJECT_PRODUCTION_URL}`,
    // Python buffers stdout when it is not a tty, so without this a crashed
    // run's logs are lost with the process that was about to print them.
    PYTHONUNBUFFERED: '1',
    // Recorded on vision batches and on the pipeline lease, so an operator
    // can tell which execution home holds something.
    HOME_SEARCH_HOME: 'sandbox',
  }

  for (const name of OPTIONAL_VARS) {
    const value = source[name]
    if (value) env[name] = value
  }
  return env
}
