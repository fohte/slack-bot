import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type { TaskCrClient } from '@/plugins/llm-agent/task-cr-client'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'

export const DEFAULT_TASK_CR_NAMESPACE = 'kubeopencode'
export const DEFAULT_TASK_CR_AGENT_NAME = 'slack-bot'
export const DEFAULT_POLL_INTERVAL_MS = 5000
export const DEFAULT_SUCCESS_FALLBACK =
  '(opencode did not produce an assistant message)'

export interface SlackEnvelope {
  readonly eventId: string
  readonly teamId: string
  readonly channelId: string
  readonly threadRootTs: string
  readonly text: string
}

export interface ProcessMentionDeps {
  readonly taskCrClient: TaskCrClient
  readonly opencodeClient: OpencodeClient
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
  readonly slackClient: SlackWebClient
  readonly namespace?: string | undefined
  readonly agentName?: string | undefined
  readonly successFallbackText?: string | undefined
  readonly pollIntervalMs?: number | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  readonly logger?: Logger | undefined
}

export interface ResolvedDeps {
  readonly taskCrClient: TaskCrClient
  readonly opencodeClient: OpencodeClient
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
  readonly slackClient: SlackWebClient
  readonly namespace: string
  readonly agentName: string
  readonly successFallbackText: string
  readonly pollIntervalMs: number
  readonly sleep: (ms: number) => Promise<void>
  readonly logger: Logger
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const resolveDeps = (deps: ProcessMentionDeps): ResolvedDeps => ({
  taskCrClient: deps.taskCrClient,
  opencodeClient: deps.opencodeClient,
  eventLogStore: deps.eventLogStore,
  threadSessionStore: deps.threadSessionStore,
  slackClient: deps.slackClient,
  namespace: deps.namespace ?? DEFAULT_TASK_CR_NAMESPACE,
  agentName: deps.agentName ?? DEFAULT_TASK_CR_AGENT_NAME,
  successFallbackText: deps.successFallbackText ?? DEFAULT_SUCCESS_FALLBACK,
  pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  sleep: deps.sleep ?? defaultSleep,
  logger: deps.logger ?? noopLogger,
})
