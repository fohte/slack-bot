import {
  CLEAR_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/dispatcher-deps'

// Slack mrkdwn would otherwise interpret <, >, & inside the response text as
// user/channel mentions or HTML entities.
// https://docs.slack.dev/messaging/formatting-message-text#escaping
const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Structurally compatible with @slack/types' MarkdownBlock; kept local so
// this file doesn't need @slack/types as a direct dependency.
interface SlackMarkdownBlock {
  readonly type: 'markdown'
  readonly text: string
}

// https://docs.slack.dev/reference/block-kit/blocks/markdown-block
const MARKDOWN_BLOCK_TEXT_LIMIT = 12_000

// Slicing on MARKDOWN_BLOCK_TEXT_LIMIT alone can land between the two
// UTF-16 units of a surrogate pair (e.g. an emoji), leaving a lone
// surrogate. Back the cut off by one more unit when that would happen,
// dropping the whole character instead of splitting it.
const isSurrogatePairAt = (text: string, lowSurrogateIndex: number): boolean =>
  text.charCodeAt(lowSurrogateIndex - 1) >= 0xd800 &&
  text.charCodeAt(lowSurrogateIndex - 1) <= 0xdbff &&
  text.charCodeAt(lowSurrogateIndex) >= 0xdc00 &&
  text.charCodeAt(lowSurrogateIndex) <= 0xdfff

const truncateForMarkdownBlock = (text: string): string => {
  if (text.length <= MARKDOWN_BLOCK_TEXT_LIMIT) return text
  const cutoff = MARKDOWN_BLOCK_TEXT_LIMIT - 1
  const end = isSurrogatePairAt(text, cutoff) ? cutoff - 1 : cutoff
  return `${text.slice(0, end)}…`
}

export interface PostFinalResponseResult {
  // False when event_log markResponded lost the race to another delivery of
  // the same Slack event, in which case this is a no-op — callers that
  // count actual Slack posts must check this rather than assume the call
  // resolving means a message went out.
  readonly posted: boolean
}

const buildBlocks = (text: string): SlackMarkdownBlock[] => [
  { type: 'markdown', text: truncateForMarkdownBlock(text) },
]

// Posts this Slack event's single response (a plain conversational reply, a
// delegation acknowledgement, or a resume outcome — all funnel through
// here), gated by event_log so a redelivered event can never double-post.
// Clears the assistant-status indicator once the post succeeds.
export const postFinalResponse = async (
  env: SlackEnvelope,
  text: string,
  resolved: ResolvedDispatcherDeps,
): Promise<PostFinalResponseResult> => {
  const { updated } = await resolved.eventLogStore.markResponded(env.eventId)
  if (updated === 0) {
    resolved.logger.info(
      {
        event: 'llm_agent_task_responded_already',
        slack_event_id: env.eventId,
      },
      'llm-agent skipping Slack post; event_log row already marked responded',
    )
    return { posted: false }
  }

  try {
    await resolved.slackClient.postMessage({
      channel: env.channelId,
      thread_ts: env.threadRootTs,
      text: escapeMrkdwn(text),
      blocks: buildBlocks(text),
    })
  } catch (error) {
    try {
      await resolved.eventLogStore.unmarkResponded(env.eventId)
    } catch (rollbackError) {
      resolved.logger.error(
        {
          event: 'llm_agent_response_unmark_failed',
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

  resolved.logger.info(
    {
      event: 'llm_agent_task_responded',
      slack_event_id: env.eventId,
    },
    'llm-agent posted response to Slack',
  )

  return { posted: true }
}
