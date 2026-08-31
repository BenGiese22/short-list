import { describe, it, expect } from 'vitest'
import { propertyTaxFact, basementFact, monthlyCostLine, fmtMoney } from './facts'

describe('propertyTaxFact', () => {
  it('renders annual and derived monthly', () => {
    const f = propertyTaxFact(3160)
    expect(f.text).toBe('$3,160/yr · $263.33/mo')
    expect(f.cls).toBe('')
  })

  // The plan assumed a `property_tax_year` column for an assessment-year label.
  // Upstream did not store one (verified against src/db.py::_SCHEMA at a4270bd),
  // so there is no year to show and no parameter to pass.
  it('carries no assessment-year sub-line, because the year is not stored', () => {
    expect(propertyTaxFact(3160).sub).toBeUndefined()
  })

  it('is muted Not available for NULL and for undefined (pre-migration mirror)', () => {
    expect(propertyTaxFact(null)).toEqual({ text: 'Not available', cls: 'muted' })
    expect(propertyTaxFact(undefined)).toEqual({ text: 'Not available', cls: 'muted' })
  })
})

describe('basementFact', () => {
  // sqft_above_grade is present on 84/85, so its absence is the "not yet
  // backfilled" sentinel. Below-grade absence WITH above-grade present is a
  // confirmed "no basement" -- Compass omits the key exactly when it reports
  // Basement: No (74/85 have a value).
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
    // On 45/85 listings the assessor's finished area is strictly less than the
    // MLS listed sqft (median gap ~187), so "X above + Y below" printed beside
    // the headline sqft reads as an arithmetic error unless the gap is named.
    const f = basementFact(1804, 1404, 360)
    expect(f.sub).toBe('1,404 sqft finished above grade · finished total 1,764 of 1,804 listed')
  })

  it('ignores a shortfall inside Compass rounding tolerance', () => {
    expect(basementFact(1770, 1404, 360).sub).toBe('1,404 sqft finished above grade')
  })

  it('does not fabricate a shortfall when the listed sqft itself is unknown', () => {
    expect(basementFact(null, 1404, 360).sub).toBe('1,404 sqft finished above grade')
  })

  it('omits the comparison rather than showing a negative shortfall', () => {
    // Never observed in 85/85, but finished > listed must not render as
    // "finished total 1,764 of 1,700 listed".
    expect(basementFact(1700, 1404, 360).sub).toBe('1,404 sqft finished above grade')
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

  it('formats the small HOA fees this dataset actually contains', () => {
    // Real range is $35-$3,420/yr, so a derived monthly figure is as low as $3.
    expect(fmtMoney(35 / 12)).toBe('$2.92')
    expect(fmtMoney(3420 / 12)).toBe('$285')
  })
})
