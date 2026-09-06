import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
    ],
    // Only ever set by docker/env.dev, and the local development environment
    // does not work without it.
    //
    // In production every photo is an absolute Vercel Blob URL, so the image
    // optimizer fetches it directly and never meets proxy.ts. The dev seed
    // instead points blob_url at /dev-photos/*.webp under public/, which the
    // proxy matcher gates like any other path — and the optimizer's internal
    // fetch carries no session cookie, so it receives the /enter redirect and
    // fails with "The requested resource isn't a valid image."
    //
    // Serving the originals sidesteps the optimizer's fetch entirely. The
    // browser still requests them with the user's own cookie, and layout is
    // unaffected because width/height/fill are unchanged — only the bytes on
    // the wire differ.
    //
    // The alternative, excluding /dev-photos from the proxy matcher, would
    // ship to production and publish those photos unauthenticated.
    unoptimized: process.env.DEV_UNOPTIMIZED_IMAGES === '1',
  },
}

export default nextConfig
