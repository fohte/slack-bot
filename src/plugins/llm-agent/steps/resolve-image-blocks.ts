import type { ImageBlock } from '@/plugins/llm-agent/conversation-agent'
import { imageBlockFromResizedImage } from '@/plugins/llm-agent/conversation-agent'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/dispatcher-deps'
import { SLACK_FILE_DOWNLOAD_MAX_BYTES } from '@/slack/web-client'
import type { SlackFile } from '@/types/slack-payloads'

// A conservative budget for base64-inlined image content blocks sent to the
// LLM API, mirroring the per-image / total caps the k8s ConfigMap-era
// pipeline used.
const SINGLE_IMAGE_BYTE_CAP = 500 * 1024
const TOTAL_IMAGE_BYTE_CAP = 700 * 1024

const MIME_TO_EXT: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

const extForImage = (file: SlackFile): string => {
  const mime = typeof file.mimetype === 'string' ? file.mimetype : ''
  const fromMime = MIME_TO_EXT.get(mime)
  if (fromMime !== undefined) return fromMime
  const name = file.name ?? file.title ?? ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    const ext = name
      .slice(dot + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    if (ext.length > 0) return ext
  }
  return 'bin'
}

interface FittedImage {
  readonly bytes: Uint8Array
  readonly ext: string
}

const fitImageToCap = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  file: SlackFile,
  bytes: Uint8Array,
  perImageCap: number,
): Promise<FittedImage | undefined> => {
  if (bytes.byteLength <= perImageCap) {
    return { bytes, ext: extForImage(file) }
  }
  const outcome = await resolved.imageResizer.resize(bytes, perImageCap)
  if (!outcome.ok) {
    resolved.logger.warn(
      {
        event: 'llm_agent_slack_image_too_large',
        event_id: env.eventId,
        slack_file_id: file.id,
        bytes: bytes.byteLength,
        cap: perImageCap,
        reason: outcome.reason,
      },
      'slack image exceeds cap and could not be resized to fit; dropping this attachment',
    )
    return undefined
  }
  resolved.logger.info(
    {
      event: 'llm_agent_slack_image_resized',
      event_id: env.eventId,
      slack_file_id: file.id,
      original_bytes: bytes.byteLength,
      resized_bytes: outcome.bytes.byteLength,
      cap: perImageCap,
    },
    'slack image exceeded cap; resized to fit',
  )
  return { bytes: outcome.bytes, ext: outcome.ext }
}

// Serial: downloadFile does not retry, so issuing all images in parallel
// would 429 the whole batch on a single rate-limit hit.
export const resolveImageBlocks = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
): Promise<readonly ImageBlock[]> => {
  const blocks: ImageBlock[] = []
  let totalBytes = 0
  for (const file of env.images) {
    if (totalBytes >= TOTAL_IMAGE_BYTE_CAP) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_image_total_cap_reached',
          event_id: env.eventId,
          slack_file_id: file.id,
          total_bytes: totalBytes,
          cap: TOTAL_IMAGE_BYTE_CAP,
        },
        'slack image would push the attachment budget over its total cap; dropping this and any later attachments',
      )
      break
    }
    const url = file.url_private_download ?? file.url_private
    if (typeof url !== 'string' || url.length === 0) continue
    if (
      typeof file.size === 'number' &&
      file.size > SLACK_FILE_DOWNLOAD_MAX_BYTES
    ) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_image_download_too_large',
          event_id: env.eventId,
          slack_file_id: file.id,
          bytes: file.size,
          cap: SLACK_FILE_DOWNLOAD_MAX_BYTES,
        },
        'slack image exceeds the download size guard; dropping this attachment without downloading',
      )
      continue
    }
    let bytes: Uint8Array
    try {
      const result = await resolved.slackClient.downloadFile(url)
      bytes = result.bytes
    } catch (err) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_image_download_failed',
          event_id: env.eventId,
          slack_file_id: file.id,
          err,
        },
        'slack image download failed; dropping this attachment',
      )
      continue
    }
    const perImageCap = Math.min(
      SINGLE_IMAGE_BYTE_CAP,
      TOTAL_IMAGE_BYTE_CAP - totalBytes,
    )
    const fitted = await fitImageToCap(resolved, env, file, bytes, perImageCap)
    if (fitted === undefined) continue
    totalBytes += fitted.bytes.byteLength
    blocks.push(imageBlockFromResizedImage(fitted))
  }
  return blocks
}
