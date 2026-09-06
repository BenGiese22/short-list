/**
 * A tiny seeded PRNG, so `SEED_PROFILE=edge-cases` produces a byte-identical
 * database every run.
 *
 * That determinism is the point: screenshots taken from two branches are only
 * comparable if the data behind them is the same, and a bug you find at
 * listing #14 has to still be at listing #14 after a reseed.
 *
 * mulberry32 — 32-bit state, good enough distribution for fixture data, and
 * short enough to read. Not for anything cryptographic.
 */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1))

  const float = (min: number, max: number, decimals = 2): number => {
    const raw = min + next() * (max - min)
    const factor = 10 ** decimals
    return Math.round(raw * factor) / factor
  }

  const pick = <T,>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('pick() from an empty list')
    return items[int(0, items.length - 1)]!
  }

  /** `true` with the given probability, e.g. `chance(0.3)` ~30% of the time. */
  const chance = (probability: number): boolean => next() < probability

  /** A shuffled copy. Fisher-Yates, so it stays uniform. */
  const shuffle = <T,>(items: readonly T[]): T[] => {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i)
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }

  return { next, int, float, pick, chance, shuffle }
}

export interface Rng {
  next(): number
  int(min: number, max: number): number
  float(min: number, max: number, decimals?: number): number
  pick<T>(items: readonly T[]): T
  chance(probability: number): boolean
  shuffle<T>(items: readonly T[]): T[]
}
