'use client'

import { useState } from 'react'

/**
 * Shows a known HOA fee as either an annual or a monthly figure, with a split
 * button to switch between them.
 *
 * Only rendered when there is an actual fee to divide. `hoa_annual` is NULL for
 * a listing that never disclosed one and 0 for a confirmed absence of HOA --
 * neither is a number worth offering two views of, so the detail page renders
 * plain text for those and only reaches for this component when the fee is
 * positive.
 *
 * Upstream stores the fee already annualized (a "$250/month" listing is saved
 * as 3000), so annual is the stored value and monthly is the derived one. That
 * is why annual is the default: it is the figure the pipeline actually scored
 * against, and the monthly number is a convenience.
 */
export function HoaFigure({ hoaAnnual }: { hoaAnnual: number }) {
  const [basis, setBasis] = useState<'yr' | 'mo'>('yr')

  const amount = basis === 'yr' ? hoaAnnual : hoaAnnual / 12
  // Whole dollars for the annual figure; the monthly one keeps cents when the
  // division is not clean, so $3,050/yr reads as $254.17/mo rather than a $254
  // that quietly loses two dollars a year.
  const formatted =
    basis === 'yr'
      ? `$${Math.round(amount).toLocaleString()}`
      : `$${amount.toLocaleString(undefined, {
          minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
          maximumFractionDigits: 2,
        })}`

  return (
    <>
      <div className="v warn hoa-figure">
        {formatted}
        <span className="hoa-basis">/{basis}</span>
      </div>
      <div className="hoa-toggle" role="group" aria-label="Show HOA fee per year or per month">
        <button
          type="button"
          className={basis === 'yr' ? 'active' : ''}
          aria-pressed={basis === 'yr'}
          onClick={() => setBasis('yr')}
        >
          Yearly
        </button>
        <button
          type="button"
          className={basis === 'mo' ? 'active' : ''}
          aria-pressed={basis === 'mo'}
          onClick={() => setBasis('mo')}
        >
          Monthly
        </button>
      </div>
    </>
  )
}
