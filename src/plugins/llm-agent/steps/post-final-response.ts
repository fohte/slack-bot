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

export interface SuppressFinalResponseResult {
  // False when event_log markResponded lost the race to another delivery of
  // the same Slack event; true otherwise. Either way nothing is posted to
  // Slack — this mirrors PostFinalResponseResult's race signal without a
  // Slack-post outcome to report.
  readonly responded: boolean
}

// Shared markResponded gate: true means this call is the one that marked the
// event (proceed), false means another delivery of the same Slack event
// already claimed it (no-op).
const markResponded = (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
): ResultAsync<boolean, unknown> =>
  resolved.eventLogStore.markResponded(env.eventId).map(({ updated }) => {
    if (updated === 0) {
      resolved.logger.info(
        {
          event: 'llm_agent_task_responded_already',
          slack_event_id: env.eventId,
        },
        'llm-agent skipping response handling; event_log row already marked responded',
      )
      return false
    }
    return true
  })

// Posts this Slack event's single response (a plain conversational reply, a
// delegation acknowledgement, or a resume outcome — all funnel through
// here), gated by event_log so a redelivered event can never double-post.
// Clears the assistant-status indicator once the post succeeds.
export const postFinalResponse = (
  env: SlackEnvelope,
  text: string,
  resolved: ResolvedDispatcherDeps,
): ResultAsync<PostFinalResponseResult, unknown> =>
  markResponded(env, resolved).andThen((responded) => {
    if (!responded) {
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

// Settles this Slack event's response without posting or touching the
// assistant-status indicator: used for a successful resume/redelegate, where
// the delegate task's own next heartbeat carries the status forward instead.
// Still gated by event_log so a redelivered event can't be processed twice.
export const suppressFinalResponse = (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
): ResultAsync<SuppressFinalResponseResult, unknown> =>
  markResponded(env, resolved).map((responded): SuppressFinalResponseResult => {
    if (responded) {
      resolved.logger.info(
        {
          event: 'llm_agent_task_responded_suppressed',
          slack_event_id: env.eventId,
        },
        'llm-agent settled this event without posting to Slack',
      )
    }
    return { responded }
  })
