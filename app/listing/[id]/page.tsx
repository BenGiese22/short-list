import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Suspense } from 'react'
import type { Row } from '@libsql/client'
import { getListing } from '@/lib/queries'
import { Gallery } from './Gallery'

// getListing() returns the spread of a libsql `Row` (a `[name: string]: Value`
// index-signature object) plus `amenities`/`photos`. TypeScript's inference of
// an object spread drops the source's index signature, so the plain
// `Awaited<ReturnType<typeof getListing>>` loses per-column field access.
// `Row` restores that dynamic string-keyed access for the underlying columns
// (`l.composite`, `l[SCORE_FIELD[key]]`, etc.), matching how app/page.tsx
// (Task 7) types its own row prop.
type Listing = Row & { amenities: string[]; photos: { position: number; url: string }[] }

const WEIGHTS: Record<string, number> = {
  commute: 30, sqft: 20, condition: 20, outdoor: 15, room: 10, parking: 5,
}
const LABELS: Record<string, string> = {
  commute: 'Commute', sqft: 'Sqft', condition: 'Condition', outdoor: 'Outdoor',
  room: 'Rooms', parking: 'Parking',
}
const SCORE_FIELD: Record<string, string> = {
  commute: 'commute_score', sqft: 'sqft_score', condition: 'condition_score',
  outdoor: 'outdoor_score', room: 'room_count_score', parking: 'parking_score',
}
const EQ_KEYS = Object.keys(WEIGHTS)

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

export default function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  return (
    <main id="detail-view">
      <Suspense fallback={null}>
        <ListingDetail params={params} />
      </Suspense>
    </main>
  )
}

async function ListingDetail({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) notFound()
  return <ListingDetailBody listing={listing as unknown as Listing} />
}

function ListingDetailBody({ listing: l }: { listing: Listing }) {
  const composite = l.composite as number | null
  const staged = l.watermarked_staging_detected === 1 || l.suspected_unwatermarked_staging === 1
  const belowCutoff = l.passes_filters === 0
  const priceNumeric = l.price_numeric as number | null
  const priceText = l.price as string | null
  const listingUrl = l.listing_url as string

  const value =
    composite !== null && priceNumeric !== null && priceNumeric > 0
      ? composite / (priceNumeric / 100000)
      : null

  const beds = l.beds as number | null
  const baths = l.baths as number | null
  const sqft = l.sqft as number | null
  const lotSqft = l.lot_sqft as number | null
  const parkingSpaces = l.parking_spaces as number | null
  const yearBuilt = l.year_built as number | null

  const garageAttached = l.garage_attached as number | null
  const garage =
    garageAttached === 1
      ? { text: 'Attached', cls: '' }
      : garageAttached === 0
        ? { text: 'Detached', cls: 'warn' }
        : { text: 'Unknown', cls: 'muted' }

  // "Not yet checked" for staging/floor plan means these visual_scores columns
  // came back null from the LEFT JOIN -- either there is no visual_scores row
  // at all, or photo analysis hasn't populated them yet. Either way the
  // pipeline hasn't produced an answer, so treat it the same as the mockup's
  // own null-check (see dense-mockup.html's renderDetail: `staging_flag===null`
  // / `has_layout_plan===null`).
  const stagingChecked = l.watermarked_staging_detected !== null || l.suspected_unwatermarked_staging !== null
  const stagingCard = staged
    ? { text: 'Flagged', cls: 'warn' }
    : !stagingChecked
      ? { text: 'Not yet checked', cls: 'muted' }
      : { text: 'None noted', cls: '' }

  const hasLayoutPlan = l.has_layout_plan as number | null
  const layoutPlanClarity = l.layout_plan_clarity_score as number | null

  const hasIncompleteData = l.has_incomplete_data === 1

  return (
    <>
      <div className="detail-topbar">
        <Link href="/" className="back-btn">← All listings</Link>
        <a className="detail-compass" href={listingUrl} target="_blank" rel="noopener">
          View on Compass ↗
        </a>
      </div>

      <Gallery photos={l.photos} />

      {staged ? (
        <div className="staging-alert">
          <WarnIcon />
          <div>
            <p className="t">Staging suspected in listing photos</p>
            <p className="d">{(l.staging_notes as string | null) ?? ''}</p>
          </div>
        </div>
      ) : null}

      {belowCutoff ? (
        <div className="cutoff-alert">
          <p className="t">Below hard cutoffs — still shown for comparison</p>
        </div>
      ) : null}

      <div className="detail-head">
        <h2>{l.address as string}</h2>
        <p className="sub">
          {l.city as string}, {l.state as string} {l.zip_code as string} · Built {yearBuilt ?? '—'}
        </p>
        <div className="detail-price">
          {priceNumeric !== null ? `$${priceNumeric.toLocaleString()}` : priceText ?? '—'}
        </div>
      </div>

      <div className="stat-strip">
        <div className="stat"><div className="v">{beds ?? '—'}</div><div className="k">Beds</div></div>
        <div className="stat"><div className="v">{baths !== null ? fmtBaths(baths) : '—'}</div><div className="k">Baths</div></div>
        <div className="stat"><div className="v">{sqft !== null ? sqft.toLocaleString() : '—'}</div><div className="k">Sqft</div></div>
        <div className="stat"><div className="v">{lotSqft !== null ? lotSqft.toLocaleString() : '—'}</div><div className="k">Lot sqft</div></div>
        <div className="stat"><div className="v">{parkingSpaces ?? '—'}</div><div className="k">Parking</div></div>
      </div>

      <div className="section">
        <h3>Composite score</h3>
        {composite === null ? (
          <div className="composite-block">
            <div className="composite-num pending-num">Pending</div>
            <div className="composite-meta">
              <p className="composite-caption">This listing hasn’t been scored yet.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="composite-block">
              <div className="composite-num">{Math.round(composite)}</div>
              <div className="composite-meta">
                <div className="gauge"><i style={{ width: `${composite}%` }} /></div>
                <p className="composite-caption">Composite score, weighted across the six factors below.</p>
              </div>
            </div>
            {value !== null ? (
              <>
                <div className="value-chip">
                  <span className="n">{value.toFixed(1)}</span><span className="l">pts / $100k</span>
                </div>
                <p className="value-note">Value-per-dollar — shown for comparison, not blended into the ranking above.</p>
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="section">
        <h3>Score breakdown</h3>
        <div className="eq">
          {EQ_KEYS.map((key) => {
            const raw = l[SCORE_FIELD[key]] as number | null
            const na = raw === null || raw === undefined
            const height = na ? 4 : Math.max(4, Math.round(raw * 0.86))
            return (
              <div key={key} className="eq-bar">
                <div className="bar-track">
                  <div className={`bar${na ? ' na' : ''}`} style={{ height: `${height}px` }} />
                </div>
                <div className={`val${na ? ' na' : ''}`}>{raw === null || raw === undefined ? '—' : Math.round(raw)}</div>
                <div className="lbl">{LABELS[key]}</div>
                <div className="wt">{WEIGHTS[key]}%</div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="section">
        <h3>Facts worth knowing</h3>
        <div className="fact-grid">
          <div className="fact-card">
            <div className="k">Garage</div>
            <div className={`v ${garage.cls}`}>{garage.text}</div>
            {garageAttached === 0 ? <div className="sub">Detached from the house</div> : null}
          </div>
          <div className="fact-card">
            <div className="k">Staging</div>
            <div className={`v ${stagingCard.cls}`}>{stagingCard.text}</div>
          </div>
          <div className="fact-card">
            <div className="k">Floor plan</div>
            <div className={`v ${hasLayoutPlan === null ? 'muted' : ''}`}>
              {hasLayoutPlan === null ? 'Not yet checked' : hasLayoutPlan ? 'Found' : 'Not found'}
            </div>
            {hasLayoutPlan ? <div className="sub">Clarity {layoutPlanClarity !== null ? Math.round(layoutPlanClarity) : '—'}/10</div> : null}
          </div>
          <div className="fact-card">
            <div className="k">Data quality</div>
            <div className={`v ${hasIncompleteData ? 'muted' : ''}`}>
              {hasIncompleteData ? 'Some estimated' : 'Complete'}
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <h3>Description</h3>
        <p className="desc">{l.description as string | null}</p>
      </div>

      <div className="section">
        <h3>Amenities</h3>
        <div className="amenities">
          {l.amenities.map((a) => (
            <span key={a} className="amenity">{a}</span>
          ))}
        </div>
      </div>

      <div className="sticky-cta">
        <a href={listingUrl} target="_blank" rel="noopener">
          Open full listing on Compass ↗
        </a>
      </div>
    </>
  )
}
