import sharp, { type Metadata } from 'sharp'

export interface ResizedImage {
  readonly bytes: Uint8Array
  readonly ext: string
}

export interface ImageResizer {
  // Returns undefined when the image cannot be brought under maxBytes
  // (corrupt input, animated image, or still too large at the smallest
  // attempted size).
  resize(bytes: Uint8Array, maxBytes: number): Promise<ResizedImage | undefined>
}

// Attempts run largest/highest-quality first. sharp's `withoutEnlargement`
// means a width larger than the source is a no-op, so early attempts still
// shrink small-dimension-but-high-quality sources via the quality step alone.
const RESIZE_ATTEMPTS: ReadonlyArray<{
  readonly width: number
  readonly quality: number
}> = [
  { width: 2048, quality: 82 },
  { width: 2048, quality: 60 },
  { width: 1600, quality: 70 },
  { width: 1600, quality: 50 },
  { width: 1200, quality: 60 },
  { width: 1200, quality: 40 },
  { width: 800, quality: 55 },
  { width: 800, quality: 35 },
  { width: 500, quality: 40 },
]

const RESIZED_EXT = 'jpg'

export const createSharpImageResizer = (): ImageResizer => ({
  async resize(bytes, maxBytes) {
    let metadata: Metadata
    try {
      metadata = await sharp(bytes).metadata()
    } catch {
      return undefined
    }
    // Re-encoding an animated image as a single JPEG frame would silently
    // drop the animation, so leave those to the caller's fallback path
    // instead.
    if ((metadata.pages ?? 1) > 1) return undefined

    for (const attempt of RESIZE_ATTEMPTS) {
      try {
        const out = await sharp(bytes)
          .rotate()
          .resize({
            width: attempt.width,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: attempt.quality, mozjpeg: true })
          .toBuffer()
        if (out.byteLength <= maxBytes) {
          return { bytes: new Uint8Array(out), ext: RESIZED_EXT }
        }
      } catch {
        return undefined
      }
    }
    return undefined
  },
})
