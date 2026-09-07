'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/** Reject a house from the detail page.
 *
 *  Owner-only, enforced server-side in /api/reject rather than here — hiding
 *  a button is a courtesy, not a control, and a guest holding a share link
 *  must not be able to remove a house from the list by other means.
 *
 *  Two-step on purpose. This is destructive on the next pipeline run: the
 *  listing's rows, its photos and their Blob objects go, and the house is
 *  refused if Compass ever relists it under a new id. That is exactly what
 *  is wanted, and it is not something to do by mis-tapping on a phone.
 */
export function RejectButton({ listingId, address }: { listingId: string; address: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function reject() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        // The server's message names the actual problem -- an unresolved
        // property id, say -- and is more use than "something went wrong".
        setError(body.error ?? `failed (${response.status})`)
        return
      }
      startTransition(() => {
        router.push('/')
        router.refresh()
      })
    } catch {
      setError('could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="reject-zone">
        <p className="reject-error">{error}</p>
        <button type="button" className="reject-btn" onClick={() => setError(null)}>
          Try again
        </button>
      </div>
    )
  }

  if (!confirming) {
    return (
      <div className="reject-zone">
        <button type="button" className="reject-btn" onClick={() => setConfirming(true)}>
          Not interested
        </button>
      </div>
    )
  }

  return (
    <div className="reject-zone">
      <p className="reject-warn">
        Remove {address} for good? It will not come back even if it is relisted.
      </p>
      <div className="reject-actions">
        <button
          type="button"
          className="reject-btn is-confirm"
          onClick={reject}
          disabled={busy || pending}
        >
          {busy || pending ? 'Removing…' : 'Yes, remove it'}
        </button>
        <button type="button" className="reject-btn" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
