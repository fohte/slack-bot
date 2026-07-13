import { randomUUID } from 'node:crypto'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { A2aTaskTracker } from '@/plugins/llm-agent/a2a-task-tracker'
import type { ConversationAgent } from '@/plugins/llm-agent/conversation-agent'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { ImageResizer } from '@/plugins/llm-agent/image-resizer'
import { createSharpImageResizer } from '@/plugins/llm-agent/image-resizer'
import type {
  DelegationPushNotificationConfig,
  RemoteAgentRegistry,
} from '@/plugins/llm-agent/remote-agent-registry'
import { DEFAULT_A2A_TASK_DEADLINE_MS } from '@/plugins/llm-agent/remote-agent-registry'
import type { SlackWebClient } from '@/slack/web-client'
import type { SlackFile } from '@/types/slack-payloads'

export const DEFAULT_SUCCESS_FALLBACK =
  '(the assistant did not produce a reply)'

export interface SlackEnvelope {
  readonly eventId: string
  readonly teamId: string
  readonly channelId: string
  readonly threadRootTs: string
  readonly text: string
  readonly images: readonly SlackFile[]
}

export interface DispatcherDeps {
  readonly conversationAgent: ConversationAgent
  readonly remoteAgentRegistry: RemoteAgentRegistry
  readonly a2aTaskTracker: A2aTaskTracker
  readonly eventLogStore: EventLogStore
  readonly slackClient: SlackWebClient
  readonly imageResizer?: ImageResizer | undefined
  // Own service's push endpoint + shared token, threaded into both fresh
  // delegations (via DelegationToolDependencies, wired at the call site) and
  // task-resume message/send calls. Omitted means delegated tasks rely
  // solely on tasks/get polling to surface their completion.
  readonly pushNotificationConfig?: DelegationPushNotificationConfig | undefined
  readonly taskDeadlineMs?: number | undefined
  readonly successFallbackText?: string | undefined
  readonly now?: (() => Date) | undefined
  readonly randomUUID?: (() => string) | undefined
  readonly logger?: Logger | undefined
}

export interface ResolvedDispatcherDeps {
  readonly conversationAgent: ConversationAgent
  readonly remoteAgentRegistry: RemoteAgentRegistry
  readonly a2aTaskTracker: A2aTaskTracker
  readonly eventLogStore: EventLogStore
  readonly slackClient: SlackWebClient
  readonly imageResizer: ImageResizer
  readonly pushNotificationConfig: DelegationPushNotificationConfig | undefined
  readonly taskDeadlineMs: number
  readonly successFallbackText: string
  readonly now: () => Date
  readonly randomUUID: () => string
  readonly logger: Logger
}

export const resolveDeps = (deps: DispatcherDeps): ResolvedDispatcherDeps => ({
  conversationAgent: deps.conversationAgent,
  remoteAgentRegistry: deps.remoteAgentRegistry,
  a2aTaskTracker: deps.a2aTaskTracker,
  eventLogStore: deps.eventLogStore,
  slackClient: deps.slackClient,
  imageResizer: deps.imageResizer ?? createSharpImageResizer(),
  pushNotificationConfig: deps.pushNotificationConfig,
  taskDeadlineMs: deps.taskDeadlineMs ?? DEFAULT_A2A_TASK_DEADLINE_MS,
  successFallbackText: deps.successFallbackText ?? DEFAULT_SUCCESS_FALLBACK,
  now: deps.now ?? (() => new Date()),
  randomUUID: deps.randomUUID ?? randomUUID,
  logger: deps.logger ?? noopLogger,
})
