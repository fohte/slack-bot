import {
  CLEAR_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/dispatcher-deps'

// Shown for a dispatch-level failure (the gating step throwing, or the
// detached background mention-processing chain crashing unexpectedly)
// rather than a foreseen A2A outcome, so it must stay generic: internal
// error details must never reach Slack.
export const DISPATCH_FAILURE_TEXT =
  'Something went wrong before this request could be completed. Please try again.'

// Best-effort Slack notification for a dispatch-level failure: post a
// generic failure message and clear the "thinking..." indicator so it
// doesn't sit stuck in the thread forever. Never throws — both Slack
// calls swallow their own errors, since callers reach this from a
// failure path with nothing further to roll back to. The two calls are
// independent, so serializing them would only add needless latency.
export const reportDispatchFailure = async (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
): Promise<void> => {
  const postPromise = resolved.slackClient
    .postMessage({
      channel: env.channelId,
      thread_ts: env.threadRootTs,
      text: DISPATCH_FAILURE_TEXT,
    })
    .catch((postError: unknown) => {
      resolved.logger.error(
        {
          event: 'llm_agent_dispatch_failure_notify_failed',
          event_id: env.eventId,
          err: postError,
        },
        'failed to notify Slack thread about a dispatch failure',
      )
    })
  const statusPromise = trySetAssistantStatus({
    slackClient: resolved.slackClient,
    target: { channelId: env.channelId, threadTs: env.threadRootTs },
    status: CLEAR_STATUS,
    logger: resolved.logger,
  })
  await Promise.all([postPromise, statusPromise])
}
