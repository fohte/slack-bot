import type { Part, Task, TextPart } from '@a2a-js/sdk'
import { z } from 'zod'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import {
  recordA2aPushNotification,
  recordA2aTaskSettled,
} from '@/observability/a2a-counters'
import type {
  A2aTaskRow,
  A2aTaskTerminalState,
  A2aTaskTracker,
} from '@/plugins/llm-agent/a2a-task-tracker'
import {
  isA2aTaskState,
  isA2aTaskTerminalState,
} from '@/plugins/llm-agent/a2a-task-tracker'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type {
  RemoteAgentHandle,
  RemoteAgentRegistry,
} from '@/plugins/llm-agent/remote-agent-registry'
import {
  buildMarkdownBlocks,
  escapeMrkdwn,
} from '@/plugins/llm-agent/slack-message-blocks'
import type { SlackWebClient } from '@/slack/web-client'

// Posted instead of the task's own message when the remote agent's failure
// carries metadata.error_kind === 'usage_limit', since the underlying LLM
// error text is not meant for end users.
export const USAGE_LIMIT_TEXT =
  "The delegated agent hit its LLM usage limit and couldn't finish this request. Please try again in a while."

const DEFAULT_TASK_TEXT_FALLBACK =
  '(the agent did not include a response message)'

// A row written by the delegation tool right after message/send can lag a
// very fast remote agent's first push by a brief window; this is how long
// to wait before treating the taskId as genuinely untracked.
const DEFAULT_UNKNOWN_TASK_RETRY_DELAY_MS = 2_000

export interface ResponseFinalizer {
  // Entry point for the push notification endpoint: only a taskId is known,
  // so this tolerates the a2a_task row not existing yet via one delayed
  // retry before giving up.
  finalize(taskId: string): Promise<void>
  // Entry point for a caller that already holds the row (e.g. the
  // reconciler's own findUnsettled() query); skips the lookup/retry above.
  finalizeRow(row: A2aTaskRow): Promise<void>
}

export interface ResponseFinalizerOptions {
  readonly a2aTaskTracker: A2aTaskTracker
  readonly remoteAgentRegistry: RemoteAgentRegistry
  readonly eventLogStore: EventLogStore
  readonly slackClient: SlackWebClient
  readonly unknownTaskRetryDelayMs?: number | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  readonly logger?: Logger | undefined
}

const isTextPart = (part: Part): part is TextPart => part.kind === 'text'

const collectPartsText = (parts: readonly Part[] | undefined): string =>
  (parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join('\n')
    .trim()

// Design contract: the settle/question text is built from the task's own
// Message, falling back to its Artifacts. Neither is ever expected to be
// truly empty in practice; the fallback string only guards against a
// misbehaving remote agent leaving Slack with a blank post.
const extractTaskText = (task: Task): string => {
  const messageText = collectPartsText(task.status.message?.parts)
  if (messageText.length > 0) return messageText
  const artifactsText = (task.artifacts ?? [])
    .map((artifact) => collectPartsText(artifact.parts))
    .filter((text) => text.length > 0)
    .join('\n')
  if (artifactsText.length > 0) return artifactsText
  return DEFAULT_TASK_TEXT_FALLBACK
}

const extractErrorKind = (task: Task): string | undefined => {
  const kind = task.status.message?.metadata?.['error_kind']
  return typeof kind === 'string' ? kind : undefined
}

// tasks/get's result is the remote agent's own response, not something this
// module's own request shaped, so its `status` is validated before treating
// the result as a Task; the rest of Task (artifacts, contextId, ...) is read
// defensively elsewhere (optional chaining / ?? fallbacks) and never assumed
// present here.
const TASK_SHAPE_SCHEMA = z
  .object({ status: z.object({ state: z.string() }).loose() })
  .loose()

export const createResponseFinalizer = (
  options: ResponseFinalizerOptions,
): ResponseFinalizer => {
  const logger = options.logger ?? noopLogger
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryDelayMs =
    options.unknownTaskRetryDelayMs ?? DEFAULT_UNKNOWN_TASK_RETRY_DELAY_MS

  const findHandle = async (
    agentName: string,
  ): Promise<RemoteAgentHandle | undefined> => {
    const handles = await options.remoteAgentRegistry.listAgents()
    return handles.find((handle) => handle.name === agentName)
  }

  const postToThread = async (
    row: A2aTaskRow,
    text: string,
  ): Promise<boolean> => {
    try {
      await options.slackClient.postMessage({
        channel: row.slackChannelId,
        thread_ts: row.threadRootTs,
        text: escapeMrkdwn(text),
        blocks: buildMarkdownBlocks(text),
      })
      return true
    } catch (error) {
      logger.error(
        {
          event: 'llm_agent_a2a_finalize_post_failed',
          task_id: row.taskId,
          agent_name: row.agentName,
          err: error,
        },
        'llm-agent failed to post a finalized A2A task result to Slack',
      )
      return false
    }
  }

  // Terminal settle: transition() eagerly flips `settled` before the post is
  // attempted so concurrent observers (a duplicate push, or the future
  // reconciler) elect a single winner; if the post itself then fails, the
  // optimistic settle is rolled back via unsettle() so a later attempt can
  // retry it.
  const settleTerminal = async (
    row: A2aTaskRow,
    task: Task,
    state: A2aTaskTerminalState,
  ): Promise<void> => {
    const { updated } = await options.a2aTaskTracker.transition(row.taskId, {
      state,
    })
    if (!updated) {
      recordA2aPushNotification('duplicate')
      return
    }

    const errorKind = extractErrorKind(task)
    const text =
      errorKind === 'usage_limit' ? USAGE_LIMIT_TEXT : extractTaskText(task)
    const posted = await postToThread(row, text)
    if (!posted) {
      try {
        await options.a2aTaskTracker.unsettle(row.taskId)
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_a2a_finalize_unsettle_failed',
            task_id: row.taskId,
            err: error,
          },
          'llm-agent failed to roll back the settled flag after a Slack post failure',
        )
      }
      recordA2aPushNotification('error')
      return
    }

    try {
      await options.eventLogStore.markResponded(row.slackEventId)
    } catch (error) {
      // Best-effort bookkeeping only: this flag records that *an* answer for
      // the originating Slack event has gone out, not whether *this* task's
      // post succeeded (already decided above), so a failure here never
      // rolls back the post that already happened.
      logger.warn(
        {
          event: 'llm_agent_a2a_finalize_mark_responded_failed',
          task_id: row.taskId,
          slack_event_id: row.slackEventId,
          err: error,
        },
        'llm-agent failed to mark event_log responded after posting a finalized A2A task result',
      )
    }

    recordA2aTaskSettled(row.agentName, state)
    recordA2aPushNotification('settled')
  }

  // input-required transitions are guarded by transitionGuard requiring the
  // row still be actively executing (see a2a-task-tracker.ts), since
  // input-required never sets `settled` and so can't rely on that flag
  // alone to elect a single winner and avoid reposting the same question.
  const settleInputRequired = async (
    row: A2aTaskRow,
    task: Task,
  ): Promise<void> => {
    const { updated } = await options.a2aTaskTracker.transition(row.taskId, {
      state: 'input-required',
    })
    if (!updated) {
      recordA2aPushNotification('duplicate')
      return
    }
    const posted = await postToThread(row, extractTaskText(task))
    if (!posted) {
      // Unlike settleTerminal, this row never set `settled`, so there is no
      // flag to unsettle; instead this reverts `state` back to what it was
      // before this transition, so a later attempt sees an active-execution
      // row again and transitionGuard permits it to re-enter input-required.
      // Without this, the row would be stuck at input-required with the
      // question never having reached Slack, and no future observation
      // could ever post it.
      try {
        await options.a2aTaskTracker.transition(row.taskId, {
          state: row.state,
          requireCurrentStates: ['input-required'],
        })
      } catch (error) {
        logger.error(
          {
            event: 'llm_agent_a2a_finalize_revert_failed',
            task_id: row.taskId,
            err: error,
          },
          'llm-agent failed to revert an input-required task after a Slack post failure',
        )
      }
      recordA2aPushNotification('error')
      return
    }
    recordA2aPushNotification('input_required')
  }

  const finalizeRow = async (row: A2aTaskRow): Promise<void> => {
    const handle = await findHandle(row.agentName)
    if (handle === undefined) {
      logger.warn(
        {
          event: 'llm_agent_a2a_finalize_agent_not_found',
          task_id: row.taskId,
          agent_name: row.agentName,
        },
        'llm-agent could not finalize a task: its remote agent is no longer registered',
      )
      recordA2aPushNotification('error')
      return
    }

    let rawTask: unknown
    try {
      rawTask = await handle.client.getTask({ id: row.taskId })
    } catch (error) {
      logger.warn(
        {
          event: 'llm_agent_a2a_finalize_get_task_failed',
          task_id: row.taskId,
          agent_name: row.agentName,
          err: error,
        },
        'llm-agent failed to fetch tasks/get while finalizing a task',
      )
      recordA2aPushNotification('error')
      return
    }

    if (!TASK_SHAPE_SCHEMA.safeParse(rawTask).success) {
      logger.warn(
        {
          event: 'llm_agent_a2a_finalize_invalid_task_payload',
          task_id: row.taskId,
          agent_name: row.agentName,
        },
        'llm-agent received a task payload without a usable status from tasks/get',
      )
      recordA2aPushNotification('error')
      return
    }
    // TASK_SHAPE_SCHEMA already validated every field this function reads
    // directly off `status`.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TASK_SHAPE_SCHEMA already validated every field this module reads directly
    const task = rawTask as Task

    if (!isA2aTaskState(task.status.state)) {
      logger.warn(
        {
          event: 'llm_agent_a2a_finalize_unrecognized_state',
          task_id: row.taskId,
          agent_name: row.agentName,
          task_state: task.status.state,
        },
        'llm-agent received an unrecognized task state while finalizing a task',
      )
      recordA2aPushNotification('error')
      return
    }

    const state = task.status.state
    if (state === 'input-required') {
      await settleInputRequired(row, task)
      return
    }
    if (isA2aTaskTerminalState(state)) {
      await settleTerminal(row, task, state)
      return
    }
    // submitted / working: a heartbeat observation, not a settle decision.
    // Refreshes updated_at so the (future) reconciler's stale-row sweep
    // doesn't treat a live, still-running task as overdue.
    await options.a2aTaskTracker.transition(row.taskId, { state })
    recordA2aPushNotification('heartbeat')
  }

  return {
    finalizeRow,
    async finalize(taskId) {
      let row = await options.a2aTaskTracker.findByTaskId(taskId)
      if (row === undefined) {
        await sleep(retryDelayMs)
        row = await options.a2aTaskTracker.findByTaskId(taskId)
      }
      if (row === undefined) {
        logger.warn(
          {
            event: 'llm_agent_a2a_finalize_unknown_task',
            task_id: taskId,
          },
          'llm-agent received a push notification for an untracked task; discarding',
        )
        recordA2aPushNotification('unknown_task')
        return
      }
      await finalizeRow(row)
    },
  }
}
