import type { SlackEvent, SlackFile } from '@/types/slack-payloads'

export const isImageFile = (file: SlackFile): boolean =>
  typeof file.mimetype === 'string' && file.mimetype.startsWith('image/')

export const extractSlackFiles = (event: SlackEvent): readonly SlackFile[] => {
  if (event.type !== 'message' && event.type !== 'app_mention') return []
  const files = event.files
  return Array.isArray(files) ? (files as readonly SlackFile[]) : []
}
