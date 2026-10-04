import { SpanStatusCode, trace } from '@opentelemetry/api'
import type { ResultAsync } from 'neverthrow'

import type { Logger } from '#logger/logger'
import { noopLogger } from '#logger/logger'
import type { A2aTaskRow, ThreadKey } from '#plugins/llm-agent/a2a-task-tracker'
import {
  INITIAL_PHASE_STATUS,
  trySetAssistantStatus,
} from '#plugins/llm-agent/assistant-status'
import type { ThreadContextForTurn } from '#plugins/llm-agent/conversation-agent/index'
import {
  deriveConversationThreadId,
  describeImages,
} from '#plugins/llm-agent/conversation-agent/index'
import type {
  DispatcherDeps,
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '#plugins/llm-agent/dispatcher-deps'
import { resolveDeps } from '#plugins/llm-agent/dispatcher-deps'
import { envelopeFromAccepted } from '#plugins/llm-agent/dispatcher-envelope'
import { resolveInlineImageFiles } from '#plugins/llm-agent/dispatcher-inline-images'
import type { InFlightTurnRegistry } from '#plugins/llm-agent/in-flight-turns'
import { createInFlightTurnRegistry } from '#plugins/llm-agent/in-flight-turns'
import type { LlmAgentAcceptedEvent } from '#plugins/llm-agent/plugin'
import {
  postFinalResponse,
  suppressFinalResponse,
} from '#plugins/llm-agent/steps/post-final-response'
import { reportDispatchFailure } from '#plugins/llm-agent/steps/report-dispatch-failure'
import { resolveImageBlocks } from '#plugins/llm-agent/steps/resolve-image-blocks'
import { resumeActiveTask } from '#plugins/llm-agent/steps/resume-active-task'
import {
  EMPTY_THREAD_CONTEXT,
  syncThreadContext,
} from '#plugins/llm-agent/steps/sync-thread-context'
import type { ThreadTurnQueue } from '#plugins/llm-agent/thread-turn-queue'
import { createThreadTurnQueue } from '#plugins/llm-agent/thread-turn-queue'
import type { InFlightTasks } from '#server/in-flight-tasks'
import type { ImageAnalysisError } from '#types/errors'

const TRACER_NAME = 'slack-bot'
const DISPATCH_SPAN_NAME = 'slack.mention.handle'

type TaskDispatcher = (accepted: LlmAgentAcceptedEvent) => Promise<void>

export type TaskDispatcherOptions = DispatcherDeps & {
  // Registers the backgrounded mention-processing call so a graceful-
  // shutdown handler can wait for it to finish before the process exits.
  // Omitting it leaves the call as untracked fire-and-forget.
  readonly inFlightTasks?: Pick<InFlightTasks, 'track'> | undefined
}

const threadKeyFor = (env: SlackEnvelope): ThreadKey => ({
  slackTeamId: env.teamId,
  slackChannelId: env.channelId,
  threadRootTs: env.threadRootTs,
})

// A getThreadCursor failure means the checkpoint state (and therefore the
// safe fetch range) is unknown, so the sync is skipped entirely rather than
// guessed at — same "context degradation over reply failure" tradeoff as a
// conversations.replies failure inside syncThreadContext itself.
const resolveThreadContextForTurn = async (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
  threadId: string,
  inFlightTurns: InFlightTurnRegistry,
): Promise<ThreadContextForTurn> => {
  const cursorResult =
    await resolved.conversationAgent.getThreadCursor(threadId)
  if (cursorResult.isErr()) {
    resolved.logger.warn(
      {
        event: 'llm_agent_thread_context_cursor_failed',
        event_id: env.eventId,
        err: cursorResult.error,
      },
      'failed to resolve thread context cursor; continuing without injection',
    )
    return EMPTY_THREAD_CONTEXT
  }
  return syncThreadContext(resolved, env, cursorResult.value, (key) =>
    inFlightTurns.has(key),
  )
}

interface ConversationTurnResult {
  readonly text: string
  // True when conversationAgent.respond() delegated during this turn, per
  // ConversationOutcome.delegations.
  readonly delegated: boolean
}

const respondWithConversationAgent = async (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
  imageDescriptionResult: ResultAsync<string | undefined, ImageAnalysisError>,
  inFlightTurns: InFlightTurnRegistry,
): Promise<ConversationTurnResult> => {
  const threadId = deriveConversationThreadId({
    teamId: env.teamId,
    channelId: env.channelId,
    threadRootTs: env.threadRootTs,
  })
  // Independent of each other — this turn's own images and thread-context
  // images are described by separate describeImages calls — so run
  // concurrently rather than paying two sequential vision-model round trips.
  const [descriptionResult, threadContext] = await Promise.all([
    imageDescriptionResult,
    resolveThreadContextForTurn(env, resolved, threadId, inFlightTurns),
  ])
  // eslint-disable-next-line no-restricted-syntax -- boundary: converts the Result into a throw for runMentionInBackground's catch below to handle uniformly
  if (descriptionResult.isErr()) throw descriptionResult.error
  const outcomeResult = await resolved.conversationAgent.respond({
    threadId,
    userText: env.text,
    imageDescription: descriptionResult.value,
    slackEventId: env.eventId,
    triggerTs: env.triggerTs,
    threadContext,
  })
  // eslint-disable-next-line no-restricted-syntax -- boundary: converts the Result into a throw for runMentionInBackground's catch below to handle uniformly
  if (outcomeResult.isErr()) throw outcomeResult.error
  const trimmed = outcomeResult.value.text.trim()
  return {
    text:
      trimmed.length > 0
        ? outcomeResult.value.text
        : resolved.successFallbackText,
    delegated: outcomeResult.value.delegations.length > 0,
  }
}

// A successful resume/redelegate is settled silently (suppressFinalResponse);
// only a failed one still needs to post RESUME_SEND_FAILURE_TEXT through the
// normal postFinalResponse path.
const finalizeResumeTurn = async (
  env: SlackEnvelope,
  activeTask: A2aTaskRow,
  resolved: ResolvedDispatcherDeps,
  imageDescriptionResult: ResultAsync<string | undefined, ImageAnalysisError>,
) => {
  const descriptionResult = await imageDescriptionResult
  // eslint-disable-next-line no-restricted-syntax -- boundary: converts the Result into a throw for runMentionInBackground's catch below to handle uniformly
  if (descriptionResult.isErr()) throw descriptionResult.error
  const resumeResult = await resumeActiveTask(
    env,
    activeTask,
    resolved,
    descriptionResult.value,
  )
  return resumeResult.kind === 'suppressed'
    ? await suppressFinalResponse(env, resolved)
    : await postFinalResponse(env, resumeResult.text, resolved)
}

// A turn that delegated is settled silently (suppressFinalResponse), mirroring
// finalizeResumeTurn: the delegate task's own next heartbeat
// (task-progress-status.ts) will surface its live progress in the
// assistant-status indicator, so posting the LLM's hand-off acknowledgement
// text here would only get the indicator cleared right behind it. A turn
// with no delegation posts its reply and clears the status as before.
const finalizeNewTurn = async (
  env: SlackEnvelope,
  resolved: ResolvedDispatcherDeps,
  imageDescriptionResult: ResultAsync<string | undefined, ImageAnalysisError>,
  inFlightTurns: InFlightTurnRegistry,
  threadTurnQueue: ThreadTurnQueue,
) => {
  const threadId = deriveConversationThreadId({
    teamId: env.teamId,
    channelId: env.channelId,
    threadRootTs: env.threadRootTs,
  })
  const result = await threadTurnQueue.run(threadId, () =>
    respondWithConversationAgent(
      env,
      resolved,
      imageDescriptionResult,
      inFlightTurns,
    ),
  )
  return result.delegated
    ? await suppressFinalResponse(env, resolved)
    : await postFinalResponse(env, result.text, resolved)
}

// Runs the (potentially slow) LLM/A2A work detached from the Slack HTTP
// handler: whichever branch runs, it always ends by settling this event's
// single response, though a successful resume/redelegate or a turn that
// delegated settles silently rather than posting one. Any unexpected failure
// falls back to a generic, ungated dispatch-failure notification. The
// try/catch here is deliberately broad: it is the last line of defense
// against a genuine bug (an actual throw, not just a Result error) in any of
// the steps below, since a task that silently hangs never gets a reply.
const runMentionInBackground = async (
  env: SlackEnvelope,
  activeTask: A2aTaskRow | undefined,
  resolved: ResolvedDispatcherDeps,
  logger: Logger,
  inFlightTurns: InFlightTurnRegistry,
  threadTurnQueue: ThreadTurnQueue,
): Promise<void> => {
  // Marked in flight only from here, not from dispatch entry: a concurrent
  // turn's sync-thread-context call issued while this one is still resolving
  // inline images / setting the status indicator / checking for an active
  // task won't see this key as in flight yet, and may inject this message's
  // content. threadTurnQueue below still guarantees this turn's own
  // checkpoint write survives, so the worst case is that duplicate
  // injection, which the design already accepts as non-fatal.
  const turnKey = { channelId: env.channelId, ts: env.triggerTs }
  inFlightTurns.start(turnKey)
  // eslint-disable-next-line no-restricted-syntax -- boundary: fire-and-forget background execution; catches both Result errors (converted to throws below) and genuinely unexpected throws from any step, per the doc comment above
  try {
    const imagesResult = await resolveImageBlocks(resolved, env)
    // eslint-disable-next-line no-restricted-syntax -- boundary: converts the Result into a throw for the catch above to handle uniformly
    if (imagesResult.isErr()) throw imagesResult.error
    // Converted to text once here via a vision-specialized model, so neither
    // the conversation agent's own model nor any delegate agent ever reads
    // raw image bytes directly (see conversation-agent/image-analysis.ts).
    // Not awaited yet: neither downstream branch has anything else to do
    // before it needs this, and respondWithConversationAgent below runs it
    // concurrently with its own (independent) thread-context vision call.
    const imageDescriptionResult = describeImages(
      resolved.imageAnalysisModel,
      imagesResult.value,
    )
    const postResult =
      activeTask !== undefined
        ? await finalizeResumeTurn(
            env,
            activeTask,
            resolved,
            imageDescriptionResult,
          )
        : await finalizeNewTurn(
            env,
            resolved,
            imageDescriptionResult,
            inFlightTurns,
            threadTurnQueue,
          )
    // eslint-disable-next-line no-restricted-syntax -- boundary: converts the Result into a throw for the catch above to handle uniformly
    if (postResult.isErr()) throw postResult.error
  } catch (error) {
    logger.error(
      {
        event: 'llm_agent_process_mention_failed',
        event_id: env.eventId,
        err: error,
      },
      'llm-agent mention processing failed',
    )
    await reportDispatchFailure(env, resolved, error)
  } finally {
    inFlightTurns.finish(turnKey)
  }
}

export const createTaskDispatcher = (
  options: TaskDispatcherOptions,
): TaskDispatcher => {
  const logger = options.logger ?? noopLogger
  const tracer = trace.getTracer(TRACER_NAME)
  const resolved = resolveDeps(options)
  const inFlightTurns = createInFlightTurnRegistry()
  const threadTurnQueue = createThreadTurnQueue()
  return async (accepted) => {
    const baseEnv = envelopeFromAccepted(accepted, logger)
    if (baseEnv === undefined) return
    const env = await resolveInlineImageFiles(
      baseEnv,
      resolved.slackClient,
      logger,
    )
    // eslint-disable-next-line no-restricted-syntax -- span is only used and ended inside the callback below, so it never outlives its own active context
    await tracer.startActiveSpan(
      DISPATCH_SPAN_NAME,
      {
        attributes: {
          'slack.channel': env.channelId,
          'slack.thread_ts': env.threadRootTs,
          'slack.event_id': env.eventId,
        },
      },
      async (span) => {
        // eslint-disable-next-line no-restricted-syntax -- boundary: OTel span instrumentation, finally guarantees span.end() runs even when the block below throws
        try {
          // Set the indicator before the gating lookup so a fast-completing
          // background run can never have its terminal status clear race
          // ahead of our set and leave a stale indicator sitting in the
          // thread.
          await trySetAssistantStatus({
            slackClient: resolved.slackClient,
            target: { channelId: env.channelId, threadTs: env.threadRootTs },
            status: INITIAL_PHASE_STATUS.status,
            loadingMessages: INITIAL_PHASE_STATUS.loadingMessages,
            logger,
          })
          // A failure here must reach onAccepted for the event_log
          // rollback; the actual LLM/A2A work runs detached so the Slack
          // HTTP handler can ack quickly.
          const activeTaskResult =
            await resolved.a2aTaskTracker.findActiveInputRequired(
              threadKeyFor(env),
            )
          // eslint-disable-next-line no-restricted-syntax -- boundary: converts the Result into a throw for the catch below to handle uniformly
          if (activeTaskResult.isErr()) throw activeTaskResult.error
          const activeTask = activeTaskResult.value
          const mentionCompletion = runMentionInBackground(
            env,
            activeTask,
            resolved,
            logger,
            inFlightTurns,
            threadTurnQueue,
          )
          void options.inFlightTasks?.track(mentionCompletion)
        } catch (err) {
          span.recordException(
            err instanceof Error ? err : { message: String(err) },
          )
          span.setStatus({ code: SpanStatusCode.ERROR })
          logger.error(
            {
              event: 'llm_agent_dispatch_failed',
              event_id: env.eventId,
              err,
            },
            'llm-agent dispatch failed before background processing started',
          )
          await reportDispatchFailure(env, resolved, err)
          // eslint-disable-next-line no-restricted-syntax -- boundary: re-throws after span/log bookkeeping so tracer.startActiveSpan still marks the span as failed
          throw err
        } finally {
          span.end()
        }
      },
    )
  }
}
