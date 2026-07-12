import type { ResizedImage } from '@/plugins/llm-agent/image-resizer'

// LLM-facing shape the existing image pipeline's output is converted to
// before it reaches ConversationAgent.respond.
export interface ImageBlock {
  readonly base64: string
  readonly mimeType: string
}

// ImageResizer always re-encodes to JPEG (see RESIZED_EXT in image-resizer.ts),
// so 'jpg' is the only key exercised today; the map exists so a future resizer
// extension fails closed (an unmapped ext) rather than mislabeling the mime type.
const EXT_MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export const imageBlockFromResizedImage = (
  resized: ResizedImage,
): ImageBlock => ({
  base64: Buffer.from(resized.bytes).toString('base64'),
  mimeType: EXT_MIME_TYPES[resized.ext] ?? 'application/octet-stream',
})
