'use client'

import { useActionState, useState, useSyncExternalStore } from 'react'
import { createShareLink } from './actions'
import { durationLabel, formatExpiry, type ShareDuration } from '@/lib/share'

const DURATIONS: readonly ShareDuration[] = ['24h', '7d', '30d']

/** Never fires: the "store" is whether this is the client, which never changes. */
const subscribeToNothing = () => () => {}

/**
 * Shown until the real dates are known.
 *
 * The picker names the day a link stops working rather than a length of time,
 * because every other number on this page is a concrete fact and an owner
 * should know the answer to "when does this die?" BEFORE minting a link, not
 * after. That date depends on the viewer's clock and timezone, which the server
 * does not have, so these stand in for the server-rendered markup only.
 */
const FALLBACK: Record<ShareDuration, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5.5 5.5L20 7" />
    </svg>
  )
}

export function ShareControl() {
  const [state, formAction, pending] = useActionState(createShareLink, null)

  // The url that was successfully copied, and the expiry to name in the
  // confirmation. Keyed on the url rather than a boolean so minting a SECOND
  // link brings its row back without needing an effect to reset anything.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [copiedExpiry, setCopiedExpiry] = useState<string | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  // The dates depend on the viewer's clock and timezone, which the server does
  // not have. useSyncExternalStore rather than an effect: it reads false while
  // rendering on the server and true on the client, so the labels resolve
  // during the hydration render instead of in a second, cascading one.
  const hydrated = useSyncExternalStore(subscribeToNothing, () => true, () => false)
  const labels: Record<ShareDuration, string> = hydrated
    ? {
        '24h': durationLabel('24h', new Date()),
        '7d': durationLabel('7d', new Date()),
        '30d': durationLabel('30d', new Date()),
      }
    : FALLBACK

  const link = state?.ok === true ? state : null
  const showRow = link !== null && link.url !== copiedUrl
  const showCopied = link !== null && link.url === copiedUrl && copiedExpiry !== null

  async function copy(url: string, expiresAt: number) {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Keep the row. Nothing stores this link, so dismissing it on a failed
      // copy would strand a live guest session no one holds the url for.
      setCopyFailed(true)
      return
    }
    setCopyFailed(false)
    setCopiedExpiry(formatExpiry(expiresAt))
    setCopiedUrl(url)
  }

  return (
    <>
      <div className="share-bar">
        {showCopied ? (
          <p className="share-copied" role="status">
            <CheckIcon />
            Link copied · open until {copiedExpiry}
          </p>
        ) : null}

        <form action={formAction} className="share-form">
          <label className="share-label" htmlFor="share-duration">Guests can view until</label>
          <select
            id="share-duration"
            name="duration"
            className="share-until"
            defaultValue="7d"
          >
            {DURATIONS.map((duration) => (
              <option key={duration} value={duration}>
                {labels[duration]}
              </option>
            ))}
          </select>
          <button type="submit" className="share-create" disabled={pending}>
            <ShareIcon />
            {pending ? 'Creating…' : 'Create link'}
          </button>
        </form>
      </div>

      {showRow ? (
        <div className="share-link">
          <span className="share-link-icon"><LinkIcon /></span>
          <div className="share-link-main">
            {/* A readonly input rather than text: it stays keyboard-reachable
                and selectable, which is the fallback when the clipboard write
                is refused (an insecure origin, or a denied permission). */}
            <input
              className="share-link-url"
              readOnly
              value={link.url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Share link"
            />
            <p className="share-link-meta">
              Open until {formatExpiry(link.expiresAt)} · anyone with the link can view
            </p>
          </div>
          <button type="button" className="share-copy" onClick={() => copy(link.url, link.expiresAt)}>
            <CopyIcon />
            Copy link
          </button>
        </div>
      ) : null}

      {copyFailed ? (
        <p className="share-error" role="alert">
          Couldn&rsquo;t copy automatically. Select the link above and copy it.
        </p>
      ) : null}

      {state && !state.ok ? <p className="enter-error">{state.message}</p> : null}
    </>
  )
}
