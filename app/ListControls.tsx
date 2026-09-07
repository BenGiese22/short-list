'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useRef, useTransition } from 'react'

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'composite', label: 'Sort: Composite' },
  { value: 'value', label: 'Sort: Value / $100k' },
  { value: 'price', label: 'Sort: Price (low first)' },
  { value: 'cost', label: 'Sort: Monthly cost (low first)' },
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

  // One axis: can we still buy it. The three chips this replaces were each
  // near-useless -- "Passes cutoffs" was two undocumented numbers matching 92
  // of 99, "Staging flagged" matched 46 of 99, and "Not yet scored" meant "no
  // VISION score" so listings with composites of 71 and 67 appeared under it.
  //
  // `all` stays the default. A house under contract keeps its place in the
  // ranking, de-emphasised -- deals fall through, and hiding one by default
  // would lose the answer to "where did it stack up".
  const activeFilter = searchParams.get('availability') ?? 'all'

  function setFilter(next: 'all' | 'available' | 'unavailable') {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'all') params.delete('availability')
    else params.set('availability', next)
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
        <button type="button" className="chip" aria-pressed={activeFilter === 'available'} onClick={() => setFilter('available')}>Available</button>
        <button type="button" className="chip" aria-pressed={activeFilter === 'unavailable'} onClick={() => setFilter('unavailable')}>Under contract</button>
      </div>
    </div>
  )
}
