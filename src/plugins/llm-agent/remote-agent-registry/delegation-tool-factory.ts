import { randomUUID } from 'node:crypto'

import type { AgentCard, Message, MessageSendParams } from '@a2a-js/sdk'
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
import { toFilePart } from '@/plugins/llm-agent/remote-agent-registry/a2a-message-parts'
import type { RemoteAgentHandle } from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'
import { SEND_MESSAGE_RESULT_SCHEMA } from '@/plugins/llm-agent/remote-agent-registry/send-message-result'

export interface Delegation {
  readonly agentName: string
  readonly taskId: string
  readonly contextId: string
}

const THREAD_KEY_SCHEMA = z.object({
  slackTeamId: z.string(),
  slackChannelId: z.string(),
  threadRootTs: z.string(),
}) satisfies z.ZodType<ThreadKey>

const IMAGE_BLOCK_SCHEMA = z.object({
  base64: z.string(),
  mimeType: z.string(),
}) satisfies z.ZodType<ImageBlock>

// Per-turn Slack context a delegation tool needs but cannot derive from its
// own (agent-scoped, bound-once) construction: which event/thread the
// current conversation turn belongs to, and the images attached to it.
// Threaded into the tool via LangChain's runtime `context`, since
// `ConversationAgentOptions.tools` is bound once and reused across turns.
export const DELEGATION_RUNTIME_CONTEXT_SCHEMA = z.object({
  slackEventId: z.string(),
  threadKey: THREAD_KEY_SCHEMA,
  images: z.array(IMAGE_BLOCK_SCHEMA),
})

// Initial client-side deadline armed on every newly delegated task; a
// reconciler enforces it by failing tasks that miss it (not yet built).
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
      // input-required task is a different, tool-independent flow that
      // sends directly to the existing taskId/contextId instead of coming
      // back through the model as a tool call.
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

      let rawResult: unknown
      try {
        rawResult = await handle.client.sendMessage(params)
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

      // A schema mismatch here means the request may already have reached
      // the remote agent (unlike the network failure above), so this is
      // reported as an untrackable delegation rather than a failed send.
      let result: z.infer<typeof SEND_MESSAGE_RESULT_SCHEMA>
      try {
        result = SEND_MESSAGE_RESULT_SCHEMA.parse(rawResult)
      } catch (error) {
        logger.warn(
          {
            event: 'llm_agent_remote_agent_delegation_malformed_result',
            agent_name: handle.name,
            err: error,
          },
          'llm-agent delegation tool received a malformed message/send result from a remote agent',
        )
        return [
          `${handle.name} returned a response that could not be understood. ` +
            'Tell the user this delegation may have been sent but could not ' +
            'be tracked.',
          undefined,
        ]
      }

      if (result.kind !== 'task') {
        logger.warn(
          {
            event: 'llm_agent_remote_agent_delegation_non_task_result',
            agent_name: handle.name,
          },
          'llm-agent delegation tool received a non-task message/send result from a remote agent',
        )
        return [
          `${handle.name} replied without creating a trackable task. Tell ` +
            'the user this delegation could not be tracked and may need to ' +
            'be retried.',
          undefined,
        ]
      }
      if (!isA2aTaskState(result.status.state)) {
        logger.warn(
          {
            event: 'llm_agent_remote_agent_delegation_unrecognized_state',
            agent_name: handle.name,
            task_state: result.status.state,
          },
          'llm-agent delegation tool received an unrecognized task state from a remote agent',
        )
        return [
          `${handle.name} returned an unrecognized task state ` +
            `(${result.status.state}). Tell the user this delegation failed.`,
          undefined,
        ]
      }

      const delegation: Delegation = {
        agentName: handle.name,
        taskId: result.id,
        contextId: result.contextId,
      }
      const threadKeyForRecord: ThreadKey = threadKey
      try {
        await deps.a2aTaskTracker.recordDelegated({
          ...threadKeyForRecord,
          taskId: result.id,
          contextId: result.contextId,
          agentName: handle.name,
          slackEventId,
          state: result.status.state,
          deadlineAt: new Date(now().getTime() + deadlineMs),
        })
      } catch (error) {
        // The remote agent already started this task; failing to record it
        // here only breaks slack-bot's own polling/resume tracking for it,
        // so this still reports success with the real taskId/contextId
        // rather than telling the user the delegation itself failed.
        logger.warn(
          {
            event: 'llm_agent_remote_agent_delegation_record_failed',
            agent_name: handle.name,
            task_id: result.id,
            err: error,
          },
          'llm-agent delegation tool sent a task but failed to record it locally',
        )
        return [
          `Delegated to ${handle.name} (taskId=${result.id}) but this ` +
            'service failed to record the task locally. Tell the user ' +
            'follow-up tracking of this request may not work.',
          delegation,
        ]
      }

      return [
        `Delegated to ${handle.name} (taskId=${result.id}). The task runs ` +
          'asynchronously; tell the user their request was handed off and ' +
          "they'll get a follow-up when it completes.",
        delegation,
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
) => {
  const seenNames = new Set<string>()
  return handles.map((handle) => {
    const toolName = delegationToolName(handle.card)
    // A collision would leave one of the two agents permanently
    // unreachable (tool dispatch resolves by name, first match wins) with
    // no error surfaced anywhere, so this fails loudly instead.
    if (seenNames.has(toolName)) {
      throw new Error(
        `duplicate delegation tool name '${toolName}' for remote agent ` +
          `'${handle.name}'; Agent Card names must be unique after ` +
          'slugification',
      )
    }
    seenNames.add(toolName)
    return createDelegationTool(handle, deps)
  })
}

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
