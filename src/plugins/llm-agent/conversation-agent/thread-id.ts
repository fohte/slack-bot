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
