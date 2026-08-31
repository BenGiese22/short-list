// Photo-carousel navigation, kept out of Gallery.tsx so the boundary rules are
// testable without a DOM harness. Every function is total: `count` is the
// photo count, and callers may hold an index that a shrinking `photos` array
// has since invalidated.

/** The nearest valid photo index, falling back to the first photo. */
export function clampIndex(index: number, count: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= count) return 0
  return index
}

/**
 * The next photo, stopping at the last one. Deliberately does not wrap: the
 * controls disable at the ends so the "12 / 49" indicator stays honest.
 */
export function nextIndex(index: number, count: number): number {
  return Math.min(clampIndex(index, count) + 1, count - 1)
}

/** The previous photo, stopping at the first one. */
export function prevIndex(index: number, count: number): number {
  return Math.max(clampIndex(index, count) - 1, 0)
}

/**
 * The photo a keypress should select, or null if the carousel does not handle
 * that key. Null rather than the unchanged index, so the caller can leave keys
 * it doesn't own to the browser while still claiming an arrow press that lands
 * on the photo you were already on.
 */
export function indexForKey(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return nextIndex(index, count)
    case 'ArrowLeft':
      return prevIndex(index, count)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
