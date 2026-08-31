/**
 * Pure display-derivation helpers for the listing detail view.
 *
 * These read columns that arrive from a Turso mirror which only changes when
 * `home-search/publish.py` runs, so every one of them must render sensibly in
 * three states, not two: a real value, an explicit NULL, and `undefined` — the
 * last being what `l.*` yields against a mirror that predates the migration and
 * therefore has no such key at all. NULL and undefined are treated identically.
 *
 * The branching lives here, in a tested module, rather than inline in the page,
 * matching this repo's convention of unit-testing the data layer and leaving
 * the pages untested.
 */

type Fact = { text: string; cls: string; sub?: string }

const NOT_AVAILABLE: Fact = { text: 'Not available', cls: 'muted' }

/** Compass rounds its assessor figures, producing ±1-2 sqft noise against the
 *  MLS number. Only call out a shortfall bigger than that. */
const SQFT_TOLERANCE = 10

function present(value: number | null | undefined): value is number {
  return value !== null && value !== undefined
}

/**
 * Whole dollars when the amount is clean, cents when it is not: $250 rather
 * than $250.00, but $254.17 rather than a $254 that quietly loses two dollars
 * a year. Moved verbatim from the detail page, which now imports it — the HOA
 * card's output depends on this exact behavior.
 */
export function fmtMoney(amount: number): string {
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * Annual property tax with a derived monthly figure, mirroring how the HOA card
 * already presents a yearly and monthly pair.
 *
 * Takes no assessment year: the plan assumed a `property_tax_year` column, but
 * upstream did not store one (verified against src/db.py::_SCHEMA at a4270bd),
 * so there is no year to label and no perpetual-null parameter to carry.
 */
export function propertyTaxFact(taxAnnual: number | null | undefined): Fact {
  if (!present(taxAnnual)) return NOT_AVAILABLE
  return {
    text: `${fmtMoney(Math.round(taxAnnual))}/yr · ${fmtMoney(taxAnnual / 12)}/mo`,
    cls: '',
  }
}

/**
 * Basement and the finished-vs-listed square footage split.
 *
 * The three-state encoding matters and is not symmetric:
 *   - above-grade missing  -> not backfilled yet, say nothing confident
 *   - above-grade present, below-grade absent or 0 -> a CONFIRMED "no basement"
 *     (Compass omits the key exactly when it reports Basement: No)
 *   - both present -> a real finished-area split
 *
 * The sub-line exists to head off an apparent arithmetic error: the assessor's
 * finished area is strictly less than the MLS listed sqft on 45 of 85 listings
 * (median gap ~187), so printing "1,404 above + 360 below" beside a headline of
 * 1,804 looks broken unless the shortfall is named outright.
 */
export function basementFact(
  listedSqft: number | null | undefined,
  aboveGrade: number | null | undefined,
  belowGrade: number | null | undefined,
): Fact {
  if (!present(aboveGrade)) return NOT_AVAILABLE

  const above = `${aboveGrade.toLocaleString()} sqft finished above grade`

  if (!present(belowGrade) || belowGrade === 0) {
    return { text: 'None', cls: '', sub: above }
  }

  const finished = aboveGrade + belowGrade
  // Only when the listed figure is known AND exceeds the finished total by more
  // than rounding noise. A negative shortfall is never rendered.
  const shortfall = present(listedSqft) && listedSqft - finished > SQFT_TOLERANCE
  const sub = shortfall
    ? `${above} · finished total ${finished.toLocaleString()} of ${listedSqft.toLocaleString()} listed`
    : above

  return { text: `${belowGrade.toLocaleString()} sqft below grade`, cls: '', sub }
}

/**
 * The combined monthly carrying cost line.
 *
 * Upstream deliberately did not mirror Compass's precomputed
 * `monthlySalesChargesInclTaxes`, to avoid implying a scored cost factor, so
 * callers derive this from HOA plus tax. Zero is treated as nothing to say
 * rather than "$0/mo" — a listing with no HOA and no known tax has no carrying
 * cost worth asserting.
 */
export function monthlyCostLine(monthlyCost: number | null | undefined): string | null {
  if (!present(monthlyCost) || monthlyCost <= 0) return null
  return `${fmtMoney(monthlyCost)}/mo taxes & HOA`
}
