import { describe, expect, it } from 'vitest'

import { imageBlockFromDownloadedImage } from '#plugins/llm-agent/conversation-agent/image-block'

describe('imageBlockFromDownloadedImage', () => {
  it('base64-encodes the bytes and maps jpg to image/jpeg', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])
    expect(imageBlockFromDownloadedImage({ bytes, ext: 'jpg' })).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      mimeType: 'image/jpeg',
    })
  })

  it('maps gif to image/gif', () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46])
    expect(imageBlockFromDownloadedImage({ bytes, ext: 'gif' })).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      mimeType: 'image/gif',
    })
  })

  it('falls back to application/octet-stream for an unmapped extension', () => {
    const bytes = new Uint8Array([0x00])
    expect(imageBlockFromDownloadedImage({ bytes, ext: 'bmp' })).toEqual({
      base64: Buffer.from(bytes).toString('base64'),
      mimeType: 'application/octet-stream',
    })
  })
})
