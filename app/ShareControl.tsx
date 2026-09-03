'use client'

import { useActionState, useState } from 'react'
import { createShareLink } from './actions'
import { SHARE_DURATIONS, type ShareDuration } from '@/lib/share'

const DURATION_LABELS: Record<ShareDuration, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
}

export function ShareControl() {
  const [state, formAction, pending] = useActionState(createShareLink, null)
  const [copied, setCopied] = useState(false)

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable (http, permissions). The input below is
      // selectable, so the user can still copy by hand.
    }
  }

  return (
    <div className="share">
      <form action={formAction} className="share-form">
        <label className="share-label" htmlFor="share-duration">Share for</label>
        <select id="share-duration" name="duration" className="sort" defaultValue="7d">
          {(Object.keys(SHARE_DURATIONS) as ShareDuration[]).map((d) => (
            <option key={d} value={d}>{DURATION_LABELS[d]}</option>
          ))}
        </select>
        <button type="submit" className="chip" disabled={pending}>
          {pending ? 'Creating…' : 'Create link'}
        </button>
      </form>

      {state?.ok ? (
        <div className="share-result">
          <input
            className="share-url"
            readOnly
            value={state.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Share link"
          />
          <button type="button" className="chip" onClick={() => copy(state.url)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="share-expiry">
            Expires {new Date(state.expiresAt * 1000).toLocaleString()}
          </span>
        </div>
      ) : null}

      {state && !state.ok ? <p className="enter-error">{state.message}</p> : null}
    </div>
  )
}
