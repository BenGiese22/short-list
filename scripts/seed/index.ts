#!/usr/bin/env node
/**
 * Builds the local development database.
 *
 *   npm run seed                          # SEED_PROFILE, or 'realistic'
 *   npm run seed -- --profile edge-cases
 *   npm run seed -- --profile huge --out /tmp/scratch.db
 *
 * Writes a plain SQLite file that `lib/db.ts` opens through a `file:` URL —
 * `@libsql/client` accepts one and ignores `TURSO_AUTH_TOKEN` when it sees it,
 * so no application code changes and no Turso account is involved.
 */
import { createClient, type Client, type InValue } from '@libsql/client'
import { copyFile, mkdir, writeFile, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIRROR_SCHEMA, MIRROR_TABLES } from './schema.ts'
import { generate, isSeedProfile, SEED_PROFILES, type SeedData, type SeedProfile } from './generate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const REALISTIC_FIXTURE = resolve(REPO_ROOT, 'fixtures/dev-seed-realistic.db')

/** Records which profile a database holds, so the container can detect a change. */
export function profileMarkerPath(dbPath: string): string {
  return `${dbPath}.profile`
}

interface Options {
  profile: SeedProfile
  out: string
}

function parseArgs(argv: readonly string[]): Options {
  let profile = process.env.SEED_PROFILE ?? 'realistic'
  let out = process.env.SEED_DB_PATH ?? '/data/dev.db'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') profile = argv[++i] ?? ''
    else if (arg === '--out') out = argv[++i] ?? ''
    else if (arg?.startsWith('--profile=')) profile = arg.slice('--profile='.length)
    else if (arg?.startsWith('--out=')) out = arg.slice('--out='.length)
  }

  if (!isSeedProfile(profile)) {
    throw new Error(
      `unknown SEED_PROFILE '${profile}' — expected one of ${SEED_PROFILES.join(', ')}`,
    )
  }
  if (!out) throw new Error('--out must name a database file')

  return { profile, out }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Applies the mirror schema and clears any existing rows, child-first. */
export async function resetSchema(db: Client): Promise<void> {
  await db.executeMultiple(MIRROR_SCHEMA)
  for (const table of MIRROR_TABLES) {
    await db.execute(`DELETE FROM ${table}`)
  }
}

/**
 * A seed row, typed structurally rather than with an index signature: the row
 * interfaces in generate.ts declare named fields, which do not satisfy
 * `Record<string, unknown>` under `strict`.
 */
type SeedRow = object

function insertStatement(table: string, row: SeedRow) {
  const entries = Object.entries(row)
  const placeholders = entries.map(() => '?').join(', ')
  const columns = entries.map(([column]) => column).join(', ')
  return {
    sql: `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`,
    args: entries.map(([, value]) => value as InValue),
  }
}

export async function writeSeedData(db: Client, data: SeedData): Promise<void> {
  // One batch per table. libsql's batch is transactional, so a malformed row
  // leaves no half-seeded database behind.
  const tables: Array<[string, readonly SeedRow[]]> = [
    ['listings', data.listings],
    ['scores', data.scores],
    ['visual_scores', data.visual_scores],
    ['commute', data.commute],
    ['amenities', data.amenities],
    ['hosted_photos', data.hosted_photos],
  ]

  for (const [table, rows] of tables) {
    if (rows.length === 0) continue
    await db.batch(rows.map((row) => insertStatement(table, row)))
  }
}

async function seedGenerated(profile: SeedProfile, out: string): Promise<void> {
  const db = createClient({ url: `file:${out}` })
  try {
    await resetSchema(db)
    await writeSeedData(db, generate(profile))
  } finally {
    db.close()
  }
}

async function seedRealistic(out: string): Promise<void> {
  if (!(await exists(REALISTIC_FIXTURE))) {
    throw new Error(
      `missing ${REALISTIC_FIXTURE}\n` +
        "The 'realistic' profile is a committed fixture derived from the real\n" +
        'mirror by scripts/seed/anonymize.ts. Regenerate it with:\n' +
        '  node scripts/seed/anonymize.ts\n' +
        '(requires ~/code/home-search checked out), or seed a generated profile:\n' +
        '  npm run seed -- --profile edge-cases',
    )
  }
  await copyFile(REALISTIC_FIXTURE, out)
}

async function summarize(out: string): Promise<Record<string, number>> {
  const db = createClient({ url: `file:${out}` })
  try {
    const counts: Record<string, number> = {}
    for (const table of MIRROR_TABLES) {
      const result = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)
      counts[table] = Number(result.rows[0]!.n)
    }
    return counts
  } finally {
    db.close()
  }
}

export async function seed(options: Options): Promise<void> {
  await mkdir(dirname(options.out), { recursive: true })

  if (options.profile === 'realistic') {
    await seedRealistic(options.out)
  } else {
    await seedGenerated(options.profile, options.out)
  }

  await writeFile(profileMarkerPath(options.out), options.profile, 'utf8')

  const counts = await summarize(options.out)
  const detail = Object.entries(counts)
    .map(([table, n]) => `${table}=${n}`)
    .join(' ')
  console.log(`seeded ${options.out} profile=${options.profile} ${detail}`)
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  seed(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}

export { parseArgs }
