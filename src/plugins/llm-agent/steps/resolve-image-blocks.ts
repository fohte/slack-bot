import { err, ok, type Result, ResultAsync } from 'neverthrow'

import type {
  DownloadedImage,
  ImageBlock,
} from '#plugins/llm-agent/conversation-agent/index'
import { imageBlockFromDownloadedImage } from '#plugins/llm-agent/conversation-agent/index'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '#plugins/llm-agent/dispatcher-deps'
import { SlackImageThumbnailUnavailableError } from '#types/errors'
import type { SlackFile } from '#types/slack-payloads'

// A conservative budget for base64-inlined image content blocks sent to the
// LLM API, mirroring the per-image / total caps the k8s ConfigMap-era
// pipeline used. SINGLE_IMAGE_BYTE_CAP is also reused by
// steps/sync-thread-context.ts for thread-context images.
export const SINGLE_IMAGE_BYTE_CAP = 500 * 1024
const TOTAL_IMAGE_BYTE_CAP = 700 * 1024

const MIME_TO_EXT: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

// Slack exposes these as optional URLs, largest first: "Depending on the
// original file's size, you may even find a thumb_480, thumb_720, thumb_960,
// or thumb_1024 property" (docs.slack.dev/reference/objects/file-object).
// thumb_64/80/160 are effectively always present as fallbacks for smaller
// images.
const candidateThumbUrls = (file: SlackFile): readonly string[] =>
  [
    file.thumb_1024,
    file.thumb_960,
    file.thumb_800,
    file.thumb_720,
    file.thumb_480,
    file.thumb_360,
    file.thumb_160,
    file.thumb_80,
    file.thumb_64,
  ].filter((url): url is string => typeof url === 'string' && url.length > 0)

const extFromUrl = (url: string): string | undefined => {
  const path = url.split('?')[0] ?? url
  const dot = path.lastIndexOf('.')
  if (dot <= 0 || dot === path.length - 1) return undefined
  const ext = path
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return ext.length > 0 ? ext : undefined
}

// Slack can re-encode a thumbnail into a different format than the original
// upload, so the ext is read off the actual downloaded response instead of
// trusting the original SlackFile's mimetype.
const extForThumbnail = (
  contentType: string | undefined,
  url: string,
): string => {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase()
  const fromMime = mime !== undefined ? MIME_TO_EXT.get(mime) : undefined
  return fromMime ?? extFromUrl(url) ?? 'jpg'
}

// Serial: downloadFile does not retry, so issuing every candidate size for
// one image in parallel would 429 the whole batch on a single rate-limit hit.
// Exported for reuse by steps/sync-thread-context.ts, which resolves
// thumbnails for images attached to unseen thread messages through this same
// pipeline.
export const resolveThumbnail = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  file: SlackFile,
  perImageCap: number,
): Promise<Result<DownloadedImage, SlackImageThumbnailUnavailableError>> => {
  const candidates = candidateThumbUrls(file)
  for (const url of candidates) {
    const downloadResult = await ResultAsync.fromPromise(
      resolved.slackClient.downloadFile(url),
      (caughtErr) => caughtErr,
    )
    if (downloadResult.isErr()) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_thumbnail_download_failed',
          event_id: env.eventId,
          slack_file_id: file.id,
          thumbnail_url: url,
          err: downloadResult.error,
        },
        'slack thumbnail download failed; trying the next smaller tier',
      )
      continue
    }
    const { bytes, contentType } = downloadResult.value
    if (bytes.byteLength <= perImageCap) {
      return ok({ bytes, ext: extForThumbnail(contentType, url) })
    }
    resolved.logger.warn(
      {
        event: 'llm_agent_slack_thumbnail_too_large',
        event_id: env.eventId,
        slack_file_id: file.id,
        thumbnail_url: url,
        bytes: bytes.byteLength,
        cap: perImageCap,
      },
      'slack thumbnail exceeds cap; trying the next smaller tier',
    )
  }
  return err(
    new SlackImageThumbnailUnavailableError(
      `slack file ${file.id ?? '(unknown id)'} has no thumb_* variant that fits the ${String(perImageCap)}-byte cap (checked ${String(candidates.length)} candidate size(s))`,
    ),
  )
}

// Serial: downloadFile does not retry, so issuing all images in parallel
// would 429 the whole batch on a single rate-limit hit. An image with no
// usable thumbnail rejects this whole call — including blocks already
// resolved for earlier images — rather than being dropped on its own, so the
// caller's existing failure path surfaces it as a full mention failure
// instead of a silently incomplete reply.
export const resolveImageBlocks = async (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
): Promise<
  Result<readonly ImageBlock[], SlackImageThumbnailUnavailableError>
> => {
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
    const perImageCap = Math.min(
      SINGLE_IMAGE_BYTE_CAP,
      TOTAL_IMAGE_BYTE_CAP - totalBytes,
    )
    const thumbnailResult = await resolveThumbnail(
      resolved,
      env,
      file,
      perImageCap,
    )
    if (thumbnailResult.isErr()) return err(thumbnailResult.error)
    totalBytes += thumbnailResult.value.bytes.byteLength
    blocks.push(imageBlockFromDownloadedImage(thumbnailResult.value))
  }
  return ok(blocks)
}
