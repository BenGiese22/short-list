import { describe, it, expect } from 'vitest'
import { availability, listHref, listStateParams, statusLabel } from './status'

describe('availability', () => {
  it('treats a house under contract as unavailable', () => {
    for (const s of ['Pending', 'pending', ' Pending ', 'Closed', 'Sold']) {
      expect(availability(s)).toBe('unavailable')
    }
  })

  it('treats backup offers as still gettable', () => {
    // A deal can fall through, and "Active / Backup" means Compass is still
    // taking offers. A substring match on "active" would be right here by
    // luck and wrong on "Inactive".
    expect(availability('Active / Backup')).toBe('available')
  })

  it('treats an active or upcoming listing as available', () => {
    expect(availability('Active')).toBe('available')
    expect(availability('Coming Soon')).toBe('available')
  })

  it('does not guess when the status is missing', () => {
    for (const s of [null, undefined, '', '   ', 42]) {
      expect(availability(s)).toBe('unknown')
    }
  })

  it('renders the label Compass gave us, or nothing', () => {
    expect(statusLabel('Coming Soon')).toBe('Coming Soon')
    expect(statusLabel('  Pending ')).toBe('Pending')
    expect(statusLabel(null)).toBeNull()
    expect(statusLabel('')).toBeNull()
  })
})

describe('listStateParams', () => {
  it('carries only the keys that shape the list', () => {
    const out = listStateParams({
      sort: 'value', search: 'Arvada', onlyPasses: '1',
      // Not list state. A detail-page parameter has no business coming back
      // on the return trip.
      utm_source: 'email', id: '123',
    })
    const params = new URLSearchParams(out)
    expect(params.get('sort')).toBe('value')
    expect(params.get('search')).toBe('Arvada')
    expect(params.get('onlyPasses')).toBe('1')
    expect(params.has('utm_source')).toBe(false)
    expect(params.has('id')).toBe(false)
  })

  it('omits empty values rather than writing blanks', () => {
    expect(listStateParams({ sort: undefined, search: '' })).toBe('')
  })
})

describe('listHref', () => {
  it('returns to the list with its state intact', () => {
    expect(listHref('sort=value&search=Arvada')).toBe('/?sort=value&search=Arvada')
  })

  it('returns to a bare list when there was no state', () => {
    // The reader may have arrived from an emailed link rather than the list,
    // in which case there is nothing to restore and router.back() would have
    // taken them off the site entirely.
    expect(listHref('')).toBe('/')
  })
})
