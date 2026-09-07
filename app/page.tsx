import Image from 'next/image'
import Link from 'next/link'
import { Suspense } from 'react'
import type { Row } from '@libsql/client'
import { availability, listStateParams, statusLabel } from '@/lib/status'
import { getListings, type SortKey } from '@/lib/queries'
import { fmtMoney } from '@/lib/facts'
import { ListControls } from './ListControls'
import { OwnerTools } from './OwnerTools'

export default function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  return (
    <>
      <header className="app">
        <div className="app-inner">
          <div className="brand">
            <h1>The Short List</h1>
          </div>
          <p className="tagline">
            Ranked homes from the Front Range search · Arvada · Broomfield · Westminster · Lafayette
          </p>
          <Suspense fallback={<div className="controls" />}>
            <ListControls />
          </Suspense>
          <Suspense fallback={null}>
            <OwnerTools />
          </Suspense>
        </div>
      </header>
      <main id="list-view">
        <Suspense fallback={<p>Loading…</p>}>
          <ListingCards searchParams={searchParams} />
        </Suspense>
      </main>
      <footer className="app-footer">
        Private list for Ben &amp; Megan · data from the home-search pipeline
      </footer>
    </>
  )
}

async function ListingCards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const listings = await getListings({
    search: params.search,
    sort: params.sort as SortKey | undefined,
    availability:
      params.availability === 'available' || params.availability === 'unavailable'
        ? params.availability
        : undefined,
  })

  if (listings.length === 0) {
    return <div className="empty-state">No listings match that search or filter.</div>
  }

  // Serialised once for the whole list rather than per card. Only the keys
  // that shape the list travel -- anything else in the URL is not list state
  // and has no business coming back on the return trip.
  const listParams = listStateParams(params)

  return (
    <>
      {listings.map((l) => (
        <ListingCard key={l.listing_id as string} listing={l} listParams={listParams} />
      ))}
    </>
  )
}

function fmtBaths(baths: number): string {
  return Number.isInteger(baths) ? String(baths) : baths.toFixed(1)
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v4M12 17.5v.1" />
    </svg>
  )
}

function ListingCard({ listing: l, listParams }: { listing: Row; listParams: string }) {
  const id = l.listing_id as string
  const address = l.address as string
  const city = l.city as string
  const state = l.state as string
  const beds = l.beds as number | null
  const baths = l.baths as number | null
  const sqft = l.sqft as number | null
  const priceNumeric = l.price_numeric as number | null
  const priceText = l.price as string | null
  const listingUrl = l.listing_url as string
  const thumbnailUrl = l.thumbnail_url as string | null

  const composite = l.composite as number | null
  const staged = l.watermarked_staging_detected === 1 || l.suspected_unwatermarked_staging === 1
  const belowCutoff = l.passes_filters === 0
  // NOT the market status. This is "the vision model never scored this
  // listing's photos", which used to render as a badge reading "Pending" --
  // so the two listings whose photo scoring had failed were labelled Pending
  // while all seven genuinely under contract showed nothing at all.
  const noPhotoScore = l.photo_score_unavailable === 1 || l.photo_score_unavailable === null
  const marketStatus = statusLabel(l.localized_status)
  const unavailable = availability(l.localized_status) === 'unavailable'
  const garageAttached = l.garage_attached as number | null
  const hasIncompleteData = l.has_incomplete_data === 1
  // The Medtronic (Lafayette) leg, which is the one the score is built on.
  // This showed denver_minutes until 2026-09-05 -- a different destination
  // from the one commute_score measures, so sorting by commute reordered the
  // list by a number the cards did not display.
  //
  // Still guarded: a listing whose address will not geocode has no commute
  // at all, and must render nothing rather than "null min".
  const commuteMinutes = l.medtronic_minutes as number | null
  const outdoor = l.outdoor_score as number | null
  // Only a real fee earns a pill. Post-backfill ~88% of listings are a definite
  // "None", so printing that on 75 of 85 cards would be noise -- the pill marks
  // the exceptions. NULL (pre-backfill, or a source gap) also renders nothing,
  // which is the right answer for "unknown" too.
  const hoaAnnual = l.hoa_annual as number | null
  // Same derivation and the same both-inputs-known rule as the cost sort's
  // ORDER BY, so the number shown on a card always matches the order it sorts
  // into. Arrives via l.* -- no column named in the card query.
  const taxAnnual = l.tax_annual as number | null
  const monthlyCost =
    taxAnnual !== null && taxAnnual !== undefined && hoaAnnual !== null && hoaAnnual !== undefined
      ? (taxAnnual + hoaAnnual) / 12
      : null

  const value =
    composite !== null && priceNumeric !== null && priceNumeric > 0
      ? composite / (priceNumeric / 100000)
      : null

  // The list's own state rides along, so the detail page's back link can put
  // the reader back where they were. Sort, search and filters all live in the
  // URL already; before this they were dropped by a hardcoded href="/".
  const href = listParams ? `/listing/${id}?${listParams}` : `/listing/${id}`

  return (
    <article className={`card${unavailable ? ' card-unavailable' : ''}`} data-id={id}>
      <Link href={href} className="card-open-link" aria-label={`Open ${address}`} />

      <div className="thumb-wrap">
        {thumbnailUrl ? (
          <Image src={thumbnailUrl} alt="" fill sizes="(max-width: 560px) 96px, 140px" />
        ) : null}
        {staged ? (
          <div className="thumb-flag">
            <WarnIcon />
          </div>
        ) : null}
      </div>

      <div className="card-main">
        <div className="row1">
          <div>
            <p className="addr">{address}</p>
            <p className="city">
              {city}, {state} &middot; {beds ?? '—'} bd &middot; {baths !== null ? fmtBaths(baths) : '—'} ba &middot;{' '}
              {sqft !== null ? sqft.toLocaleString() : '—'} sqft
            </p>
          </div>
          <div className="price">
            {priceNumeric !== null ? `$${priceNumeric.toLocaleString()}` : priceText ?? '—'}
          </div>
        </div>

        <div className="row2">
          <div className="badges-inline">
            {staged ? <span className="b-pill staged">⚠ Staged</span> : null}
            {belowCutoff ? <span className="b-pill cutoff">Below cutoff</span> : null}
            {marketStatus ? (
              <span className={`b-pill status${unavailable ? ' is-unavailable' : ''}`}>
                {marketStatus}
              </span>
            ) : null}
            {noPhotoScore ? <span className="b-pill no-photo-score">No photo score</span> : null}
            {garageAttached === 0 ? <span className="b-pill garage">Detached garage</span> : null}
            {garageAttached === 1 ? <span className="b-pill garage">Attached garage</span> : null}
            {hasIncompleteData ? <span className="b-pill est">Est. data</span> : null}
            {hoaAnnual !== null && hoaAnnual !== undefined && hoaAnnual > 0 ? (
              <span className="b-pill hoa">{fmtMoney(hoaAnnual / 12)}/mo HOA</span>
            ) : null}
          </div>
        </div>

        <div className="row3">
          {composite === null ? (
            <div className="composite-mini"><span className="n pending">Not scored</span></div>
          ) : (
            <div className="composite-mini"><span className="n">{Math.round(composite)}</span><span className="l">/100</span></div>
          )}
          <div className="mini-stats">
            {commuteMinutes !== null ? (
              <span className="mini-stat">
                <span className="n">{Math.round(commuteMinutes)}</span>
                <span className="l">min commute</span>
              </span>
            ) : null}
            {outdoor !== null ? (
              <span className="mini-stat">
                <span className="n">{Math.round(outdoor)}</span>
                <span className="l">outdoor</span>
              </span>
            ) : null}
            {monthlyCost !== null ? (
              <span className="mini-stat">
                <span className="n">${Math.round(monthlyCost).toLocaleString()}</span>
                <span className="l">/mo cost</span>
              </span>
            ) : null}
          </div>
          {value !== null ? <span className="value-mini">{value.toFixed(1)} pts/$100k</span> : null}
          <a className="compass-link" href={listingUrl} target="_blank" rel="noopener">
            Compass ↗
          </a>
        </div>
      </div>
    </article>
  )
}
