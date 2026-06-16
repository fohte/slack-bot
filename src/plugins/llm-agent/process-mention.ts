import { slackifyMarkdown } from 'slackify-markdown'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { PhaseStatus } from '@/plugins/llm-agent/assistant-status'
import {
  CLEAR_STATUS,
  INITIAL_PHASE_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type {
  TaskCrClient,
  TaskCrContext,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'

export const DEFAULT_TASK_CR_NAMESPACE = 'kubeopencode'
export const DEFAULT_TASK_CR_AGENT_NAME = 'slack-bot'
export const DEFAULT_POLL_INTERVAL_MS = 5000
export const DEFAULT_SUCCESS_FALLBACK =
  '(opencode did not produce an assistant message)'

export interface SlackEnvelope {
  readonly eventId: string
  readonly teamId: string
  readonly channelId: string
  readonly threadRootTs: string
  readonly text: string
}

export type Phase =
  | { readonly kind: 'Received'; readonly env: SlackEnvelope }
  | {
      readonly kind: 'Submitted'
      readonly env: SlackEnvelope
      readonly taskName: string
    }
  | {
      readonly kind: 'Queued'
      readonly env: SlackEnvelope
      readonly taskName: string
    }
  | {
      readonly kind: 'Running'
      readonly env: SlackEnvelope
      readonly taskName: string
    }
  | {
      readonly kind: 'Completed'
      readonly env: SlackEnvelope
      readonly taskName: string
    }
  | {
      readonly kind: 'Failed'
      readonly env: SlackEnvelope
      readonly taskName: string
      readonly message: string | undefined
    }

const PREPARING_BUBBLE: PhaseStatus = INITIAL_PHASE_STATUS
const QUEUED_BUBBLE: PhaseStatus = {
  status: 'is waiting in queue...',
  loadingMessages: ['Waiting in queue…'],
}
const RUNNING_BUBBLE: PhaseStatus = {
  status: 'is working on it...',
  loadingMessages: ['Working on it…'],
}

export const bubbleFor = (phase: Phase): PhaseStatus | undefined => {
  switch (phase.kind) {
    case 'Received':
    case 'Submitted':
      return PREPARING_BUBBLE
    case 'Queued':
      return QUEUED_BUBBLE
    case 'Running':
      return RUNNING_BUBBLE
    case 'Completed':
    case 'Failed':
      return undefined
    default: {
      const exhaustive: never = phase
      return exhaustive
    }
  }
}

export interface ProcessMentionDeps {
  readonly taskCrClient: TaskCrClient
  readonly opencodeClient: OpencodeClient
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
  readonly slackClient: SlackWebClient
  readonly namespace?: string | undefined
  readonly agentName?: string | undefined
  readonly successFallbackText?: string | undefined
  readonly pollIntervalMs?: number | undefined
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  readonly logger?: Logger | undefined
}

interface ResolvedDeps {
  readonly taskCrClient: TaskCrClient
  readonly opencodeClient: OpencodeClient
  readonly eventLogStore: EventLogStore
  readonly threadSessionStore: ThreadSessionStore
  readonly slackClient: SlackWebClient
  readonly namespace: string
  readonly agentName: string
  readonly successFallbackText: string
  readonly pollIntervalMs: number
  readonly sleep: (ms: number) => Promise<void>
  readonly logger: Logger
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const resolve = (deps: ProcessMentionDeps): ResolvedDeps => ({
  taskCrClient: deps.taskCrClient,
  opencodeClient: deps.opencodeClient,
  eventLogStore: deps.eventLogStore,
  threadSessionStore: deps.threadSessionStore,
  slackClient: deps.slackClient,
  namespace: deps.namespace ?? DEFAULT_TASK_CR_NAMESPACE,
  agentName: deps.agentName ?? DEFAULT_TASK_CR_AGENT_NAME,
  successFallbackText: deps.successFallbackText ?? DEFAULT_SUCCESS_FALLBACK,
  pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  sleep: deps.sleep ?? defaultSleep,
  logger: deps.logger ?? noopLogger,
})

// Slack mrkdwn would otherwise interpret <, >, & inside the unstructured
// k8s status message as user/channel mentions or HTML entities.
// https://docs.slack.dev/messaging/formatting-message-text#escaping
const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatFailureText = (message: string | undefined): string => {
  const trimmed = message?.trim()
  if (trimmed !== undefined && trimmed.length > 0) {
    return `Task failed: ${escapeMrkdwn(trimmed)}`
  }
  return 'Task failed.'
}

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

const k8sPhaseFor = (kind: 'Submitted' | 'Queued' | 'Running'): string => {
  switch (kind) {
    case 'Submitted':
      return 'Pending'
    case 'Queued':
      return 'Queued'
    case 'Running':
      return 'Running'
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

const KNOWN_K8S_PHASES: ReadonlySet<string> = new Set([
  'Pending',
  'Queued',
  'Running',
  'Completed',
  'Failed',
])

const mapStatusToPhase = (
  env: SlackEnvelope,
  taskName: string,
  status: TaskCrStatus,
): Phase | undefined => {
  switch (status.phase) {
    case 'Pending':
      return { kind: 'Submitted', env, taskName }
    case 'Queued':
      return { kind: 'Queued', env, taskName }
    case 'Running':
      return { kind: 'Running', env, taskName }
    case 'Completed':
      return { kind: 'Completed', env, taskName }
    case 'Failed':
      return { kind: 'Failed', env, taskName, message: status.message }
    default:
      return undefined
  }
}

// Returning `undefined` from `mapStatusToPhase` (or a phase string that
// differs from `currentK8sPhase` but is unknown to us) would otherwise
// short-circuit the sleep below and busy-loop the cluster API server.
const waitForPhaseChange = async (
  deps: ResolvedDeps,
  env: SlackEnvelope,
  taskName: string,
  currentK8sPhase: string,
): Promise<Phase> => {
  for (;;) {
    let tasks: readonly TaskCrStatus[]
    try {
      tasks = await deps.taskCrClient.list(deps.namespace)
    } catch (error) {
      deps.logger.error(
        {
          event: 'llm_agent_task_poll_list_failed',
          namespace: deps.namespace,
          task_name: taskName,
          err: error,
        },
        'failed to list Task CRs while polling for phase change',
      )
      await deps.sleep(deps.pollIntervalMs)
      continue
    }
    const match = tasks.find((t) => t.name === taskName)
    if (match === undefined) {
      // A list() succeeded but no CR with this name exists. The only path
      // that produces this state in normal operation is an operator
      // deleting the CR; staying in the loop would poll the API server
      // forever. Throwing surfaces the leak to the dispatcher's catch.
      throw new Error(
        `Task CR ${taskName} not found in namespace ${deps.namespace}`,
      )
    }
    if (
      match.phase !== undefined &&
      match.phase !== currentK8sPhase &&
      KNOWN_K8S_PHASES.has(match.phase)
    ) {
      const next = mapStatusToPhase(env, taskName, match)
      if (next !== undefined) return next
    }
    await deps.sleep(deps.pollIntervalMs)
  }
}

export const advance = async (
  phase: Phase,
  deps: ProcessMentionDeps,
): Promise<Phase> => {
  const resolved = resolve(deps)
  switch (phase.kind) {
    case 'Received': {
      const taskName = taskCrNameForSlackEvent(phase.env.eventId)
      // Mirror the Completed-side handling: a transient DB outage during
      // lookup should not abort dispatch (which would roll back event_log
      // and put Slack into a retry loop while DB recovers). Falling back
      // to undefined just creates a fresh opencode session.
      let opencodeSessionId: string | undefined
      try {
        opencodeSessionId = await resolved.threadSessionStore.lookup({
          slackTeamId: phase.env.teamId,
          slackChannelId: phase.env.channelId,
          threadRootTs: phase.env.threadRootTs,
        })
      } catch (error) {
        resolved.logger.error(
          {
            event: 'llm_agent_dispatch_thread_session_lookup_failed',
            event_id: phase.env.eventId,
            err: error,
          },
          'failed to look up opencode session during dispatch; proceeding without resume',
        )
      }
      const outcome = await resolved.taskCrClient.create({
        name: taskName,
        namespace: resolved.namespace,
        agentName: resolved.agentName,
        description: phase.env.text,
        contexts: buildContexts(phase.env, opencodeSessionId),
      })
      const { updated } = await resolved.eventLogStore.markTaskName(
        phase.env.eventId,
        taskName,
      )
      if (updated === 0) {
        resolved.logger.warn(
          {
            event: 'llm_agent_event_log_task_name_orphan',
            event_id: phase.env.eventId,
            task_name: taskName,
          },
          'event_log row missing when recording task_name',
        )
      }
      resolved.logger.info(
        {
          event: 'llm_agent_task_dispatched',
          event_id: phase.env.eventId,
          task_name: taskName,
          namespace: resolved.namespace,
          outcome,
          session_resumed: opencodeSessionId !== undefined,
        },
        outcome === 'created'
          ? 'llm-agent dispatched Task CR'
          : 'llm-agent Task CR already existed; treated as accepted',
      )
      return { kind: 'Submitted', env: phase.env, taskName }
    }
    case 'Submitted':
    case 'Queued':
    case 'Running':
      return waitForPhaseChange(
        resolved,
        phase.env,
        phase.taskName,
        k8sPhaseFor(phase.kind),
      )
    case 'Completed':
    case 'Failed':
      throw new Error(`advance called on terminal phase ${phase.kind}`)
    default: {
      const exhaustive: never = phase
      return exhaustive
    }
  }
}

const resolveSessionId = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
  taskName: string,
): Promise<string | undefined> => {
  // Resumed thread: the opencode session title still matches the *first*
  // task.name in this thread, so findSessionIdByTitle would miss it on
  // the 2nd+ turn. Look up by Slack thread first.
  try {
    const stored = await resolved.threadSessionStore.lookup({
      slackTeamId: env.teamId,
      slackChannelId: env.channelId,
      threadRootTs: env.threadRootTs,
    })
    if (stored !== undefined) return stored
  } catch (error) {
    resolved.logger.error(
      {
        event: 'llm_agent_response_thread_session_lookup_failed',
        task_name: taskName,
        err: error,
      },
      'failed to look up opencode session via thread_session_map; falling back to title lookup',
    )
  }
  // First turn: thread_session_map is empty; opencode session title is
  // task.name (set by our wrapper).
  try {
    return await resolved.opencodeClient.findSessionIdByTitle(taskName)
  } catch (error) {
    resolved.logger.error(
      {
        event: 'llm_agent_response_session_lookup_failed',
        task_name: taskName,
        err: error,
      },
      'failed to look up opencode session by title; falling back to placeholder text',
    )
    return undefined
  }
}

const buildCompletedText = async (
  resolved: ResolvedDeps,
  taskName: string,
  sessionId: string | undefined,
): Promise<string> => {
  let assistantText: string | undefined
  if (sessionId !== undefined) {
    try {
      assistantText =
        await resolved.opencodeClient.fetchLatestAssistantText(sessionId)
    } catch (error) {
      // Don't throw: re-trying every tick when opencode is down would
      // leave the user with no notification at all. Post the fallback
      // so they at least learn the Task finished.
      resolved.logger.error(
        {
          event: 'llm_agent_response_opencode_fetch_failed',
          task_name: taskName,
          session_id: sessionId,
          err: error,
        },
        'failed to fetch latest assistant message from opencode; falling back to placeholder text',
      )
    }
  } else {
    resolved.logger.warn(
      {
        event: 'llm_agent_response_session_not_found',
        task_name: taskName,
      },
      'opencode session not found for Completed Task; terminating with placeholder',
    )
  }
  // LLM output uses CommonMark/GFM; Slack mrkdwn is a different dialect.
  // slackifyMarkdown always appends a trailing newline (remark-stringify),
  // so trim it.
  let converted: string | undefined
  if (assistantText !== undefined) {
    try {
      converted = slackifyMarkdown(assistantText).replace(/\n+$/, '')
    } catch (error) {
      resolved.logger.error(
        {
          event: 'llm_agent_response_slackify_failed',
          task_name: taskName,
          err: error,
        },
        'failed to convert assistant text to Slack mrkdwn; falling back to escaped raw text',
      )
      converted = escapeMrkdwn(assistantText)
    }
  }
  // Whitespace-only text would make chat.postMessage reject with no_text
  // and trigger an unmark/retry loop on the same input.
  return converted !== undefined && converted.trim().length > 0
    ? converted
    : resolved.successFallbackText
}

interface TerminalContext {
  readonly text: string
  readonly sessionId?: string | undefined
}

const buildTerminalContext = async (
  resolved: ResolvedDeps,
  phase: Phase & { kind: 'Completed' | 'Failed' },
): Promise<TerminalContext> => {
  if (phase.kind === 'Failed') {
    return { text: formatFailureText(phase.message) }
  }
  const sessionId = await resolveSessionId(resolved, phase.env, phase.taskName)
  const text = await buildCompletedText(resolved, phase.taskName, sessionId)
  return { text, sessionId }
}

const handleTerminal = async (
  resolved: ResolvedDeps,
  phase: Phase & { kind: 'Completed' | 'Failed' },
): Promise<void> => {
  const { text, sessionId } = await buildTerminalContext(resolved, phase)

  const { updated } = await resolved.eventLogStore.markResponded(
    phase.env.eventId,
  )
  if (updated === 0) {
    resolved.logger.info(
      {
        event: 'llm_agent_task_responded_already',
        task_name: phase.taskName,
        slack_event_id: phase.env.eventId,
        phase: phase.kind,
      },
      'llm-agent skipping Slack post; event_log row already marked responded',
    )
    return
  }

  try {
    await resolved.slackClient.postMessage({
      channel: phase.env.channelId,
      thread_ts: phase.env.threadRootTs,
      text,
    })
  } catch (error) {
    try {
      await resolved.eventLogStore.unmarkResponded(phase.env.eventId)
    } catch (rollbackError) {
      resolved.logger.error(
        {
          event: 'llm_agent_response_unmark_failed',
          task_name: phase.taskName,
          slack_event_id: phase.env.eventId,
          err: rollbackError,
        },
        'failed to roll back event_log row after Slack post failure',
      )
    }
    throw error
  }

  await trySetAssistantStatus({
    slackClient: resolved.slackClient,
    target: {
      channelId: phase.env.channelId,
      threadTs: phase.env.threadRootTs,
    },
    status: CLEAR_STATUS,
    logger: resolved.logger,
  })

  if (phase.kind === 'Completed' && sessionId !== undefined) {
    try {
      await resolved.threadSessionStore.upsert({
        slackTeamId: phase.env.teamId,
        slackChannelId: phase.env.channelId,
        threadRootTs: phase.env.threadRootTs,
        opencodeSessionId: sessionId,
      })
    } catch (error) {
      resolved.logger.error(
        {
          event: 'llm_agent_response_session_upsert_failed',
          task_name: phase.taskName,
          session_id: sessionId,
          err: error,
        },
        'failed to upsert thread_session_map after responding',
      )
    }
  }

  resolved.logger.info(
    {
      event: 'llm_agent_task_responded',
      task_name: phase.taskName,
      slack_event_id: phase.env.eventId,
      phase: phase.kind,
      session_id: sessionId,
    },
    'llm-agent posted Task CR response to Slack',
  )
}

export interface ProcessMentionOptions {
  // Already-displayed bubble (from a prior dispatcher set, or a resume)
  // so processMention can dedupe the first bubble update and avoid a
  // redundant Slack call.
  readonly previousBubble?: PhaseStatus | undefined
}

const sameBubble = (
  a: PhaseStatus | undefined,
  b: PhaseStatus | undefined,
): boolean => a !== undefined && b !== undefined && a.status === b.status

export const processMention = async (
  initial: Phase,
  deps: ProcessMentionDeps,
  options: ProcessMentionOptions = {},
): Promise<void> => {
  const resolved = resolve(deps)
  let phase: Phase = initial
  let lastBubble: PhaseStatus | undefined = options.previousBubble

  for (;;) {
    const bubble = bubbleFor(phase)
    if (bubble !== undefined && !sameBubble(bubble, lastBubble)) {
      await trySetAssistantStatus({
        slackClient: resolved.slackClient,
        target: {
          channelId: phase.env.channelId,
          threadTs: phase.env.threadRootTs,
        },
        status: bubble.status,
        loadingMessages: bubble.loadingMessages,
        logger: resolved.logger,
      })
      lastBubble = bubble
    }

    if (phase.kind === 'Completed' || phase.kind === 'Failed') {
      await handleTerminal(resolved, phase)
      return
    }

    phase = await advance(phase, deps)
  }
}
