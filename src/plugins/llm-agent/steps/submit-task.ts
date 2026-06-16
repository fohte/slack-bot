import type {
  ProcessMentionDeps,
  ResolvedDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { resolveDeps } from '@/plugins/llm-agent/process-mention-deps'
import type { TaskCrContext } from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'

const buildContexts = (
  env: SlackEnvelope,
  opencodeSessionId: string | undefined,
): TaskCrContext[] => {
  const contexts: TaskCrContext[] = [
    {
      name: 'slack-channel',
      mountPath: 'slack-context/channel',
      text: env.channelId,
    },
    {
      name: 'slack-thread-ts',
      mountPath: 'slack-context/thread-ts',
      text: env.threadRootTs,
    },
  ]
  if (opencodeSessionId !== undefined) {
    contexts.push({
      name: 'opencode-session-id',
      mountPath: 'slack-context/session-id',
      text: opencodeSessionId,
    })
  }
  return contexts
}

const lookupResumeSessionId = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
): Promise<string | undefined> => {
  // lookup failure falls through to undefined so the Task starts a fresh
  // opencode session instead of aborting dispatch.
  try {
    return await resolved.threadSessionStore.lookup({
      slackTeamId: env.teamId,
      slackChannelId: env.channelId,
      threadRootTs: env.threadRootTs,
    })
  } catch (error) {
    resolved.logger.error(
      {
        event: 'llm_agent_dispatch_thread_session_lookup_failed',
        event_id: env.eventId,
        err: error,
      },
      'failed to look up opencode session during dispatch; proceeding without resume',
    )
    return undefined
  }
}

export interface SubmitTaskResult {
  readonly taskName: string
}

// Synchronously create the Task CR for this Slack mention and record its
// name on the matching event_log row. Run from the dispatcher's
// foreground so a create() failure propagates up to the plugin layer for
// event_log rollback; everything after this step runs in the background.
export const submitTask = async (
  env: SlackEnvelope,
  deps: ProcessMentionDeps,
): Promise<SubmitTaskResult> => {
  const resolved = resolveDeps(deps)
  const taskName = taskCrNameForSlackEvent(env.eventId)
  const opencodeSessionId = await lookupResumeSessionId(resolved, env)
  const outcome = await resolved.taskCrClient.create({
    name: taskName,
    namespace: resolved.namespace,
    agentName: resolved.agentName,
    description: env.text,
    contexts: buildContexts(env, opencodeSessionId),
  })
  const { updated } = await resolved.eventLogStore.markTaskName(
    env.eventId,
    taskName,
  )
  if (updated === 0) {
    resolved.logger.warn(
      {
        event: 'llm_agent_event_log_task_name_orphan',
        event_id: env.eventId,
        task_name: taskName,
      },
      'event_log row missing when recording task_name',
    )
  }
  resolved.logger.info(
    {
      event: 'llm_agent_task_dispatched',
      event_id: env.eventId,
      task_name: taskName,
      namespace: resolved.namespace,
      outcome,
      session_resumed: opencodeSessionId !== undefined,
    },
    outcome === 'created'
      ? 'llm-agent dispatched Task CR'
      : 'llm-agent Task CR already existed; treated as accepted',
  )
  return { taskName }
}
