import { describe, expect, it } from 'vitest'

import { imageBlockFromResizedImage } from '@/plugins/llm-agent/conversation-agent/image-block'

describe('imageBlockFromResizedImage', () => {
  it('base64-encodes the bytes and maps jpg to image/jpeg', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])
    expect(imageBlockFromResizedImage({ bytes, ext: 'jpg' })).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      mimeType: 'image/jpeg',
    })
  })

  it('falls back to application/octet-stream for an unmapped extension', () => {
    const bytes = new Uint8Array([0x00])
    expect(imageBlockFromResizedImage({ bytes, ext: 'gif' })).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      mimeType: 'application/octet-stream',
    })
  })
})
