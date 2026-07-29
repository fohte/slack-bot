import type { Task } from '@a2a-js/sdk'

import type { Logger } from '#logger/logger'
import { noopLogger } from '#logger/logger'
import type { A2aTaskRow } from '#plugins/llm-agent/a2a-task-tracker'
import {
  CLEAR_STATUS,
  DEFAULT_THINKING_STATUS,
  trySetAssistantStatus,
} from '#plugins/llm-agent/assistant-status'
import { collectPartsText } from '#plugins/llm-agent/remote-agent-registry/a2a-message-parts'
import type { SlackWebClient } from '#slack/web-client'

export interface TaskProgressStatus {
  // Reflects a submitted/working task's current status.message into the
  // assistant status indicator. A no-op when the task carries no message yet
  // (the remote agent hasn't started a tool call), or when the text is
  // unchanged since the last call for this taskId.
  report(row: A2aTaskRow, task: Task): Promise<void>
  // Clears the indicator and forgets any cached text for this taskId. Called
  // from every path that settles a row (terminal, input-required, or a
  // reconciler-forced failure), so a stale "thinking..." indicator never
  // lingers regardless of which termination path a task takes, and the
  // dedup cache below doesn't grow unbounded over the process lifetime.
  clear(row: A2aTaskRow): Promise<void>
}

export interface TaskProgressStatusOptions {
  readonly slackClient: SlackWebClient
  readonly logger?: Logger | undefined
}

// Used as the default for callers that don't care about this display-only
// feature (e.g. tests focused on other concerns), so they aren't forced to
// construct a real TaskProgressStatus.
export const NOOP_TASK_PROGRESS_STATUS: TaskProgressStatus = {
  async report() {},
  async clear() {},
}

// Unlike response-finalizer's extractTaskText, this never falls back to
// artifacts or a placeholder string: a settle/question text with no message
// is a real (if unlikely) case worth a fallback, but a progress indicator
// with no message yet simply has nothing new to show.
const extractProgressText = (task: Task): string | undefined => {
  const text = collectPartsText(task.status.message?.parts)
  return text.length > 0 ? text : undefined
}

export const createTaskProgressStatus = (
  options: TaskProgressStatusOptions,
): TaskProgressStatus => {
  const logger = options.logger ?? noopLogger
  const lastReportedText = new Map<string, string>()

  return {
    async report(row, task) {
      const text = extractProgressText(task)
      if (text === undefined || lastReportedText.get(row.taskId) === text) {
        return
      }
      // Cached only on success: a failed call never reached Slack, so
      // caching the text here would suppress every retry of it until the
      // progress text happens to change.
      const succeeded = await trySetAssistantStatus({
        slackClient: options.slackClient,
        target: { channelId: row.slackChannelId, threadTs: row.threadRootTs },
        status: DEFAULT_THINKING_STATUS,
        loadingMessages: [text],
        logger,
      })
      if (succeeded) lastReportedText.set(row.taskId, text)
    },
    async clear(row) {
      lastReportedText.delete(row.taskId)
      await trySetAssistantStatus({
        slackClient: options.slackClient,
        target: { channelId: row.slackChannelId, threadTs: row.threadRootTs },
        status: CLEAR_STATUS,
        logger,
      })
    },
  }
}
