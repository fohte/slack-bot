import type { SlackEventCallback } from '@/types/slack-payloads'

export interface EventContext {
  readonly envelope: SlackEventCallback
}
