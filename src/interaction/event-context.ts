import type { Logger } from '@/logger/logger'
import type { SlackWebClient } from '@/slack/web-client'
import type { SlackEventCallback } from '@/types/slack-payloads'

export interface EventContext {
  readonly envelope: SlackEventCallback
  readonly slackClient: SlackWebClient
  readonly logger: Logger
}
