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

// Slack's "insert file" compose action embeds the file as a bare encoded ID
// (e.g. `F0BG20H5AVA`) in the message text instead of populating `files[]`.
// Anchors only the `F` prefix and a conservative minimum length to avoid
// matching short all-caps words like "FOO"; the digit lookahead additionally
// rules out longer all-letter words like "FRIENDSHIP" since Slack IDs are
// always alphanumeric.
const INLINE_FILE_ID_PATTERN = /\bF(?=[A-Z0-9]*[0-9])[A-Z0-9]{8,}\b/gu

export const extractInlineFileIds = (text: string): readonly string[] => {
  const matches = text.match(INLINE_FILE_ID_PATTERN) ?? []
  return Array.from(new Set(matches))
}

export const stripInlineFileIds = (
  text: string,
  ids: readonly string[],
): string => {
  let result = text
  for (const id of ids) {
    result = result.replace(new RegExp(`\\s*\\b${id}\\b\\s*`, 'gu'), ' ')
  }
  return result.trim()
}

// files.info succeeds for any file the bot token can see, which is not
// scoped to the channel the current message was posted in. A resolved
// inline file reference must additionally be shared into that channel
// before it is trusted, or a user could reference a file ID copied from
// another channel/DM (e.g. via a permalink) and have its contents leak into
// this channel's agent context.
export const isFileSharedToChannel = (
  file: SlackFile,
  channelId: string,
): boolean =>
  (file.channels ?? []).includes(channelId) ||
  (file.groups ?? []).includes(channelId) ||
  (file.ims ?? []).includes(channelId)
