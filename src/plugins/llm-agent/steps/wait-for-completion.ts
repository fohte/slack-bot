import type { PhaseStatus } from '@/plugins/llm-agent/assistant-status'
import {
  INITIAL_PHASE_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type {
  ProcessMentionDeps,
  ResolvedDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { resolveDeps } from '@/plugins/llm-agent/process-mention-deps'
import type { TaskCrStatus } from '@/plugins/llm-agent/task-cr-client'

export const PREPARING_BUBBLE: PhaseStatus = INITIAL_PHASE_STATUS
export const QUEUED_BUBBLE: PhaseStatus = {
  status: 'is waiting in queue...',
  loadingMessages: ['Waiting in queue…'],
}
export const RUNNING_BUBBLE: PhaseStatus = {
  status: 'is working on it...',
  loadingMessages: ['Working on it…'],
}

export const bubbleForK8sPhase = (
  phase: string | undefined,
): PhaseStatus | undefined => {
  switch (phase) {
    case 'Pending':
      return PREPARING_BUBBLE
    case 'Queued':
      return QUEUED_BUBBLE
    case 'Running':
      return RUNNING_BUBBLE
    default:
      return undefined
  }
}

export type TerminalOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly message: string | undefined }

export interface WaitForCompletionOptions {
  // Bubble already shown for this Slack thread (typically the Preparing
  // bubble set by the dispatcher before submitTask). Suppresses a
  // redundant Slack call if the first observed phase maps to the same
  // bubble.
  readonly initialBubble?: PhaseStatus | undefined
}

const updateBubble = (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
  bubble: PhaseStatus,
): Promise<void> =>
  trySetAssistantStatus({
    slackClient: resolved.slackClient,
    target: { channelId: env.channelId, threadTs: env.threadRootTs },
    status: bubble.status,
    loadingMessages: bubble.loadingMessages,
    logger: resolved.logger,
  })

// Poll the Task CR until it reaches a terminal phase (Completed/Failed),
// updating the Slack assistant-status bubble whenever the displayed
// bubble would change. Throws if the CR disappears mid-poll so the
// background runner does not loop forever against a missing object.
export const waitForCompletion = async (
  env: SlackEnvelope,
  taskName: string,
  deps: ProcessMentionDeps,
  options: WaitForCompletionOptions = {},
): Promise<TerminalOutcome> => {
  const resolved = resolveDeps(deps)
  let lastShownStatus: string | undefined = options.initialBubble?.status
  for (;;) {
    let tasks: readonly TaskCrStatus[]
    try {
      tasks = await resolved.taskCrClient.list(resolved.namespace)
    } catch (error) {
      resolved.logger.error(
        {
          event: 'llm_agent_task_poll_list_failed',
          namespace: resolved.namespace,
          task_name: taskName,
          err: error,
        },
        'failed to list Task CRs while polling for phase change',
      )
      await resolved.sleep(resolved.pollIntervalMs)
      continue
    }
    const match = tasks.find((t) => t.name === taskName)
    if (match === undefined) {
      // A list() succeeded but no CR with this name exists. The only
      // path that produces this state in normal operation is an
      // operator deleting the CR; staying in the loop would poll the
      // API server forever. Throwing surfaces the leak to the
      // dispatcher's catch.
      throw new Error(
        `Task CR ${taskName} not found in namespace ${resolved.namespace}`,
      )
    }
    if (match.phase === 'Completed') return { kind: 'completed' }
    if (match.phase === 'Failed') {
      return { kind: 'failed', message: match.message }
    }
    const bubble = bubbleForK8sPhase(match.phase)
    if (bubble !== undefined && bubble.status !== lastShownStatus) {
      await updateBubble(resolved, env, bubble)
      lastShownStatus = bubble.status
    }
    await resolved.sleep(resolved.pollIntervalMs)
  }
}
