import { describe, it, expect } from 'vitest'
import { clampIndex, nextIndex, prevIndex, indexForKey } from './gallery'

describe('clampIndex', () => {
  it('leaves an in-range index alone', () => {
    expect(clampIndex(3, 10)).toBe(3)
  })

  // `photos` is server data whose length can shrink under a re-render, so an
  // index that was valid a moment ago may not be. Same defence the component
  // already had inline before this helper existed.
  it('falls back to the first photo when the index is past the end', () => {
    expect(clampIndex(12, 10)).toBe(0)
  })

  it('falls back to the first photo for a negative index', () => {
    expect(clampIndex(-1, 10)).toBe(0)
  })
})

describe('nextIndex', () => {
  it('advances one photo', () => {
    expect(nextIndex(0, 49)).toBe(1)
  })

  // Not wrapping is deliberate: the controls disable at the ends so the
  // "12 / 49" indicator never jumps from the last photo back to the first.
  it('stops at the last photo rather than wrapping', () => {
    expect(nextIndex(48, 49)).toBe(48)
  })
})

describe('prevIndex', () => {
  it('goes back one photo', () => {
    expect(prevIndex(5, 49)).toBe(4)
  })

  it('stops at the first photo rather than wrapping', () => {
    expect(prevIndex(0, 49)).toBe(0)
  })
})

describe('indexForKey', () => {
  it('moves right and left with the arrow keys', () => {
    expect(indexForKey('ArrowRight', 2, 49)).toBe(3)
    expect(indexForKey('ArrowLeft', 2, 49)).toBe(1)
  })

  // 49-photo listings are the norm here, so jumping to either end matters.
  it('jumps to the first photo on Home and the last on End', () => {
    expect(indexForKey('Home', 20, 49)).toBe(0)
    expect(indexForKey('End', 20, 49)).toBe(48)
  })

  // null, not the current index: the caller uses it to decide whether to
  // preventDefault, so an unhandled key must stay distinguishable from a
  // handled key that lands on the photo you were already on.
  it('returns null for a key the carousel does not handle', () => {
    expect(indexForKey('Enter', 2, 49)).toBeNull()
    expect(indexForKey('a', 2, 49)).toBeNull()
  })

  it('claims the arrow key at a boundary even though the index is unchanged', () => {
    expect(indexForKey('ArrowLeft', 0, 49)).toBe(0)
    expect(indexForKey('ArrowRight', 48, 49)).toBe(48)
  })
})
