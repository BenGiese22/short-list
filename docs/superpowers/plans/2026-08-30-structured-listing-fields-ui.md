# Structured Listing Fields UI — Property Tax, Sqft Split, Cost of Ownership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the structured Compass fields the `home-search` pipeline is about to
start reading — property tax, above/below-grade square footage, and a combined monthly
carrying cost — and adapt the existing HOA display to a world where `hoa_annual` goes
from 4/85 populated to 85/85.

**Context:** This plan builds ON the five commits already on `bgiese/hoa-ui`
(`3675782..d339ac1`), which correctly implement the seven-factor score breakdown
(rescaled `WEIGHTS` summing to 100), the `hoa_annual`-driven HOA fact card
(NULL → "Not disclosed", 0 → "None", >0 → yearly + monthly figures), and the seventh
HOA score bar. **None of that is re-planned or restyled here.** Where the new upstream
data invalidates an assumption baked into those commits, this plan says so explicitly
(see "Assumptions the new data changes" below).

**Upstream:** The `home-search` pipeline currently regex-mines HOA from free-text
`description` — structurally broken, since the Compass collection API omits
`description` and 78/85 listings have an empty one. It is switching to structured
sources (confirmed live against all 85 listings):

- **HOA** — `price.charges[chargeType==2]` (annual) / `price.monthlySalesCharges`
  (monthly), with `detailedInfo.listingDetails["Association"]` as ground truth.
  Resolves all 85/85 with certainty: **8 listings have a real fee, 77 have none.**
- **Property tax** — `detailedInfo.assessorDetails.assessorInfo.propertyTax.{tax,
  monthlyTax, taxYear}`, ~96% coverage.
- **Combined monthly carrying cost** — `price.monthlySalesChargesInclTaxes`,
  present on **85/85**. HOA + tax, precomputed by Compass.
- **Sqft split** — `size.aboveGradeTotalAreaSquareFeet` (85/85) /
  `belowGradeTotalAreaSquareFeet` (74/85; **absent exactly when Basement == "No"**,
  so absence means "no basement", not "missing data"). Caution: above+below is
  assessor *finished* area; `squareFeet` is the MLS total-footprint figure. They
  match on only 40/85 listings; on the other 45 the finished sum is strictly less
  (shortfall 2–1560 sqft, median ~187). A naive "X above + Y below" beside the
  headline sqft will look like an arithmetic error on 53% of listings.

**Column names are NOT final.** The `home-search` plan is being written in parallel.
This plan is written against the *semantics* above using placeholder names; Task 0 is
a hard gate that confirms the real names before any code is written.

**Tech stack:** unchanged — Next.js 16 App Router + Cache Components, `@libsql/client`
against the Turso mirror, vitest against `:memory:` libSQL, ported-mockup CSS in
`app/globals.css` (no Tailwind, no component library).

## Column names — CONFIRMED (Task 0 gate closed)

Verified directly against `home-search` `src/db.py::_SCHEMA` on `origin/main` at
`a4270bd` (PR #7, merged), not from a message. All on `listings`, all nullable, no new
tables — so the "`l.*` for free" degradation argument holds and there is no FK/orphan
work.

| Actual column            | Type    | Semantics                                    | Coverage (85 listings) |
|--------------------------|---------|----------------------------------------------|------------------------|
| `tax_annual`             | REAL    | annual property tax in dollars               | 84/85                  |
| `sqft_above_grade`       | INTEGER | finished sqft above grade                    | 84/85                  |
| `sqft_below_grade`       | INTEGER | finished sqft below grade; NULL ⇒ no basement | 74/85                  |
| `outdoor_spaces`         | TEXT    | JSON array, e.g. `["Deck","Patio"]`          | 78/85                  |

**Two planned columns do not exist**, so the plan's assumptions change:

- **`property_tax_year` is NOT stored.** Drop the year label from `propertyTaxFact`
  entirely rather than passing a perpetual null.
- **`monthly_cost` is NOT stored.** `monthlySalesChargesInclTaxes` was deliberately
  not mirrored, to avoid implying a scored cost factor. The combined carrying cost
  must be derived: `COALESCE(hoa_annual,0)/12 + tax_annual/12`. That means the plan's
  "no NULL algebra" argument is gone and the derivation has to handle a missing
  `tax_annual` (1 listing) explicitly.
- **`outdoor_spaces` is new** and was not in this plan at all. Populated 78/85 and
  already feeding photo scoring upstream — available now, not a follow-on.

Other gate answers, all confirmed against the live database:

- `hoa_annual` semantics unchanged: annual dollars, `0` = confirmed none, NULL =
  unknown. `Association: Yes` with no resolvable amount writes NULL, never 0.
  Post-backfill reality: **9 real fees / 75 confirmed none / 1 unknown** (the plan
  predicted 8/77). Fees range **$35–$3,420/yr**, so a derived monthly figure reads as
  low as **$3/mo** — small values are the norm here, not an edge case.
- `has_incomplete_data` definition unchanged, but its firing rate collapsed from
  **82/85 to 19/85** now that HOA resolves. Assumption 4 below holds: change nothing.
- No-basement convention confirmed: `sqft_below_grade IS NULL` means no basement
  (Compass omits the key exactly when it reports `Basement: No`); `0` means a
  basement with no finished area. Both are real data.
- **`score_sqft` now scores finished area, not the MLS `sqft` this UI displays.**
  Rankings moved for 77 of 83 listings, up to 43 places. The Sqft stat and $/sqft stay
  the MLS figure, so the sqft stat and the Sqft score bar can look inconsistent — the
  Basement/sqft-split card is where that gets explained.

## Global Constraints

- The five `bgiese/hoa-ui` commits are the base. `hoaFact()`, the seven-bar breakdown,
  `WEIGHTS`, and the HOA fact card are not redesigned, restyled, or moved.
- **Graceful degradation is a hard requirement with a test.** This UI reads a Turso
  mirror that only changes when `home-search/publish.py` runs. `turso_sync.py`'s
  `ensure_schema()` already ALTERs missing columns into the mirror
  (`_migrate_missing_columns`), so the post-migration/pre-backfill state is "columns
  exist, every value NULL". Every new UI element must render sensibly (muted
  "Not available", or render nothing) in that state, and Task 2 pins it with a test.
  Additionally, no *always-executed* SQL may name a new column explicitly — new
  `listings` columns arrive via the existing `l.*` selects for free, which also keeps
  the page alive against a mirror that predates the migration entirely. The one
  exception is the opt-in cost sort (Task 5), which is sequenced after the mirror is
  confirmed migrated.
- The `Map`-based `SORT_COLUMNS` pattern in `lib/queries.ts` (prototype-pollution-safe
  lookup with composite fallback) is preserved. The new cost sort goes through the
  same explicit `if`-chain that `value`/`price` already use — never string
  interpolation of user input.
- `lib/queries.test.ts`'s inline CREATE TABLE fixtures must mirror the new columns
  the moment they are known (Task 2), including at least one row where all of them
  are NULL.
- New display-derivation logic with real branching lives in a testable `lib/` module
  (`lib/facts.ts`), matching the repo's "unit-test data-layer branching, don't e2e
  the pages" philosophy.
- Each task is a single commit, in dependency order.

## Assumptions the new data changes in the existing HOA commits

1. **`lib/queries.test.ts` line ~146**: the comment "81 of 85 production listings are
   in this state" (NULL `hoa_annual`) inverts after backfill — post-change it is
   0/85, with 77 confirmed-none and 8 real fees. Update the comment in Task 2; the
   *behavior* (NULL must surface as NULL, distinct from 0) stays and stays tested,
   because NULL remains the pre-backfill and any-future-source-gap state.
2. **`hoaFact()`'s "Not disclosed" branch** becomes a transient/rare state rather than
   the 95% case. No code change — the branch is still required — but the detail page
   stops looking like a wall of "Not disclosed".
3. **`app/listing/[id]/page.tsx` line ~235**: the composite caption still reads
   "weighted across the six factors below" while seven bars render beneath it — a
   leftover from before the HOA bar landed. Fix to "seven" in Task 3 (drive-by,
   same file, same commit).
4. **The "Est. data" pill / "Data quality" card** (`has_incomplete_data`): today it
   fires on 82/85 listings (96%) *because* unknown HOA sets it upstream, making it
   pure noise. Once HOA is structured, that self-resolves in the data — the flag
   becomes meaningful again with zero UI changes. **Decision: change nothing in the
   UI, in either the interim or the end state.** Do not build a workaround for a
   transient condition that one `publish.py` run after the upstream merge fixes; the
   badge renders whatever the mirror says, before and after.
5. **The `hoa_score`-not-selected-on-cards pattern** (tested in queries.test.ts):
   its stated rationale ("would break the list page against a mirror not yet synced")
   generalizes to every new column here — which is why Tasks 1–4 add *no* new
   explicit column references to `buildListingsQuery` at all.

---

## Task 0 — Gate: confirm upstream facts (no code, no commit)

Do not start Task 1 until every row below is confirmed against the merged
`home-search` plan (or its landed code, `src/db.py::_SCHEMA` being the source of
truth). Record answers by editing the placeholder table above in this document.

- [ ] Exact names/types of the property tax columns, and that they live on `listings`
      (not a new table — if a new table, Tasks 2/3/5 need a JOIN and this plan's
      "`l.*` for free" degradation argument must be re-derived).
- [ ] Whether `taxYear` is stored at all (labeling only; degrade to no year label).
- [ ] Whether `monthlySalesChargesInclTaxes` is stored (the `monthly_cost`
      placeholder). **The cost-of-ownership view (Tasks 3/5) is built on it.** If
      upstream declines to store it, fall back to deriving
      `COALESCE(hoa_annual,0)/12 + property_tax_annual/12` — but push for the stored
      field first: it is 85/85 present, authoritative, and needs no NULL algebra.
- [ ] Exact names of the above/below-grade columns, and the storage convention for
      "no basement": NULL (mirroring Compass's absent key) vs 0. This plan assumes
      NULL-or-0 both mean "no basement" *when* `above_grade_sqft` is present, and
      "not backfilled" when it is not; `basementFact()` in Task 1 encodes exactly
      that. If upstream normalizes differently, adjust that one function.
- [ ] `hoa_annual` semantics survive the source switch unchanged: annual dollars,
      `0` = confirmed no HOA (Association == "No"), NULL = genuinely unknown. Confirm
      what upstream writes for Association == "Yes" with no parseable amount
      (expected: NULL).
- [ ] Whether the `has_incomplete_data` definition changes (today it includes
      `hoa_annual is None` — see `src/scoring.py` ~line 310). Specifically: does
      missing *property tax* get added to it? At ~4% missing that would be fine;
      just confirm so the "Data quality" card's meaning is known.
- [ ] That a `publish.py` run is scheduled after the upstream migration merges —
      Task 5 (cost sort) and Task 6 (verification) sequence after it.
- [ ] Note as possible follow-ons (NOT in this plan): `detailedInfo.schools`,
      `detailedInfo.outdoorSpace`, `garageSpaces` (differs from total parking on 33%
      of listings — would sharpen the existing garage card), `mlsStatus`
      (Active 76 / Pending 4 / Closed 3 / Coming Soon 2 — a status pill would be the
      first card-level use). Only plan these once upstream commits to storing them.

---

## Task 1 — `lib/facts.ts`: pure display-derivation helpers

**Files:**
- Create: `short-list/lib/facts.ts`
- Test: `short-list/lib/facts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fmtMoney(amount: number): string` (moved verbatim from
  `app/listing/[id]/page.tsx` — same behavior: whole dollars when clean, cents when
  not), `propertyTaxFact(taxAnnual, taxYear)`, `basementFact(sqft, aboveGrade,
  belowGrade)`, `monthlyCostLine(monthlyCost)`. All accept `number | null |
  undefined` — `undefined` because a pre-migration mirror's `l.*` simply lacks the
  key — and treat the two identically.

The libSQL `Row` values arrive untyped; these helpers are where NULL-handling
branching lives, so they get the unit tests (pages stay untested, per repo
convention). Shape mirrors the existing `hoaFact()` return: `{ text, cls, sub? }`
against the existing `.fact-card` CSS (`v`, `v.warn`, `v.muted`, `.sub`).
**`hoaFact()` itself stays in `page.tsx`, untouched.**

- [ ] **Step 1: Write the failing tests**

```ts
// short-list/lib/facts.test.ts
import { describe, it, expect } from 'vitest'
import { propertyTaxFact, basementFact, monthlyCostLine, fmtMoney } from './facts'

describe('propertyTaxFact', () => {
  it('renders annual and derived monthly with the assessment year', () => {
    const f = propertyTaxFact(3160, 2025)
    expect(f.text).toBe('$3,160/yr · $263.33/mo')
    expect(f.sub).toBe('2025 assessor figure')
    expect(f.cls).toBe('')
  })
  it('omits the year label when taxYear is unknown', () => {
    expect(propertyTaxFact(3160, null).sub).toBeUndefined()
  })
  it('is muted Not available for NULL and for undefined (pre-migration mirror)', () => {
    expect(propertyTaxFact(null, null)).toEqual({ text: 'Not available', cls: 'muted' })
    expect(propertyTaxFact(undefined, undefined)).toEqual({ text: 'Not available', cls: 'muted' })
  })
})

describe('basementFact', () => {
  // above_grade is present on 85/85 post-backfill, so its absence is the
  // "not yet backfilled" sentinel; below-grade absence with above present
  // means a confirmed "no basement" (verified: missing on exactly the 11
  // listings where Compass says Basement == "No").
  it('is muted Not available when above-grade is missing (pre-backfill)', () => {
    expect(basementFact(1804, null, null)).toEqual({ text: 'Not available', cls: 'muted' })
  })
  it('is a definite None when above-grade is known and below-grade is absent or zero', () => {
    expect(basementFact(1404, 1404, null).text).toBe('None')
    expect(basementFact(1404, 1404, 0).text).toBe('None')
  })
  it('shows finished below-grade sqft, with above-grade in the sub-line', () => {
    const f = basementFact(1764, 1404, 360)
    expect(f.text).toBe('360 sqft below grade')
    expect(f.sub).toBe('1,404 sqft finished above grade')
  })
  it('discloses the finished-vs-listed shortfall instead of implying a broken sum', () => {
    // 45/85 listings: assessor finished area < MLS listed sqft (median gap ~187).
    const f = basementFact(1804, 1404, 360)
    expect(f.sub).toBe('1,404 sqft finished above grade · finished total 1,764 of 1,804 listed')
  })
  it('does not fabricate a shortfall when the listed sqft itself is unknown', () => {
    expect(basementFact(null, 1404, 360).sub).toBe('1,404 sqft finished above grade')
  })
})

describe('monthlyCostLine', () => {
  it('renders the combined carrying cost', () => {
    expect(monthlyCostLine(328.4)).toBe('$328.40/mo taxes & HOA')
  })
  it('renders nothing for NULL, undefined, or zero', () => {
    expect(monthlyCostLine(null)).toBeNull()
    expect(monthlyCostLine(undefined)).toBeNull()
    expect(monthlyCostLine(0)).toBeNull()
  })
})

describe('fmtMoney (moved from the detail page, behavior identical)', () => {
  it('whole dollars stay whole, uneven divisions keep cents', () => {
    expect(fmtMoney(782)).toBe('$782')
    expect(fmtMoney(1000 / 12)).toBe('$83.33')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd short-list && npx vitest run lib/facts.test.ts`
Expected: FAIL — `lib/facts.ts` doesn't exist.

- [ ] **Step 3: Write `lib/facts.ts`**

Implementation notes (full code left to the implementer, tests are the contract):
- `fmtMoney` is a verbatim move of the existing function from
  `app/listing/[id]/page.tsx` (do NOT change its rounding behavior; the HOA card
  depends on it). The page starts importing it in Task 3.
- `basementFact(listedSqft, aboveGrade, belowGrade)`: the shortfall sub-line only
  appears when `listedSqft` is known and exceeds `aboveGrade + belowGrade` by more
  than a small tolerance (use 10 sqft — Compass rounding produces ±1–2). Never show
  a *negative* shortfall (finished > listed never occurred in 85/85, but don't
  crash if it does — just omit the comparison).
- `propertyTaxFact` derives monthly as `taxAnnual / 12` through `fmtMoney`, matching
  how the HOA card derives its monthly figure. Treat `taxAnnual === 0` as a real $0
  (render `$0/yr`), unlike HOA where 0 has a special "None" meaning — a $0 tax
  assessment is data, not absence.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd short-list && npx vitest run lib/facts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd short-list
git add lib/facts.ts lib/facts.test.ts
git commit -m "feat: add null-safe derivation helpers for tax, basement, and carrying cost"
```

---

## Task 2 — Test fixtures mirror the new schema; degradation pinned by test

**Files:**
- Modify: `short-list/lib/queries.test.ts`
- Modify: `short-list/lib/queries.ts` — **only if** Task 0 revealed the columns live
  outside `listings`; otherwise queries.ts is untouched (this is the point).

**Interfaces:**
- Consumes: confirmed column names from Task 0.
- Produces: fixtures every later task's tests run against.

`buildListingsQuery` and `getListing` both select `l.*`, so every new `listings`
column flows to both views with zero query changes — and, symmetrically, a mirror
that predates the migration simply yields `undefined` on row access, which Task 1's
helpers already absorb. This task makes the fixtures tell the truth and pins the
post-migration/pre-backfill state.

- [ ] **Step 1: Extend the inline CREATE TABLE fixture**

In `seed()`, extend the `listings` DDL with the confirmed columns (placeholder
names shown): `property_tax_annual REAL, property_tax_year INTEGER, monthly_cost
REAL, above_grade_sqft INTEGER, below_grade_sqft INTEGER`. Extend the existing
INSERTs for 'a' and 'b': give 'a' fully populated values (e.g. tax 3160/2025,
monthly_cost 328.33, 1404 above / 360 below) and give 'b' **all NULLs** for the new
columns — 'b' is now the canonical post-migration/pre-backfill row.

- [ ] **Step 2: Update the stale HOA comment**

The "81 of 85 production listings are in this state" comment on the NULL-`hoa_annual`
test is inverted by the upstream change (post-backfill: 0/85 NULL; 77 confirmed-none,
8 real fees). Reword to state that NULL is now the *pre-backfill / source-gap* state
the UI must still distinguish from a confirmed $0. Keep the test itself.

- [ ] **Step 3: Add the graceful-degradation test**

```ts
describe('post-migration, pre-backfill mirror (new columns exist, all NULL)', () => {
  it('the list query returns such listings with NULLs and every sort still works', async () => {
    for (const sort of [undefined, 'composite', 'value', 'price', 'cost'] as const) {
      const { sql, args } = buildListingsQuery(sort ? { sort: sort as SortKey } : {})
      const result = await db.execute({ sql, args })
      const b = result.rows.find((r) => r.listing_id === 'b')!
      expect(b.property_tax_annual).toBeNull()
      expect(b.monthly_cost).toBeNull()
      expect(b.above_grade_sqft).toBeNull()
      expect(b.below_grade_sqft).toBeNull()
    }
  })
})
```

(The `'cost'` entry fails until Task 5 defines the key — either add it in Task 5's
commit instead, or add the key in Task 5 and the loop entry here with a
`@ts-expect-error` removed in Task 5. Implementer's choice; the loop must include
`'cost'` by the end of Task 5.)

- [ ] **Step 4: Run the full suite**

Run: `cd short-list && npx vitest run`
Expected: PASS (all existing tests, plus the new one, against the extended fixture).

- [ ] **Step 5: Commit**

```bash
git add lib/queries.test.ts
git commit -m "test: mirror the structured-fields schema in fixtures and pin NULL degradation"
```

---

## Task 3 — Detail page: property tax, basement, carrying cost

**Files:**
- Modify: `short-list/app/listing/[id]/page.tsx`
- Modify: `short-list/app/globals.css` (a few lines at most)

**Interfaces:**
- Consumes: `propertyTaxFact`, `basementFact`, `monthlyCostLine`, `fmtMoney` (Task 1).
- Produces: the finished detail view.

Placement decisions (the opinionated part):

1. **Property tax → a new fact card** in the existing "Facts worth knowing" grid,
   placed immediately after the HOA card so the two recurring costs sit together.
   Value from `propertyTaxFact(l.property_tax_annual, l.property_tax_year)`; reuse
   the `hoa-v` tabular-numerals class for the value line. NULL renders the muted
   "Not available" — never invent a number.
2. **Sqft split → a new "Basement" fact card**, NOT a change to the stat-strip. The
   headline Sqft stat stays the MLS figure (it's what drives price/sqft and what
   Compass shows). The card is framed around the question a buyer actually has —
   "is there a basement, and how much finished space is down there?" — because
   below-grade absence is a *definite no* on this corpus, and because framing the
   split as "finished area" with an explicit "finished total X of Y listed" sub-line
   is the honest presentation of the 53% of listings where assessor-finished <
   MLS-listed. Do NOT render "1,404 above + 360 below" adjacent to an 1,804 headline
   with no qualifier — on half the corpus that reads as an arithmetic error.
3. **Carrying cost → one line under the price** in `.detail-head`:
   `monthlyCostLine(l.monthly_cost)` rendered as a small muted line (new
   `.cost-line` class, ~2 CSS declarations reusing existing tokens) directly beneath
   `.detail-price`, e.g. "$328.40/mo taxes & HOA". **Recommendation: yes, surface
   it, but exactly this small.** The number is Compass's own
   (`monthlySalesChargesInclTaxes`, 85/85), it's the genuinely new capability
   (monthly carrying beyond mortgage), and it belongs next to the price it
   qualifies. A dedicated "Cost of ownership" *section* is rejected: it would
   restate two fact cards and one line of arithmetic under a heading, and the HOA
   commits already established that cost details live in the facts grid. No UI-side
   arithmetic combining HOA + tax — if `monthly_cost` is NULL, render nothing; the
   components still show individually in their cards.
4. **Drive-by fix:** composite caption "weighted across the six factors below" →
   "seven factors" (stale since the HOA bar landed).
5. Replace the local `fmtMoney` with the import from `lib/facts.ts` (verbatim move;
   `hoaFact` continues using it unchanged).

- [ ] **Step 1: Implement the four changes above**
- [ ] **Step 2: Manual verification (against a pre-backfill mirror if that's what's live)**

Run: `cd short-list && npm run dev`. Every listing must render: new cards show muted
"Not available" while the mirror is NULL, no crashes, no "NaN", no "$null". HOA card,
seven bars, and existing layout unchanged.

- [ ] **Step 3: Commit**

```bash
git add app/listing/[id]/page.tsx app/globals.css
git commit -m "feat(ui): add property tax, basement, and monthly carrying cost to the detail view"
```

---

## Task 4 — List cards: HOA fee pill only where a fee exists

**Files:**
- Modify: `short-list/app/page.tsx`
- Modify: `short-list/app/globals.css` (one `.b-pill` variant if needed)

**Recommendation and rationale (be opinionated, per the brief):**
- **HOA on cards: only when `hoa_annual > 0`,** as a warn-toned pill in the existing
  `badges-inline` row, e.g. `⚠ $65/mo HOA`. Post-backfill, ~91% of listings are a
  definite "None" — printing "No HOA" on 77 of 85 cards is noise; a fee pill on 8
  cards is exactly the signal a scanner wants (it marks the exceptions). NULL
  (pre-backfill) renders nothing, which is also correct. `hoa_annual` already
  reaches the card query via `l.*` and has a test asserting so — no query change.
- **Property tax on cards: no.** It's roughly proportional to price on this corpus,
  so it adds no ranking information the price doesn't already carry; it earns its
  place on the detail page only.
- **Sqft split on cards: no.** Cards already show the MLS sqft; the split needs its
  qualifier text to be honest, and cards have no room for qualifiers.
- **Monthly carrying cost on cards: deferred to Task 5,** where it rides along with
  the cost sort so the sorted order is legible — a cost mini-stat with no cost sort,
  or vice versa, is half a feature.

- [ ] **Step 1: Add the conditional pill** (monthly figure via
      `fmtMoney(hoaAnnual / 12)` from `lib/facts.ts`; monthly, not annual — it scans
      faster against the price and matches how people budget)
- [ ] **Step 2: Manual verification** — with a backfilled mirror, exactly the fee
      listings show it (QA anchors: 3123 West 105th Court $782/yr → $65.17/mo,
      8052 Fenton Court $864/yr → $72/mo, 10191 Zenobia Circle $1,000/yr → $83.33/mo);
      with a NULL mirror, no card changes at all.
- [ ] **Step 3: Commit**

```bash
git add app/page.tsx app/globals.css
git commit -m "feat(ui): flag the rare real HOA fee on list cards"
```

---

## Task 5 — Cost sort + card cost mini-stat (GATED: mirror must be migrated)

**Do not start until one `publish.py` run has executed against the upstream code that
adds the columns** — this task is the only place a new column is named in
always-executed-when-selected SQL (`ORDER BY l.monthly_cost`), and selecting the sort
against an unmigrated mirror would 500 the list page. Verify first (read-only):
`SELECT monthly_cost FROM listings LIMIT 1` via the Turso CLI/dashboard.

**Files:**
- Modify: `short-list/lib/queries.ts`
- Modify: `short-list/lib/queries.test.ts`
- Modify: `short-list/app/ListControls.tsx`
- Modify: `short-list/app/page.tsx`

- [ ] **Step 1: Failing tests** — `sort: 'cost'` orders ascending by `monthly_cost`
      with NULLs last (listing 'b', all-NULL, sorts after 'a'); the Task 2
      degradation loop now includes `'cost'`; `'__proto__'`/unknown-key fallback
      tests still pass (the Map is untouched).
- [ ] **Step 2: Implement.** Add `'cost'` to `SortKey`. **Do NOT add it to
      `SORT_COLUMNS`** — the Map remains exclusively the DESC score-column lookup
      with its prototype-safe fallback. `'cost'` joins `'value'`/`'price'` in the
      explicit `if`-chain: `ORDER BY l.monthly_cost ASC NULLS LAST` (cheapest
      carrying cost first, matching `'price'`'s low-first convention).
- [ ] **Step 3: `ListControls.tsx`** — add `{ value: 'cost', label: 'Sort: Monthly cost (low first)' }`
      to `SORT_OPTIONS`, after the `price` entry.
- [ ] **Step 4: Card mini-stat** — in `page.tsx`'s existing `.mini-stats` group, add
      a third mini-stat rendering `monthly_cost` (rounded, `$` + `/mo cost` label)
      only when non-NULL, alongside the commute and outdoor mini-stats. This is what
      makes the cost sort legible on the list. Reaches the card via `l.*`.
- [ ] **Step 5:** `npx vitest run` — all pass. Manual: sort by monthly cost, confirm
      the three HOA-fee listings and high-tax listings order sensibly.
- [ ] **Step 6: Commit**

```bash
git add lib/queries.ts lib/queries.test.ts app/ListControls.tsx app/page.tsx
git commit -m "feat: sort by monthly carrying cost, with the figure shown on cards"
```

---

## Task 6 — End-to-end verification and deploy

**Files:** none.

- [ ] `npx vitest run` and `npm run build` clean.
- [ ] Against the backfilled production mirror, verify: (a) the three fee listings
      show correct HOA and carrying-cost figures on card and detail; (b) a
      no-basement listing (below-grade NULL, above present) shows "None" on the
      Basement card; (c) a shortfall listing (e.g. any where finished < listed)
      shows the "finished total X of Y listed" sub-line; (d) the "Est. data" pill
      count has collapsed from ~82 to the genuinely-incomplete handful; (e) an
      unknown-tax listing (~4%) shows muted "Not available".
- [ ] `vercel deploy --prod`.

---

## Open questions / risks

1. **Everything in Task 0** — column names, `monthly_cost` storage,
   basement-absence convention, `has_incomplete_data` definition — is unconfirmed
   until the parallel `home-search` plan lands. Semantics here are corpus-verified;
   names are not.
2. **Ordering risk:** Tasks 1–4 are safe to build and deploy against today's mirror
   (everything degrades to "Not available"/nothing). Task 5 is not — it is gated on
   a confirmed-migrated mirror. If deploys happen between tasks, this ordering is
   what keeps production alive.
3. **`monthly_cost` freshness:** it's a Compass-computed snapshot; if HOA or tax
   change upstream it may briefly disagree with the components shown in the fact
   cards. Accepted — same staleness model as every other mirrored field.
4. **Tolerance constant** in `basementFact` (10 sqft) is a guess at Compass rounding;
   verified shortfalls start at 2 sqft, so a couple of trivial "shortfall" sub-lines
   may appear. Cosmetic; tune against real render.
5. **Weights duplication hazard** (documented in the existing `WEIGHTS` comment)
   still stands: if the upstream plan touches `scoring.py` weights while adding
   these fields, `page.tsx` must be updated to match. Nothing in this plan changes
   weights.
6. **Possible follow-ons, explicitly not planned:** schools, outdoor-space
   amenities-from-structured-data, `garageSpaces` vs parking, `mlsStatus` pill —
   pending upstream storage decisions.
