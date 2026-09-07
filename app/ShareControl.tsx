'use client'

import { useActionState, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { createShareLink, type ShareLinkState } from './actions'
import { durationLabel, formatExpiry, type ShareDuration } from '@/lib/share'

const DURATIONS: readonly ShareDuration[] = ['24h', '7d', '30d']

/** Never fires: the "store" is whether this is the client, which never changes. */
const subscribeToNothing = () => () => {}

/**
 * Shown in the server-rendered markup only.
 *
 * The picker names the day a link stops working rather than a length of time,
 * because every other number on this page is a concrete fact and an owner
 * should know the answer to "when does this die?" BEFORE minting a link, not
 * after. That date depends on the viewer's clock and timezone, which the server
 * does not have, so these stand in until hydration.
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

  /*
   * Both flags track the action RESULT BY IDENTITY, not by url.
   *
   * Two links minted in the same wall-clock second with the same duration are
   * byte-identical -- signSession hmacs `v1-guest-<expiresAt>-<keyVersion>` and
   * nothing else varies -- so comparing urls would decide the second link had
   * already been copied and never show its row. Identity also retires both
   * flags for free when a new link arrives: neither can outlive its own result.
   */
  const [copiedFor, setCopiedFor] = useState<ShareLinkState>(null)
  const [failedFor, setFailedFor] = useState<ShareLinkState>(null)

  // Re-read whenever the owner reaches for the control. Without this a tab left
  // open past midnight keeps offering yesterday's dates, and the picker
  // promises a day the server will not mint -- which is the whole point of
  // naming a date instead of a duration.
  const [clock, setClock] = useState(() => Date.now())
  const readClock = () => setClock(Date.now())

  // The dates depend on the viewer's clock and timezone, which the server does
  // not have. useSyncExternalStore rather than an effect: it reads false while
  // rendering on the server and true on the client, so the labels resolve
  // during the hydration render instead of in a second, cascading one.
  const hydrated = useSyncExternalStore(subscribeToNothing, () => true, () => false)
  const now = new Date(clock)
  const labels: Record<ShareDuration, string> = hydrated
    ? {
        '24h': durationLabel('24h', now),
        '7d': durationLabel('7d', now),
        '30d': durationLabel('30d', now),
      }
    : FALLBACK

  const link = state?.ok === true ? state : null
  const copied = link !== null && copiedFor === state
  const showRow = link !== null && !copied

  const statusRef = useRef<HTMLParagraphElement>(null)

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Keep the row. Nothing stores this link, so dismissing it on a failed
      // copy would strand a live guest session no one holds the url for.
      setFailedFor(state)
      return
    }
    // flushSync so the confirmation is in the DOM before focus moves to it:
    // the row holding the just-activated button is about to unmount, and with
    // nowhere deliberate to go focus falls back to document.body, leaving a
    // keyboard user to resume tabbing from the top of the page.
    flushSync(() => {
      setFailedFor(null)
      setCopiedFor(state)
    })
    statusRef.current?.focus()
  }

  return (
    <>
      <div className="share-bar">
        {/*
          Always rendered rather than inserted on copy: a polite live region has
          to be in the DOM before its text changes or screen readers skip the
          announcement. `.share-copied:empty` hides it while idle.
        */}
        <p className="share-copied" role="status" tabIndex={-1} ref={statusRef}>
          {copied ? (
            <>
              <CheckIcon />
              Link copied · open until {formatExpiry(link.expiresAt)}
            </>
          ) : null}
        </p>

        <form
          action={formAction}
          className="share-form"
          onPointerDown={readClock}
          onFocus={readClock}
        >
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
          <button type="button" className="share-copy" onClick={() => copy(link.url)}>
            <CopyIcon />
            Copy link
          </button>
        </div>
      ) : null}

      {state !== null && failedFor === state ? (
        <p className="share-error" role="alert">
          Couldn&rsquo;t copy automatically. Select the link above and copy it.
        </p>
      ) : null}

      {state && !state.ok ? <p className="enter-error">{state.message}</p> : null}
    </>
  )
}
