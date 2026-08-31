'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { clampIndex, indexForKey, nextIndex, prevIndex } from '@/lib/gallery'

function ChevronIcon({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}

export function Gallery({ photos }: { photos: { position: number; url: string }[] }) {
  const [selected, setSelected] = useState(0)
  const stripRef = useRef<HTMLDivElement>(null)

  // Defensive against an out-of-range index (shouldn't happen, but photos is
  // server data we don't fully control the shape of at the type level).
  const activeIndex = clampIndex(selected, photos.length)

  // The strip scrolls horizontally and most listings run 20-50 photos, so
  // without this the thumbnails desynchronise from the main image the moment
  // you advance past the first screenful. scrollLeft is set directly rather
  // than via scrollIntoView, which would also scroll the page vertically to
  // reach a strip sitting below the fold.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const thumb = strip.children[activeIndex] as HTMLElement | undefined
    if (!thumb) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    strip.scrollTo({
      left: thumb.offsetLeft - (strip.clientWidth - thumb.clientWidth) / 2,
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
  }, [activeIndex])

  // Zero photos: render no gallery block at all, per the addendum, rather than
  // an empty frame or a broken image.
  if (photos.length === 0) return null

  const current = photos[activeIndex]
  const hasMany = photos.length > 1
  const atFirst = activeIndex === 0
  const atLast = activeIndex === photos.length - 1

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = indexForKey(e.key, activeIndex, photos.length)
    if (target === null) return
    // Claimed even when the index is unchanged (an arrow at either end), so a
    // held arrow key doesn't start scrolling the page once you hit the last
    // photo.
    e.preventDefault()
    setSelected(target)
  }

  return (
    <div className="gallery">
      <div
        className="gallery-main"
        // A focusable group, not a listbox: arrow keys change the picture, but
        // the thumbnails below remain the enumerable list of photos.
        role="group"
        aria-roledescription="carousel"
        aria-label={hasMany ? 'Listing photos, use arrow keys to move between them' : 'Listing photo'}
        tabIndex={hasMany ? 0 : undefined}
        onKeyDown={hasMany ? handleKeyDown : undefined}
      >
        <Image
          key={current.position}
          src={current.url}
          alt=""
          fill
          sizes="(max-width: 640px) 100vw, 720px"
          priority={activeIndex === 0}
        />
        {hasMany ? (
          <>
            <button
              type="button"
              className="gallery-nav prev"
              // aria-disabled rather than disabled: a real `disabled` drops the
              // button out of the tab order mid-interaction, so clicking back to
              // the first photo would throw focus to the top of the document.
              aria-disabled={atFirst}
              aria-label="Previous photo"
              onClick={() => setSelected(prevIndex(activeIndex, photos.length))}
            >
              <ChevronIcon dir="left" />
            </button>
            <button
              type="button"
              className="gallery-nav next"
              aria-disabled={atLast}
              aria-label="Next photo"
              onClick={() => setSelected(nextIndex(activeIndex, photos.length))}
            >
              <ChevronIcon dir="right" />
            </button>
          </>
        ) : null}
        <div className="gallery-count" aria-live="polite">
          {activeIndex + 1} / {photos.length}
        </div>
      </div>
      {hasMany ? (
        <div className="gallery-strip" ref={stripRef}>
          {photos.map((p, i) => (
            <button
              key={p.position}
              type="button"
              className={`thumb${i === activeIndex ? ' active' : ''}`}
              aria-label={`Photo ${i + 1} of ${photos.length}`}
              aria-current={i === activeIndex}
              onClick={() => setSelected(i)}
            >
              <Image src={p.url} alt="" fill sizes="72px" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
