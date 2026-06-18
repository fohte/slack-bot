import type { SlackEvent, SlackFile } from '@/types/slack-payloads'

// SlackFile elements come from the raw event payload via an `unknown`-cast
// array, so the input is treated as `unknown` here to defensively reject
// null/non-object entries before the mimetype field is read.
export const isImageFile = (file: unknown): file is SlackFile => {
  if (file === null || typeof file !== 'object') return false
  const mimetype = (file as { mimetype?: unknown }).mimetype
  return typeof mimetype === 'string' && mimetype.startsWith('image/')
}

export const extractSlackFiles = (event: SlackEvent): readonly SlackFile[] => {
  if (event.type !== 'message' && event.type !== 'app_mention') return []
  // SlackEventBase carries `[key: string]: unknown`, so `event.files` widens
  // to `unknown` here; the runtime check + cast is what the narrow brings.
  const files = event.files
  return Array.isArray(files) ? (files as readonly SlackFile[]) : []
}

export const extractSlackImageFiles = (
  event: SlackEvent,
): readonly SlackFile[] => extractSlackFiles(event).filter(isImageFile)
