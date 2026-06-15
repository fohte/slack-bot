import type { SlackFile } from '@/types/slack-payloads'

export const isImageFile = (file: SlackFile): boolean =>
  typeof file.mimetype === 'string' && file.mimetype.startsWith('image/')
