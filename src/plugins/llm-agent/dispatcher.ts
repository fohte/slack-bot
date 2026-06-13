import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import type {
  TaskCrClient,
  TaskCrContext,
  TaskCrSpec,
} from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'

export const DEFAULT_TASK_CR_NAMESPACE = 'kubeopencode'
export const DEFAULT_TASK_CR_AGENT_NAME = 'slack-bot'

export interface TaskDispatcherOptions {
  readonly taskCrClient: TaskCrClient
  readonly threadSessionStore: ThreadSessionStore
  readonly eventLogStore: EventLogStore
  readonly namespace?: string | undefined
  readonly agentName?: string | undefined
  readonly logger?: Logger | undefined
}

export type TaskDispatcher = (accepted: LlmAgentAcceptedEvent) => Promise<void>

// Slack mentions can include a label form `<@U123|name>` in addition to the
// plain `<@U123>` form, so the optional `|...` segment must be tolerated.
const MENTION_PREFIX_PATTERN = /^\s*(?:<@[A-Z0-9_]+(?:\|[^>]*)?>\s*)+/u

const stripMentionPrefix = (text: string): string =>
  text.replace(MENTION_PREFIX_PATTERN, '').trim()

const extractEventFields = (
  event: LlmAgentAcceptedEvent['event'],
): {
  readonly channel?: string | undefined
  readonly ts?: string | undefined
  readonly threadTs?: string | undefined
  readonly text?: string | undefined
} => {
  if (event.type !== 'message' && event.type !== 'app_mention') return {}
  const channel = typeof event.channel === 'string' ? event.channel : undefined
  const ts = typeof event.ts === 'string' ? event.ts : undefined
  const threadTs =
    typeof event.thread_ts === 'string' ? event.thread_ts : undefined
  const text = typeof event.text === 'string' ? event.text : undefined
  return { channel, ts, threadTs, text }
}

export const createTaskDispatcher = (
  options: TaskDispatcherOptions,
): TaskDispatcher => {
  const logger = options.logger ?? noopLogger
  const namespace = options.namespace ?? DEFAULT_TASK_CR_NAMESPACE
  const agentName = options.agentName ?? DEFAULT_TASK_CR_AGENT_NAME
  const { taskCrClient, threadSessionStore, eventLogStore } = options

  return async (accepted) => {
    const eventId = accepted.ctx.envelope.event_id
    if (eventId === undefined || eventId === '') {
      // The plugin already guards against missing event_id before invoking
      // onAccepted; treat as a programming error if it happens.
      throw new Error('llm-agent dispatcher invoked without event_id')
    }

    const teamId = accepted.ctx.envelope.team_id
    const fields = extractEventFields(accepted.event)
    const channel = fields.channel
    const threadRootTs = fields.threadTs ?? fields.ts
    if (
      teamId === undefined ||
      channel === undefined ||
      threadRootTs === undefined
    ) {
      throw new Error(
        'llm-agent dispatcher requires team_id, channel, and thread root ts',
      )
    }

    const opencodeSessionId = await threadSessionStore.lookup({
      slackTeamId: teamId,
      slackChannelId: channel,
      threadRootTs,
    })

    const description = stripMentionPrefix(fields.text ?? '')

    const contexts: TaskCrContext[] = [
      {
        name: 'slack-channel',
        mountPath: 'slack-context/channel',
        text: channel,
      },
      {
        name: 'slack-thread-ts',
        mountPath: 'slack-context/thread-ts',
        text: threadRootTs,
      },
    ]
    if (opencodeSessionId !== undefined) {
      contexts.push({
        name: 'opencode-session-id',
        mountPath: 'slack-context/session-id',
        text: opencodeSessionId,
      })
    }

    const taskName = taskCrNameForSlackEvent(eventId)
    const task: TaskCrSpec = {
      name: taskName,
      namespace,
      agentName,
      description,
      contexts,
    }

    const outcome = await taskCrClient.create(task)

    const { updated } = await eventLogStore.markTaskName(eventId, taskName)
    if (updated === 0) {
      // event_log row was already pruned (or never existed) by the time we
      // tried to record task_name. The Task CR is still created; the linkage
      // to its originating Slack event is just no longer queryable via
      // event_log.
      logger.warn(
        {
          event: 'llm_agent_event_log_task_name_orphan',
          event_id: eventId,
          task_name: taskName,
        },
        'event_log row missing when recording task_name',
      )
    }

    logger.info(
      {
        event: 'llm_agent_task_dispatched',
        event_id: eventId,
        task_name: taskName,
        namespace,
        outcome,
        session_resumed: opencodeSessionId !== undefined,
      },
      outcome === 'created'
        ? 'llm-agent dispatched Task CR'
        : 'llm-agent Task CR already existed; treated as accepted',
    )
  }
}
