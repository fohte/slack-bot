import type { Message, MessageSendParams } from '@a2a-js/sdk'
import { TaskNotFoundError } from '@a2a-js/sdk/client'
import { ResultAsync } from 'neverthrow'

import type {
  A2aTaskLifecycle,
  A2aTaskRow,
} from '#plugins/llm-agent/a2a-task-tracker'
import { isA2aTaskState } from '#plugins/llm-agent/a2a-task-tracker'
import type {
  ResolvedDispatcherDeps,
  SlackEnvelope,
} from '#plugins/llm-agent/dispatcher-deps'
import type { RemoteAgentHandle } from '#plugins/llm-agent/remote-agent-registry/index'
import { SEND_MESSAGE_RESULT_SCHEMA } from '#plugins/llm-agent/remote-agent-registry/index'

// Posted directly to Slack (no LLM in the loop to paraphrase it), so this
// stays generic rather than leaking the underlying error — same rationale
// as steps/report-dispatch-failure.ts's DISPATCH_FAILURE_TEXT.
export const RESUME_SEND_FAILURE_TEXT =
  "I couldn't resume your previous request. Please try again."

// A successful resume/redelegate stays silent: the delegate task's own next
// heartbeat (task-progress-status.ts) will surface its live progress in the
// assistant-status indicator, so posting a fixed acknowledgement text here
// would only duplicate that. Failures still need to tell the user something
// went wrong, since there is no heartbeat to fall back on.
export type ResumeResult =
  | { readonly kind: 'suppressed' }
  | { readonly kind: 'failed'; readonly text: string }

// A2A servers built on `@a2a-js/sdk` (0.3.x) reject a message addressed to
// an already-terminal taskId with a plain JSON-RPC invalid-request error
// (there is no dedicated error code for it, unlike TaskNotFoundError's
// -32001 — see DefaultRequestHandler._createRequestContext), so detecting it
// falls back to matching the message text the SDK raises.
const isTerminalTaskRejection = (error: unknown): boolean =>
  error instanceof Error && /is in a terminal state/.test(error.message)

const isUnresumableTaskError = (error: unknown): boolean =>
  error instanceof TaskNotFoundError || isTerminalTaskRejection(error)

const findHandle = async (
  resolved: ResolvedDispatcherDeps,
  agentName: string,
): Promise<RemoteAgentHandle | undefined> => {
  const handles = await resolved.remoteAgentRegistry.listAgents()
  return handles.find((handle) => handle.name === agentName)
}

const buildParams = (
  resolved: ResolvedDispatcherDeps,
  env: SlackEnvelope,
  imageDescription: string | undefined,
  taskAndContext: { readonly taskId?: string; readonly contextId: string },
): MessageSendParams => {
  const message: Message = {
    kind: 'message',
    messageId: resolved.randomUUID(),
    role: 'user',
    contextId: taskAndContext.contextId,
    ...(taskAndContext.taskId !== undefined
      ? { taskId: taskAndContext.taskId }
      : {}),
    parts: [
      { kind: 'text', text: env.text },
      ...(imageDescription !== undefined
        ? [{ kind: 'text' as const, text: imageDescription }]
        : []),
    ],
  }
  return {
    message,
    configuration: {
      blocking: false,
      ...(resolved.pushNotificationConfig !== undefined
        ? { pushNotificationConfig: resolved.pushNotificationConfig }
        : {}),
    },
  }
}

// The A2A send this follows already succeeded (or the remote task is
// already known-unresumable), so a tracker failure or lost race here must
// never surface as a resume failure to the user — it only means slack-bot's
// own local bookkeeping for this task may be stale.
const transitionBestEffort = async (
  resolved: ResolvedDispatcherDeps,
  activeTask: A2aTaskRow,
  to: A2aTaskLifecycle,
  events: { readonly racedEvent: string; readonly failedEvent: string },
): Promise<void> => {
  const transitionResult = await resolved.a2aTaskTracker.transition(
    activeTask.taskId,
    to,
  )
  if (transitionResult.isErr()) {
    resolved.logger.warn(
      {
        event: events.failedEvent,
        agent_name: activeTask.agentName,
        task_id: activeTask.taskId,
        err: transitionResult.error,
      },
      'llm-agent failed to record a task transition locally; the underlying A2A operation still succeeded',
    )
    return
  }
  if (!transitionResult.value.updated) {
    resolved.logger.warn(
      {
        event: events.racedEvent,
        agent_name: activeTask.agentName,
        task_id: activeTask.taskId,
      },
      'llm-agent tracked row had already moved on before this transition could apply',
    )
  }
}

// Mirrors createDelegationTool's message/send + recordDelegated pairing.
const redelegate = async (
  env: SlackEnvelope,
  activeTask: A2aTaskRow,
  handle: RemoteAgentHandle,
  resolved: ResolvedDispatcherDeps,
  imageDescription: string | undefined,
): Promise<ResumeResult> => {
  const params = buildParams(resolved, env, imageDescription, {
    contextId: activeTask.contextId,
  })

  const sendResult = await ResultAsync.fromPromise(
    handle.client.sendMessage(params),
    (caughtErr) => caughtErr,
  )
  if (sendResult.isErr()) {
    resolved.logger.warn(
      {
        event: 'llm_agent_resume_redelegate_send_failed',
        agent_name: activeTask.agentName,
        context_id: activeTask.contextId,
        err: sendResult.error,
      },
      'llm-agent failed to redelegate a task whose previous instance was unresumable',
    )
    return { kind: 'failed', text: RESUME_SEND_FAILURE_TEXT }
  }

  const parsed = SEND_MESSAGE_RESULT_SCHEMA.safeParse(sendResult.value)
  if (
    !parsed.success ||
    parsed.data.kind !== 'task' ||
    !isA2aTaskState(parsed.data.status.state)
  ) {
    resolved.logger.warn(
      {
        event: 'llm_agent_resume_redelegate_malformed_result',
        agent_name: activeTask.agentName,
        context_id: activeTask.contextId,
      },
      'llm-agent received a malformed message/send result while redelegating',
    )
    return { kind: 'failed', text: RESUME_SEND_FAILURE_TEXT }
  }

  const taskId = parsed.data.id
  const state = parsed.data.status.state
  const recordResult = await resolved.a2aTaskTracker.recordDelegated({
    taskId,
    contextId: activeTask.contextId,
    agentName: activeTask.agentName,
    slackTeamId: env.teamId,
    slackChannelId: env.channelId,
    threadRootTs: env.threadRootTs,
    slackEventId: env.eventId,
    state,
    deadlineAt: new Date(resolved.now().getTime() + resolved.taskDeadlineMs),
  })
  if (recordResult.isErr()) {
    // Unlike transitionBestEffort's failures, there is no tracked row for
    // taskId at all here, so no future push/heartbeat/reconciler pass can
    // ever clear the assistant-status indicator or notify the user — this
    // must surface now rather than be treated as a silent success.
    resolved.logger.warn(
      {
        event: 'llm_agent_resume_redelegate_record_failed',
        agent_name: activeTask.agentName,
        task_id: taskId,
        err: recordResult.error,
      },
      'llm-agent redelegated a task but failed to record it locally',
    )
    return { kind: 'failed', text: RESUME_SEND_FAILURE_TEXT }
  }

  return { kind: 'suppressed' }
}

// The remote task is gone or already terminal: this exact taskId can never
// be resumed, so the row is settled and a fresh task is started under the
// same contextId instead.
const settleAndRedelegate = async (
  env: SlackEnvelope,
  activeTask: A2aTaskRow,
  handle: RemoteAgentHandle,
  resolved: ResolvedDispatcherDeps,
  imageDescription: string | undefined,
  originalError: unknown,
): Promise<ResumeResult> => {
  resolved.logger.info(
    {
      event: 'llm_agent_resume_task_unresumable',
      agent_name: activeTask.agentName,
      task_id: activeTask.taskId,
      err: originalError,
    },
    'resumed task is gone or already terminal on the remote side; redelegating as a new task',
  )
  await transitionBestEffort(
    resolved,
    activeTask,
    { state: 'failed', requireCurrentStates: ['input-required'] },
    {
      racedEvent: 'llm_agent_resume_settle_raced',
      failedEvent: 'llm_agent_resume_settle_failed',
    },
  )
  return redelegate(env, activeTask, handle, resolved, imageDescription)
}

export const resumeActiveTask = async (
  env: SlackEnvelope,
  activeTask: A2aTaskRow,
  resolved: ResolvedDispatcherDeps,
  imageDescription: string | undefined,
): Promise<ResumeResult> => {
  const handle = await findHandle(resolved, activeTask.agentName)
  if (handle === undefined) {
    resolved.logger.warn(
      {
        event: 'llm_agent_resume_agent_not_found',
        agent_name: activeTask.agentName,
        task_id: activeTask.taskId,
      },
      'llm-agent could not resume a task: its remote agent is no longer registered',
    )
    return { kind: 'failed', text: RESUME_SEND_FAILURE_TEXT }
  }

  const params = buildParams(resolved, env, imageDescription, {
    taskId: activeTask.taskId,
    contextId: activeTask.contextId,
  })

  const sendResult = await ResultAsync.fromPromise(
    handle.client.sendMessage(params),
    (caughtErr) => caughtErr,
  )
  if (sendResult.isErr()) {
    const error = sendResult.error
    if (isUnresumableTaskError(error)) {
      return settleAndRedelegate(
        env,
        activeTask,
        handle,
        resolved,
        imageDescription,
        error,
      )
    }
    resolved.logger.warn(
      {
        event: 'llm_agent_resume_send_failed',
        agent_name: activeTask.agentName,
        task_id: activeTask.taskId,
        err: error,
      },
      'llm-agent failed to resume a task',
    )
    return { kind: 'failed', text: RESUME_SEND_FAILURE_TEXT }
  }

  const parsed = SEND_MESSAGE_RESULT_SCHEMA.safeParse(sendResult.value)
  if (
    !parsed.success ||
    parsed.data.kind !== 'task' ||
    !isA2aTaskState(parsed.data.status.state)
  ) {
    resolved.logger.warn(
      {
        event: 'llm_agent_resume_malformed_result',
        agent_name: activeTask.agentName,
        task_id: activeTask.taskId,
      },
      'llm-agent received a malformed message/send result while resuming a task',
    )
    return { kind: 'failed', text: RESUME_SEND_FAILURE_TEXT }
  }

  await transitionBestEffort(
    resolved,
    activeTask,
    {
      state: parsed.data.status.state,
      deadlineAt: new Date(resolved.now().getTime() + resolved.taskDeadlineMs),
      requireCurrentStates: ['input-required'],
    },
    {
      racedEvent: 'llm_agent_resume_transition_raced',
      failedEvent: 'llm_agent_resume_transition_failed',
    },
  )

  return { kind: 'suppressed' }
}
