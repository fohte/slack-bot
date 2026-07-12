import { randomUUID } from 'node:crypto'

import type { AgentCard, Message, MessageSendParams, Task } from '@a2a-js/sdk'
import type { BaseMessage } from '@langchain/core/messages'
import { ToolMessage } from '@langchain/core/messages'
import type { ToolRuntime } from '@langchain/core/tools'
import { tool } from 'langchain'
import { z } from 'zod'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type {
  A2aTaskTracker,
  ThreadKey,
} from '@/plugins/llm-agent/a2a-task-tracker'
import { isA2aTaskState } from '@/plugins/llm-agent/a2a-task-tracker'
import type { ImageBlock } from '@/plugins/llm-agent/conversation-agent/image-block'
import type { RemoteAgentHandle } from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'

export interface Delegation {
  readonly agentName: string
  readonly taskId: string
  readonly contextId: string
}

// Per-turn Slack context a delegation tool needs but cannot derive from its
// own (agent-scoped, bound-once) construction: which event/thread the
// current conversation turn belongs to, and the images attached to it.
// Threaded into the tool via LangChain's runtime `context`, since
// `ConversationAgentOptions.tools` is bound once and reused across turns.
export const DELEGATION_RUNTIME_CONTEXT_SCHEMA = z.object({
  slackEventId: z.string(),
  threadKey: z.object({
    slackTeamId: z.string(),
    slackChannelId: z.string(),
    threadRootTs: z.string(),
  }),
  images: z.array(z.object({ base64: z.string(), mimeType: z.string() })),
})

// Client-side deadline armed on every newly delegated task (see
// task-lifecycle-reliability.md; tuned further once the reconciler that
// enforces it ships).
export const DEFAULT_A2A_TASK_DEADLINE_MS = 15 * 60 * 1000

export interface DelegationPushNotificationConfig {
  readonly url: string
  readonly token: string
}

export interface DelegationToolDependencies {
  readonly a2aTaskTracker: A2aTaskTracker
  // Own service's push endpoint + shared token. Omitted means delegated
  // tasks rely solely on tasks/get polling to surface their completion.
  readonly pushNotificationConfig?: DelegationPushNotificationConfig | undefined
  readonly taskDeadlineMs?: number | undefined
  readonly now?: (() => Date) | undefined
  readonly randomUUID?: (() => string) | undefined
  readonly logger?: Logger | undefined
}

const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug === '' ? 'agent' : slug
}

export const delegationToolName = (card: AgentCard): string =>
  `delegate_to_${slugify(card.name)}`

// Built entirely from the Agent Card so no domain knowledge is hardcoded
// here (requirement: slack-bot stays domain-agnostic).
export const delegationToolDescription = (card: AgentCard): string => {
  const skillLines = card.skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join('\n')
  const lines = [
    `Delegate a task to the "${card.name}" agent. ${card.description}`,
  ]
  if (skillLines !== '') lines.push('Skills:', skillLines)
  return lines.join('\n')
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toFilePart = (image: ImageBlock) => ({
  kind: 'file' as const,
  file: { bytes: image.base64, mimeType: image.mimeType },
})

const DELEGATION_INPUT_SCHEMA = z.object({
  request: z
    .string()
    .describe(
      'The full, self-contained request to send to this agent. It cannot ' +
        'see this conversation, so include every relevant detail from it. ' +
        'Attached images are forwarded automatically and do not need to be ' +
        'described.',
    ),
})

export const createDelegationTool = (
  handle: RemoteAgentHandle,
  deps: DelegationToolDependencies,
) => {
  const now = deps.now ?? (() => new Date())
  const genId = deps.randomUUID ?? randomUUID
  const deadlineMs = deps.taskDeadlineMs ?? DEFAULT_A2A_TASK_DEADLINE_MS
  const logger = deps.logger ?? noopLogger

  return tool(
    async (
      input: z.infer<typeof DELEGATION_INPUT_SCHEMA>,
      runtime: ToolRuntime<unknown, typeof DELEGATION_RUNTIME_CONTEXT_SCHEMA>,
    ): Promise<[string, Delegation | undefined]> => {
      const { slackEventId, threadKey, images } = runtime.context

      // New delegations always start a fresh message/send; resuming an
      // input-required task goes through A2ATaskTracker directly rather
      // than back through this tool (see design/components.md).
      const contextId = await deps.a2aTaskTracker.lookupContext(
        threadKey,
        handle.name,
      )

      const message: Message = {
        kind: 'message',
        messageId: genId(),
        role: 'user',
        parts: [
          { kind: 'text', text: input.request },
          ...images.map(toFilePart),
        ],
        ...(contextId !== undefined ? { contextId } : {}),
      }

      const params: MessageSendParams = {
        message,
        configuration: {
          blocking: false,
          ...(deps.pushNotificationConfig !== undefined
            ? { pushNotificationConfig: deps.pushNotificationConfig }
            : {}),
        },
      }

      let result: Message | Task
      try {
        result = await handle.client.sendMessage(params)
      } catch (error) {
        logger.warn(
          {
            event: 'llm_agent_remote_agent_delegation_send_failed',
            agent_name: handle.name,
            err: error,
          },
          'llm-agent delegation tool failed to send message/send to a remote agent',
        )
        return [
          `Delegating to ${handle.name} failed: ${describeError(error)}. ` +
            'Tell the user the request could not be sent.',
          undefined,
        ]
      }

      if (result.kind !== 'task') {
        return [
          `${handle.name} replied without creating a trackable task. Tell ` +
            'the user this delegation could not be tracked and may need to ' +
            'be retried.',
          undefined,
        ]
      }
      if (!isA2aTaskState(result.status.state)) {
        return [
          `${handle.name} returned an unrecognized task state ` +
            `(${result.status.state}). Tell the user this delegation failed.`,
          undefined,
        ]
      }

      const threadKeyForRecord: ThreadKey = threadKey
      await deps.a2aTaskTracker.recordDelegated({
        ...threadKeyForRecord,
        taskId: result.id,
        contextId: result.contextId,
        agentName: handle.name,
        slackEventId,
        state: result.status.state,
        deadlineAt: new Date(now().getTime() + deadlineMs),
      })

      return [
        `Delegated to ${handle.name} (taskId=${result.id}). The task runs ` +
          'asynchronously; tell the user their request was handed off and ' +
          "they'll get a follow-up when it completes.",
        {
          agentName: handle.name,
          taskId: result.id,
          contextId: result.contextId,
        },
      ]
    },
    {
      name: delegationToolName(handle.card),
      description: delegationToolDescription(handle.card),
      schema: DELEGATION_INPUT_SCHEMA,
      responseFormat: 'content_and_artifact',
    },
  )
}

export const createDelegationTools = (
  handles: readonly RemoteAgentHandle[],
  deps: DelegationToolDependencies,
) => handles.map((handle) => createDelegationTool(handle, deps))

const isDelegation = (value: unknown): value is Delegation =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<Delegation>).agentName === 'string' &&
  typeof (value as Partial<Delegation>).taskId === 'string' &&
  typeof (value as Partial<Delegation>).contextId === 'string'

// A delegation tool call's Delegation artifact (see createDelegationTool
// above) is the sole source of ConversationOutcome.delegations; every
// successful delegate_to_* tool call surfaces one ToolMessage carrying it.
export const extractDelegations = (
  messages: readonly BaseMessage[],
): readonly Delegation[] =>
  messages
    .filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message),
    )
    .map((message): unknown => message.artifact)
    .filter(isDelegation)
