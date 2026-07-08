import sharp, { type Metadata } from 'sharp'

export interface ResizedImage {
  readonly bytes: Uint8Array
  readonly ext: string
}

export type ResizeFailureReason = 'undecodable' | 'animated' | 'still_too_large'

export type ResizeOutcome =
  | ({ readonly ok: true } & ResizedImage)
  | { readonly ok: false; readonly reason: ResizeFailureReason }

export interface ImageResizer {
  resize(bytes: Uint8Array, maxBytes: number): Promise<ResizeOutcome>
}

// sharp's own decompression-bomb guard (`limitInputPixels`) defaults to
// ~268 megapixels, far larger than any smartphone photo this resizer needs
// to handle. A tighter ceiling here bounds the transient decode buffer for
// an oversized/adversarial attachment before any resize work starts.
const MAX_DECODE_PIXELS = 60_000_000

// Grouped by width so each tier decodes and resizes the source once, then
// re-encodes at each quality via a cheap `.clone()` — quality doesn't affect
// decode/resize cost, so trying every quality per width is nearly free once
// the pixels are already resized.
const RESIZE_TIERS: ReadonlyArray<{
  readonly width: number
  readonly qualities: readonly number[]
}> = [
  { width: 2048, qualities: [82, 60] },
  { width: 1600, qualities: [70, 50] },
  { width: 1200, qualities: [60, 40] },
  { width: 800, qualities: [55, 35] },
  { width: 500, qualities: [40] },
]

const RESIZED_EXT = 'jpg'

export const createSharpImageResizer = (): ImageResizer => ({
  async resize(bytes, maxBytes) {
    let metadata: Metadata
    try {
      metadata = await sharp(bytes).metadata()
    } catch {
      return { ok: false, reason: 'undecodable' }
    }
    // Re-encoding an animated image as a single JPEG frame would silently
    // drop the animation, so leave those to the caller's fallback path
    // instead.
    if ((metadata.pages ?? 1) > 1) return { ok: false, reason: 'animated' }
    if (metadata.width * metadata.height > MAX_DECODE_PIXELS) {
      return { ok: false, reason: 'still_too_large' }
    }

    for (const tier of RESIZE_TIERS) {
      const resized = sharp(bytes).rotate().resize({
        width: tier.width,
        fit: 'inside',
        withoutEnlargement: true,
      })
      for (const quality of tier.qualities) {
        try {
          const out = await resized
            .clone()
            .jpeg({ quality, mozjpeg: true })
            .toBuffer()
          if (out.byteLength <= maxBytes) {
            return { ok: true, bytes: new Uint8Array(out), ext: RESIZED_EXT }
          }
        } catch {
          return { ok: false, reason: 'undecodable' }
        }
      }
    }
    return { ok: false, reason: 'still_too_large' }
  },
})
