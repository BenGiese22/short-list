'use client'

import { useState } from 'react'
import Image from 'next/image'

export function Gallery({ photos }: { photos: { position: number; url: string }[] }) {
  const [selected, setSelected] = useState(0)

  // Zero photos: render no gallery block at all, per the addendum, rather than
  // an empty frame or a broken image.
  if (photos.length === 0) return null

  // Defensive against an out-of-range index (shouldn't happen, but photos is
  // server data we don't fully control the shape of at the type level).
  const activeIndex = selected < photos.length ? selected : 0
  const current = photos[activeIndex]

  return (
    <div className="gallery">
      <div className="gallery-main">
        <Image
          key={current.position}
          src={current.url}
          alt=""
          fill
          sizes="(max-width: 640px) 100vw, 720px"
          priority={activeIndex === 0}
        />
        <div className="gallery-count">
          {activeIndex + 1} / {photos.length}
        </div>
      </div>
      {photos.length > 1 ? (
        <div className="gallery-strip">
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
