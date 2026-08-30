'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useRef, useTransition } from 'react'

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'composite', label: 'Sort: Composite' },
  { value: 'value', label: 'Sort: Value / $100k' },
  { value: 'price', label: 'Sort: Price (low first)' },
  { value: 'commute', label: 'Sort: Commute' },
  { value: 'sqft', label: 'Sort: Sqft score' },
  { value: 'condition', label: 'Sort: Condition' },
  { value: 'outdoor', label: 'Sort: Outdoor' },
  { value: 'room', label: 'Sort: Room count' },
  { value: 'parking', label: 'Sort: Parking' },
]

const SEARCH_DEBOUNCE_MS = 300

export function ListControls() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    startTransition(() => router.push(`/?${params.toString()}`))
  }

  // The search box is uncontrolled (defaultValue only) so React never resets
  // the input's value/caret while the user is typing. Navigation is also
  // debounced so a fast typist doesn't fire a router.push — and a Suspense
  // re-render of the results list — on every single keystroke.
  function handleSearchChange(value: string) {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(() => {
      updateParam('search', value || null)
    }, SEARCH_DEBOUNCE_MS)
  }

  const activeFilter =
    searchParams.get('onlyPasses') === '1' ? 'passes'
    : searchParams.get('onlyStaging') === '1' ? 'staging'
    : searchParams.get('onlyPending') === '1' ? 'pending'
    : 'all'

  function setFilter(next: 'all' | 'passes' | 'staging' | 'pending') {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('onlyPasses')
    params.delete('onlyStaging')
    params.delete('onlyPending')
    if (next === 'passes') params.set('onlyPasses', '1')
    if (next === 'staging') params.set('onlyStaging', '1')
    if (next === 'pending') params.set('onlyPending', '1')
    startTransition(() => router.push(`/?${params.toString()}`))
  }

  return (
    <div className="controls">
      <div className="row-controls">
        <label className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Search address or city…"
            defaultValue={searchParams.get('search') ?? ''}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </label>
        <select
          className="sort"
          defaultValue={searchParams.get('sort') ?? 'composite'}
          onChange={(e) => updateParam('sort', e.target.value)}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="chips">
        <button type="button" className="chip" aria-pressed={activeFilter === 'all'} onClick={() => setFilter('all')}>All</button>
        <button type="button" className="chip" aria-pressed={activeFilter === 'passes'} onClick={() => setFilter('passes')}>Passes cutoffs</button>
        <button type="button" className="chip warn-chip" aria-pressed={activeFilter === 'staging'} onClick={() => setFilter('staging')}>Staging flagged</button>
        <button type="button" className="chip" aria-pressed={activeFilter === 'pending'} onClick={() => setFilter('pending')}>Not yet scored</button>
      </div>
    </div>
  )
}
