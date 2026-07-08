import {
  CLEAR_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type {
  ProcessMentionDeps,
  ResolvedDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { resolveDeps } from '@/plugins/llm-agent/process-mention-deps'
import { configMapNameForSlackEvent } from '@/plugins/llm-agent/steps/submit-task'
import type { TerminalOutcome } from '@/plugins/llm-agent/steps/wait-for-completion'

// Slack mrkdwn would otherwise interpret <, >, & inside the unstructured
// k8s status message as user/channel mentions or HTML entities.
// https://docs.slack.dev/messaging/formatting-message-text#escaping
const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatFailureText = (message: string | undefined): string => {
  const trimmed = message?.trim()
  if (trimmed !== undefined && trimmed.length > 0) {
    return `Task failed: ${escapeMrkdwn(trimmed)}`
  }
  return 'Task failed.'
}

const resolveSessionId = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
  taskName: string,
): Promise<string | undefined> => {
  // Resumed thread: the opencode session title still matches the *first*
  // task.name in this thread, so findSessionIdByTitle would miss it on
  // the 2nd+ turn. Look up by Slack thread first.
  try {
    const stored = await resolved.threadSessionStore.lookup({
      slackTeamId: env.teamId,
      slackChannelId: env.channelId,
      threadRootTs: env.threadRootTs,
    })
    if (stored !== undefined) return stored
  } catch (error) {
    resolved.logger.error(
      {
        event: 'llm_agent_response_thread_session_lookup_failed',
        task_name: taskName,
        err: error,
      },
      'failed to look up opencode session via thread_session_map; falling back to title lookup',
    )
  }
  // First turn: thread_session_map is empty; opencode session title is
  // task.name (set by our wrapper).
  try {
    return await resolved.opencodeClient.findSessionIdByTitle(taskName)
  } catch (error) {
    resolved.logger.error(
      {
        event: 'llm_agent_response_session_lookup_failed',
        task_name: taskName,
        err: error,
      },
      'failed to look up opencode session by title; falling back to placeholder text',
    )
    return undefined
  }
}

// Structurally compatible with @slack/types' MarkdownBlock; kept local so
// this file doesn't need @slack/types as a direct dependency.
//
// chat.postMessage also accepts a top-level markdown_text field, but it
// can't be combined with text/blocks, so it would drop the notification/
// accessibility fallback text carries.
interface SlackMarkdownBlock {
  readonly type: 'markdown'
  readonly text: string
}

// https://docs.slack.dev/reference/block-kit/blocks/markdown-block
const MARKDOWN_BLOCK_TEXT_LIMIT = 12_000

// Array.from splits on Unicode code points rather than UTF-16 code units,
// so slicing here can't land inside a surrogate pair (e.g. an emoji).
const truncateForMarkdownBlock = (text: string): string => {
  const chars = Array.from(text)
  return chars.length > MARKDOWN_BLOCK_TEXT_LIMIT
    ? `${chars.slice(0, MARKDOWN_BLOCK_TEXT_LIMIT - 1).join('')}…`
    : text
}

interface SuccessResponse {
  readonly text: string
  readonly blocks: SlackMarkdownBlock[] | undefined
}

const buildSuccessResponse = async (
  resolved: ResolvedDeps,
  taskName: string,
  sessionId: string | undefined,
): Promise<SuccessResponse> => {
  let assistantText: string | undefined
  if (sessionId !== undefined) {
    try {
      assistantText =
        await resolved.opencodeClient.fetchLatestAssistantText(sessionId)
    } catch (error) {
      // fallback to the placeholder so the user still learns the Task
      // finished even when opencode is unreachable.
      resolved.logger.error(
        {
          event: 'llm_agent_response_opencode_fetch_failed',
          task_name: taskName,
          session_id: sessionId,
          err: error,
        },
        'failed to fetch latest assistant message from opencode; falling back to placeholder text',
      )
    }
  } else {
    resolved.logger.warn(
      {
        event: 'llm_agent_response_session_not_found',
        task_name: taskName,
      },
      'opencode session not found for Completed Task; terminating with placeholder',
    )
  }
  // Whitespace-only text would make chat.postMessage reject with no_text
  // and trigger an unmark/retry loop on the same input.
  if (assistantText === undefined || assistantText.trim().length === 0) {
    return { text: resolved.successFallbackText, blocks: undefined }
  }
  // The markdown block renders GFM (tables, etc.) natively; text carries
  // the raw Markdown too, escaped the same way as formatFailureText since
  // Slack still parses it as mrkdwn for the notification/accessibility
  // fallback.
  return {
    text: escapeMrkdwn(assistantText),
    blocks: [
      { type: 'markdown', text: truncateForMarkdownBlock(assistantText) },
    ],
  }
}

interface ResponseBody extends SuccessResponse {
  readonly sessionId: string | undefined
}

const buildResponseBody = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
  taskName: string,
  outcome: TerminalOutcome,
): Promise<ResponseBody> => {
  if (outcome.kind === 'failed') {
    return {
      text: formatFailureText(outcome.message),
      blocks: undefined,
      sessionId: undefined,
    }
  }
  const sessionId = await resolveSessionId(resolved, env, taskName)
  const { text, blocks } = await buildSuccessResponse(
    resolved,
    taskName,
    sessionId,
  )
  return { text, blocks, sessionId }
}

// Post the final Slack message and tear down per-task state (clear the
// assistant-status indicator, persist the opencode session id for
// thread resumption). event_log markResponded gates against a duplicate
// post if another delivery already won.
export const respond = async (
  env: SlackEnvelope,
  taskName: string,
  outcome: TerminalOutcome,
  deps: ProcessMentionDeps,
): Promise<void> => {
  const resolved = resolveDeps(deps)
  const { text, blocks, sessionId } = await buildResponseBody(
    resolved,
    env,
    taskName,
    outcome,
  )

  const { updated } = await resolved.eventLogStore.markResponded(env.eventId)
  if (updated === 0) {
    resolved.logger.info(
      {
        event: 'llm_agent_task_responded_already',
        task_name: taskName,
        slack_event_id: env.eventId,
        phase: outcome.kind,
      },
      'llm-agent skipping Slack post; event_log row already marked responded',
    )
    return
  }

  try {
    await resolved.slackClient.postMessage({
      channel: env.channelId,
      thread_ts: env.threadRootTs,
      text,
      ...(blocks !== undefined ? { blocks } : {}),
    })
  } catch (error) {
    try {
      await resolved.eventLogStore.unmarkResponded(env.eventId)
    } catch (rollbackError) {
      resolved.logger.error(
        {
          event: 'llm_agent_response_unmark_failed',
          task_name: taskName,
          slack_event_id: env.eventId,
          err: rollbackError,
        },
        'failed to roll back event_log row after Slack post failure',
      )
    }
    throw error
  }

  await trySetAssistantStatus({
    slackClient: resolved.slackClient,
    target: { channelId: env.channelId, threadTs: env.threadRootTs },
    status: CLEAR_STATUS,
    logger: resolved.logger,
  })

  if (outcome.kind === 'completed' && sessionId !== undefined) {
    try {
      await resolved.threadSessionStore.upsert({
        slackTeamId: env.teamId,
        slackChannelId: env.channelId,
        threadRootTs: env.threadRootTs,
        opencodeSessionId: sessionId,
      })
    } catch (error) {
      resolved.logger.error(
        {
          event: 'llm_agent_response_session_upsert_failed',
          task_name: taskName,
          session_id: sessionId,
          err: error,
        },
        'failed to upsert thread_session_map after responding',
      )
    }
  }

  // Best-effort image ConfigMap cleanup. The Task CR has already reached a
  // terminal phase so the agent pod no longer needs the mount. 404 means the
  // Task ran without image attachments, which the delete impl treats as a
  // no-op.
  try {
    await resolved.configMapClient.delete({
      name: configMapNameForSlackEvent(taskName),
      namespace: resolved.namespace,
    })
  } catch (cleanupError) {
    resolved.logger.warn(
      {
        event: 'llm_agent_image_configmap_cleanup_failed',
        task_name: taskName,
        err: cleanupError,
      },
      'failed to delete image ConfigMap after responding',
    )
  }

  resolved.logger.info(
    {
      event: 'llm_agent_task_responded',
      task_name: taskName,
      slack_event_id: env.eventId,
      phase: outcome.kind,
      session_id: sessionId,
    },
    'llm-agent posted Task CR response to Slack',
  )
}
