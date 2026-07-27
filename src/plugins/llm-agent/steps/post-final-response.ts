import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import {
  CLEAR_STATUS,
  trySetAssistantStatus,
} from '#plugins/llm-agent/assistant-status'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '#plugins/llm-agent/dispatcher-deps'
import { postThreadMessage } from '#plugins/llm-agent/slack-message-blocks'

export interface PostFinalResponseResult {
  // False when event_log markResponded lost the race to another delivery of
  // the same Slack event, in which case this is a no-op — callers that
  // count actual Slack posts must check this rather than assume the call
  // resolving means a message went out.
  readonly posted: boolean
}

// Posts this Slack event's single response (a plain conversational reply, a
// delegation acknowledgement, or a resume outcome — all funnel through
// here), gated by event_log so a redelivered event can never double-post.
// Clears the assistant-status indicator once the post succeeds.
export const postFinalResponse = (
  env: SlackEnvelope,
  text: string,
  resolved: ResolvedDispatcherDeps,
): ResultAsync<PostFinalResponseResult, unknown> =>
  resolved.eventLogStore.markResponded(env.eventId).andThen(({ updated }) => {
    if (updated === 0) {
      resolved.logger.info(
        {
          event: 'llm_agent_task_responded_already',
          slack_event_id: env.eventId,
        },
        'llm-agent skipping Slack post; event_log row already marked responded',
      )
      return okAsync<PostFinalResponseResult, unknown>({ posted: false })
    }

    return ResultAsync.fromPromise(
      postThreadMessage(
        resolved.slackClient,
        { channel: env.channelId, threadTs: env.threadRootTs },
        text,
      ),
      (caughtErr) => caughtErr,
    )
      .andThen(() =>
        ResultAsync.fromSafePromise(
          trySetAssistantStatus({
            slackClient: resolved.slackClient,
            target: { channelId: env.channelId, threadTs: env.threadRootTs },
            status: CLEAR_STATUS,
            logger: resolved.logger,
          }),
        ),
      )
      .map((): PostFinalResponseResult => {
        resolved.logger.info(
          {
            event: 'llm_agent_task_responded',
            slack_event_id: env.eventId,
          },
          'llm-agent posted response to Slack',
        )
        return { posted: true }
      })
      .orElse((postErr) =>
        ResultAsync.fromSafePromise(
          resolved.eventLogStore.unmarkResponded(env.eventId).match(
            () => undefined,
            (unmarkErr) => {
              resolved.logger.error(
                {
                  event: 'llm_agent_response_unmark_failed',
                  slack_event_id: env.eventId,
                  err: unmarkErr,
                },
                'failed to roll back event_log row after Slack post failure',
              )
            },
          ),
        ).andThen(() => errAsync(postErr)),
      )
  })
