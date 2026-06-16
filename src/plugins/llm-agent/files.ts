import type { SlackEvent, SlackFile } from '@/types/slack-payloads'

export const isImageFile = (file: SlackFile): boolean =>
  typeof file.mimetype === 'string' && file.mimetype.startsWith('image/')

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
