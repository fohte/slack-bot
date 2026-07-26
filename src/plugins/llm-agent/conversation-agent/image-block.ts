export interface DownloadedImage {
  readonly bytes: Uint8Array
  readonly ext: string
}

// LLM-facing shape the Slack thumbnail pipeline's output is converted to
// before it reaches ConversationAgent.respond.
export interface ImageBlock {
  readonly base64: string
  readonly mimeType: string
}

const EXT_MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

export const imageBlockFromDownloadedImage = (
  image: DownloadedImage,
): ImageBlock => ({
  base64: Buffer.from(image.bytes).toString('base64'),
  mimeType: EXT_MIME_TYPES[image.ext] ?? 'application/octet-stream',
})
