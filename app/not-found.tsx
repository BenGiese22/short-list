import Link from 'next/link'

export default function NotFound() {
  return (
    <main id="detail-view">
      <div className="empty-state">
        <p>Page not found.</p>
        <p>
          <Link href="/" className="back-btn">← All listings</Link>
        </p>
      </div>
    </main>
  )
}
