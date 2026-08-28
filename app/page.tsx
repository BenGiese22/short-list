import Image from 'next/image'
import Link from 'next/link'
import { Suspense } from 'react'
import type { Row } from '@libsql/client'
import { getListings, type SortKey } from '@/lib/queries'
import { ListControls } from './ListControls'

const MINI_EQ_FIELDS: { key: string; label: string; column: string }[] = [
  { key: 'commute', label: 'Commute', column: 'commute_score' },
  { key: 'sqft', label: 'Sqft', column: 'sqft_score' },
  { key: 'condition', label: 'Condition', column: 'condition_score' },
  { key: 'outdoor', label: 'Outdoor', column: 'outdoor_score' },
  { key: 'room', label: 'Rooms', column: 'room_count_score' },
  { key: 'parking', label: 'Parking', column: 'parking_score' },
]

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
    onlyPasses: params.onlyPasses === '1',
    onlyStaging: params.onlyStaging === '1',
    onlyPending: params.onlyPending === '1',
  })

  if (listings.length === 0) {
    return <div className="empty-state">No listings match that search or filter.</div>
  }

  return (
    <>
      {listings.map((l) => (
        <ListingCard key={l.listing_id as string} listing={l} />
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

function ListingCard({ listing: l }: { listing: Row }) {
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
  const pending = l.photo_score_unavailable === 1 || l.photo_score_unavailable === null
  const garageAttached = l.garage_attached as number | null
  const hasIncompleteData = l.has_incomplete_data === 1

  const value =
    composite !== null && priceNumeric !== null && priceNumeric > 0
      ? Math.round((composite / (priceNumeric / 100000)) * 10) / 10
      : null

  const href = `/listing/${id}`

  return (
    <article className="card" data-id={id}>
      <Link href={href} className="card-open-link" aria-label={`Open ${address}`} />

      <div className="thumb-wrap">
        {thumbnailUrl ? <Image src={thumbnailUrl} alt="" fill sizes="120px" /> : null}
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
            {pending ? <span className="b-pill pending">Pending</span> : null}
            {garageAttached === 0 ? <span className="b-pill garage">Detached garage</span> : null}
            {garageAttached === 1 ? <span className="b-pill garage">Attached garage</span> : null}
            {hasIncompleteData ? <span className="b-pill est">Est. data</span> : null}
          </div>
        </div>

        <div className="row3">
          {composite === null ? (
            <div className="composite-mini"><span className="n pending">Pending</span></div>
          ) : (
            <div className="composite-mini"><span className="n">{composite}</span><span className="l">/100</span></div>
          )}
          <div className="mini-eq">
            {MINI_EQ_FIELDS.map((f) => {
              const raw = l[f.column] as number | null
              const na = raw === null || raw === undefined
              const height = na ? 3 : Math.max(3, Math.round(raw * 0.2))
              return (
                <i
                  key={f.key}
                  className={na ? 'na' : ''}
                  style={{ height: `${height}px` }}
                  title={`${f.label}: ${na ? 'not scored' : raw}`}
                />
              )
            })}
          </div>
          {value !== null ? <span className="value-mini">{value} pts/$100k</span> : null}
        </div>

        <div className="row4">
          <a className="compass-link" href={listingUrl} target="_blank" rel="noopener">
            Compass ↗
          </a>
        </div>
      </div>
    </article>
  )
}
