import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createSharpImageResizer } from '@/plugins/llm-agent/image-resizer'

// mulberry32 PRNG, seeded so the "noisy" fixture bytes (and therefore the
// exact compressed sizes at each resize attempt) are reproducible across
// runs instead of depending on Math.random().
const createSeededRandom = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Random noise is close to worst-case for JPEG compression, so a resize that
// fits noise reliably fits an ordinary smartphone photo of the same
// dimensions.
const buildNoisyJpegBytes = async (
  width: number,
  height: number,
): Promise<Uint8Array> => {
  const random = createSeededRandom(42)
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i++) {
    raw[i] = Math.floor(random() * 256)
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer()
  return new Uint8Array(buf)
}

const buildAnimatedGifBytes = async (): Promise<Uint8Array> => {
  const buf = await sharp(Buffer.alloc(8), {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
    animated: true,
  })
    .gif({ keepDuplicateFrames: true })
    .toBuffer()
  return new Uint8Array(buf)
}

// A solid-colour image compresses to a tiny byte count regardless of pixel
// dimensions, so this fixture stays cheap to generate/encode while still
// exceeding the resizer's megapixel guard.
const buildOversizedPixelCountPngBytes = async (): Promise<Uint8Array> => {
  const width = 8000
  const height = 8000
  const raw = Buffer.alloc(width * height, 128)
  const buf = await sharp(raw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

describe('createSharpImageResizer', () => {
  it('shrinks a large source image to fit under the byte cap', async () => {
    const source = await buildNoisyJpegBytes(3000, 2000)
    const cap = 500 * 1024

    const resizer = createSharpImageResizer()
    const outcome = await resizer.resize(source, cap)

    if (!outcome.ok) throw new Error('expected resize to succeed')

    const decoded = await sharp(outcome.bytes).metadata()
    expect(outcome.ext).toBe('jpg')
    expect(outcome.bytes.byteLength).toBeLessThanOrEqual(cap)
    expect(decoded.format).toBe('jpeg')
  }, // Re-encodes several resize tiers with mozjpeg, which is CPU-bound
  // enough that slow CI runners can exceed vitest's 5s default.
  20_000)

  it('gives up when the cap is too small for any attempt', async () => {
    const source = await buildNoisyJpegBytes(3000, 2000)
    const resizer = createSharpImageResizer()

    const outcome = await resizer.resize(source, 1000)

    expect(outcome).toEqual({ ok: false, reason: 'still_too_large' })
  }, // Same mozjpeg re-encoding cost as the test above, since every tier
  // is attempted before giving up.
  20_000)

  it('rejects bytes that are not a decodable image', async () => {
    const resizer = createSharpImageResizer()

    const outcome = await resizer.resize(new Uint8Array([1, 2, 3]), 500 * 1024)

    expect(outcome).toEqual({ ok: false, reason: 'undecodable' })
  })

  it('rejects animated images instead of collapsing them to one frame', async () => {
    const source = await buildAnimatedGifBytes()
    const resizer = createSharpImageResizer()

    const outcome = await resizer.resize(source, 500 * 1024)

    expect(outcome).toEqual({ ok: false, reason: 'animated' })
  })

  it('rejects images whose pixel count exceeds the decompression-bomb guard', async () => {
    const source = await buildOversizedPixelCountPngBytes()
    const resizer = createSharpImageResizer()

    const outcome = await resizer.resize(source, 500 * 1024)

    expect(outcome).toEqual({ ok: false, reason: 'still_too_large' })
  })
})
