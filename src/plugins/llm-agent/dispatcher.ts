import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import {
  DEFAULT_THINKING_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import { extractSlackFiles, isImageFile } from '@/plugins/llm-agent/files'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import type {
  TaskCrClient,
  TaskCrContext,
  TaskCrSpec,
} from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'
import type { SlackFile } from '@/types/slack-payloads'

export const DEFAULT_TASK_CR_NAMESPACE = 'kubeopencode'
export const DEFAULT_TASK_CR_AGENT_NAME = 'slack-bot'

export interface TaskDispatcherOptions {
  readonly taskCrClient: TaskCrClient
  readonly threadSessionStore: ThreadSessionStore
  readonly eventLogStore: EventLogStore
  readonly slackClient: SlackWebClient
  readonly thinkingStatus?: string | undefined
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
  readonly files: readonly SlackFile[]
} => {
  if (event.type !== 'message' && event.type !== 'app_mention')
    return { files: [] }
  const channel = typeof event.channel === 'string' ? event.channel : undefined
  const ts = typeof event.ts === 'string' ? event.ts : undefined
  const threadTs =
    typeof event.thread_ts === 'string' ? event.thread_ts : undefined
  const text = typeof event.text === 'string' ? event.text : undefined
  return { channel, ts, threadTs, text, files: extractSlackFiles(event) }
}

const buildAttachmentSummary = (images: readonly SlackFile[]): string => {
  const lines = images.map((f, idx) => {
    const fallback = f.id ?? `image-${String(idx + 1)}`
    const name = f.name ?? f.title ?? fallback
    const mime = f.mimetype ?? 'application/octet-stream'
    const size = typeof f.size === 'number' ? ` ${String(f.size)} bytes` : ''
    return `- ${name} (${mime}${size})`
  })
  return [
    `The user attached ${String(images.length)} image(s) to this Slack message. Only this metadata is available; the image bytes themselves are not included.`,
    ...lines,
  ].join('\n')
}

export const createTaskDispatcher = (
  options: TaskDispatcherOptions,
): TaskDispatcher => {
  const logger = options.logger ?? noopLogger
  const namespace = options.namespace ?? DEFAULT_TASK_CR_NAMESPACE
  const agentName = options.agentName ?? DEFAULT_TASK_CR_AGENT_NAME
  const thinkingStatus = options.thinkingStatus ?? DEFAULT_THINKING_STATUS
  const { taskCrClient, threadSessionStore, eventLogStore, slackClient } =
    options

  return async (accepted) => {
    const eventId = accepted.ctx.envelope.event_id
    if (eventId === undefined || eventId === '') {
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
      // Swallow rather than throw: throwing here would roll back the
      // event_log row, causing Slack retries to re-enter this branch
      // forever. Logging + accepting the event drops the bad delivery.
      logger.warn(
        {
          event: 'llm_agent_dispatch_skipped_missing_fields',
          event_id: eventId,
          has_team_id: teamId !== undefined,
          has_channel: channel !== undefined,
          has_thread_root_ts: threadRootTs !== undefined,
        },
        'llm-agent skipping dispatch: required envelope fields missing',
      )
      return
    }

    // Set the indicator before create so that a fast-completing Task can
    // never have its watcher-driven clear race ahead of our set and leave
    // a stale indicator sitting in the thread.
    await trySetAssistantStatus({
      slackClient,
      target: { channelId: channel, threadTs: threadRootTs },
      status: thinkingStatus,
      logger,
    })

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

    const images = fields.files.filter(isImageFile)
    if (images.length > 0) {
      contexts.push({
        name: 'slack-image-attachments',
        mountPath: 'slack-context/image-attachments',
        text: buildAttachmentSummary(images),
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

    let outcome
    try {
      outcome = await taskCrClient.create(task)
    } catch (error) {
      logger.error(
        {
          event: 'llm_agent_task_dispatch_failed',
          event_id: eventId,
          task_name: taskName,
          namespace,
          err: error,
        },
        'llm-agent failed to create Task CR',
      )
      throw error
    }

    const { updated } = await eventLogStore.markTaskName(eventId, taskName)
    if (updated === 0) {
      // Reachable only when retention prune removed the event_log row
      // between INSERT in the plugin and UPDATE here.
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
        image_count: images.length > 0 ? images.length : undefined,
      },
      outcome === 'created'
        ? 'llm-agent dispatched Task CR'
        : 'llm-agent Task CR already existed; treated as accepted',
    )
  }
}
