export interface ConversationThreadKey {
  readonly teamId: string
  readonly channelId: string
  readonly threadRootTs: string
}

// Slack team/channel IDs and message timestamps never contain a colon, so
// this composition is safely reversible in principle and needs no escaping.
// No mapping table is kept: the same key always derives the same thread_id.
export const deriveConversationThreadId = (
  key: ConversationThreadKey,
): string => `${key.teamId}:${key.channelId}:${key.threadRootTs}`

// Inverse of deriveConversationThreadId, for callers (e.g. delegation tools)
// that only receive the joined thread_id and need the parts back out.
export const parseConversationThreadId = (
  threadId: string,
): ConversationThreadKey => {
  const parts = threadId.split(':')
  const [teamId, channelId, threadRootTs] = parts
  if (
    parts.length !== 3 ||
    teamId === undefined ||
    channelId === undefined ||
    threadRootTs === undefined
  ) {
    throw new Error(`invalid conversation thread_id: ${threadId}`)
  }
  return { teamId, channelId, threadRootTs }
}
