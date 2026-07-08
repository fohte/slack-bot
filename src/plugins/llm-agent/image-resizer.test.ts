import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { createSharpImageResizer } from '@/plugins/llm-agent/image-resizer'

// Random noise is close to worst-case for JPEG compression, so a resize that
// fits noise reliably fits an ordinary smartphone photo of the same
// dimensions.
const buildNoisyJpegBytes = async (
  width: number,
  height: number,
): Promise<Uint8Array> => {
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i++) {
    raw[i] = Math.floor(Math.random() * 256)
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

describe('createSharpImageResizer', () => {
  it('shrinks a large source image to fit under the byte cap', async () => {
    const source = await buildNoisyJpegBytes(3000, 2000)
    const cap = 500 * 1024
    expect(source.byteLength).toBeGreaterThan(cap)

    const resizer = createSharpImageResizer()
    const result = await resizer.resize(source, cap)

    const decoded =
      result === undefined ? undefined : await sharp(result.bytes).metadata()
    expect({
      fitsUnderCap: result !== undefined && result.bytes.byteLength <= cap,
      ext: result?.ext,
      decodedFormat: decoded?.format,
    }).toEqual({
      fitsUnderCap: true,
      ext: 'jpg',
      decodedFormat: 'jpeg',
    })
  })

  it('gives up and returns undefined when the cap is too small for any attempt', async () => {
    const source = await buildNoisyJpegBytes(3000, 2000)
    const resizer = createSharpImageResizer()

    const result = await resizer.resize(source, 1000)

    expect(result).toBeUndefined()
  })

  it('returns undefined for bytes that are not a decodable image', async () => {
    const resizer = createSharpImageResizer()

    const result = await resizer.resize(new Uint8Array([1, 2, 3]), 500 * 1024)

    expect(result).toBeUndefined()
  })

  it('returns undefined for animated images instead of collapsing them to one frame', async () => {
    const source = await buildAnimatedGifBytes()
    const resizer = createSharpImageResizer()

    const result = await resizer.resize(source, 500 * 1024)

    expect(result).toBeUndefined()
  })
})
