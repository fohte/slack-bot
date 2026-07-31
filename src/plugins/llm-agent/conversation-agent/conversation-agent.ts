import { randomUUID } from 'node:crypto'

import { captureWithFingerprint } from '@fohte/service-kit/observability'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ContentBlock } from '@langchain/core/messages'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'
import { errAsync, ResultAsync } from 'neverthrow'

import type { Logger } from '#logger/logger'
import { noopLogger } from '#logger/logger'
import { createGenAiTracingMiddleware } from '#plugins/llm-agent/conversation-agent/genai-tracing-middleware'
import { stripThinkBlocks } from '#plugins/llm-agent/conversation-agent/strip-think-blocks'
import { parseConversationThreadId } from '#plugins/llm-agent/conversation-agent/thread-id'
// Delegation is defined in remote-agent-registry (the tool call that
// produces it) and re-exported below to keep this module's existing public
// import path (#plugins/llm-agent/conversation-agent/index) unchanged.
import type { Delegation } from '#plugins/llm-agent/remote-agent-registry/index'
import {
  DELEGATION_RUNTIME_CONTEXT_SCHEMA,
  extractDelegations,
} from '#plugins/llm-agent/remote-agent-registry/index'
import {
  ConversationAgentGetThreadCursorError,
  ConversationAgentInvokeError,
  type ConversationThreadIdParseError,
} from '#types/errors'

export type { Delegation } from '#plugins/llm-agent/remote-agent-registry/index'

// OpenCode Go's OpenAI-compatible endpoint.
export const DEFAULT_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

const GEN_AI_PROVIDER_NAME = 'opencode'

// Groups every LLM invoke failure under one Sentry issue per boundary
// rather than per call site.
const CONVERSATION_AGENT_INVOKE_FINGERPRINT =
  'llm-agent.conversation-agent.invoke-failed'
const CONVERSATION_AGENT_GET_THREAD_CURSOR_FINGERPRINT =
  'llm-agent.conversation-agent.get-thread-cursor-failed'

export interface CreateOpenCodeGoChatModelOptions {
  readonly apiKey: string
  readonly model: string
  readonly baseUrl?: string | undefined
}

// 429s are retried by ChatOpenAI's underlying client following the
// Retry-After response header; no custom retry logic is layered on top.
export const createOpenCodeGoChatModel = (
  options: CreateOpenCodeGoChatModelOptions,
): ChatOpenAI =>
  new ChatOpenAI({
    apiKey: options.apiKey,
    model: options.model,
    configuration: {
      baseURL: options.baseUrl ?? DEFAULT_OPENCODE_GO_BASE_URL,
    },
    // Asks the upstream API to move reasoning out of `content` into a
    // separate field (see strip-think-blocks.ts for why that matters).
    // Whether OpenCode Go forwards this to the underlying provider is
    // unconfirmed, so stripThinkBlocks in respond() below is the actual
    // guarantee against a <think> leak.
    modelKwargs: { reasoning_split: true },
  })

export interface ConversationOutcome {
  // User-facing reply text; when the turn included a delegation, this is the
  // agent's intermediate response rather than the delegated task's result.
  readonly text: string
  // Empty means a pure conversational turn.
  readonly delegations: readonly Delegation[]
}

// Result of syncing a turn's unseen thread messages into context, produced
// by steps/sync-thread-context.ts and passed straight through to respond().
export interface ThreadContextForTurn {
  // <thread_context> block text; undefined when there was nothing new to
  // inject (e.g. every unseen message was filtered out by dedup rules).
  readonly text: string | undefined
  // Vision-model description of images extracted from injected messages,
  // pre-formatted with `[画像 N]` labels matching the markers embedded in
  // `text`. Undefined when there was nothing to describe. Never raw image
  // bytes: steps/sync-thread-context.ts converts them to text via
  // describeImages before this reaches the conversation agent's prompt.
  readonly imageDescription: string | undefined
  // Max ts among the messages folded into this sync, independent of whether
  // any of them ended up in `text`/`imageDescription`; advances
  // getThreadCursor's result even for a turn whose sync produced no visible
  // injection.
  readonly contextMaxTs: string | undefined
}

export interface ConversationAgentInput {
  // team:channel:thread_root_ts, see thread-id.ts
  readonly threadId: string
  readonly userText: string
  // Vision-model description of this turn's new image attachments, never
  // raw image bytes: steps/dispatcher.ts converts them to text via
  // describeImages before this reaches the conversation agent's prompt or
  // any delegation tool's request.
  readonly imageDescription: string | undefined
  // Slack event driving this turn; recorded on any a2a_task row a
  // delegation tool call creates during it.
  readonly slackEventId: string
  // ts of the Slack message that triggered this turn. Tagged onto the
  // HumanMessage so a later turn's getThreadCursor call can resume the
  // thread-context diff sync from where this turn left off.
  readonly triggerTs: string
  readonly threadContext?: ThreadContextForTurn | undefined
}

export interface ConversationAgent {
  // Concurrent calls for the same threadId are not serialized against each
  // other: the checkpointer's read-then-write means two in-flight calls can
  // both read the same latest checkpoint and each write a child of it, so
  // only one branch survives as the thread's history and the other turn is
  // silently dropped. Callers must ensure at most one in-flight respond()
  // per threadId.
  respond(
    input: ConversationAgentInput,
  ): ResultAsync<
    ConversationOutcome,
    ConversationThreadIdParseError | ConversationAgentInvokeError
  >
  // Max ts already folded into this thread's checkpoint (via either a
  // turn's own trigger or a prior turn's thread-context sync), or undefined
  // when no checkpoint exists yet (cold start: nothing has been seen).
  getThreadCursor(
    threadId: string,
  ): ResultAsync<string | undefined, ConversationAgentGetThreadCursorError>
}

type CreateAgentTools = NonNullable<Parameters<typeof createAgent>[0]['tools']>

export interface ConversationAgentOptions {
  readonly model: BaseChatModel
  readonly checkpointer: BaseCheckpointSaver
  // Persona/tone only, never domain knowledge (kept out of this repo by
  // design; domain agents live behind A2A delegation).
  readonly personaPrompt?: string | undefined
  readonly tools?: CreateAgentTools | undefined
  readonly logger?: Logger | undefined
}

const toDescriptionBlock = (
  tag: string,
  description: string,
): ContentBlock.Text => ({
  type: 'text',
  text: `<${tag}>\n${description}\n</${tag}>`,
})

// Each describeImages call independently restarts its own `[画像 N]`
// numbering (see conversation-agent/image-analysis.ts), so a thread-context
// description and this turn's own description can both legitimately contain
// a "[画像 1]" label. Wrapping them in distinct tags keeps those labels from
// being read as referring to the same image.
const toThreadContextImageDescriptionBlock = (
  description: string,
): ContentBlock.Text => toDescriptionBlock('thread_context_images', description)

const toOwnImageDescriptionBlock = (description: string): ContentBlock.Text =>
  toDescriptionBlock('attached_images', description)

// The thread-context text block, when present, is prepended ahead of the
// user's own text block rather than merged into it, so a prompt-cache replay
// of this turn from the checkpoint never has to reconstruct where one ends
// and the other begins.
const buildHumanMessageContent = (
  userText: string,
  imageDescription: string | undefined,
  threadContext: ThreadContextForTurn | undefined,
): ContentBlock.Text[] => [
  ...(threadContext?.text !== undefined
    ? [{ type: 'text' as const, text: threadContext.text }]
    : []),
  { type: 'text', text: userText },
  ...(threadContext?.imageDescription !== undefined
    ? [toThreadContextImageDescriptionBlock(threadContext.imageDescription)]
    : []),
  ...(imageDescription !== undefined
    ? [toOwnImageDescriptionBlock(imageDescription)]
    : []),
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface ThreadCursorTag {
  readonly turnTs: string
  readonly contextMaxTs?: string
}

const isThreadCursorTag = (value: unknown): value is ThreadCursorTag =>
  isRecord(value) &&
  typeof value['turnTs'] === 'string' &&
  (value['contextMaxTs'] === undefined ||
    typeof value['contextMaxTs'] === 'string')

// Scans every HumanMessage the checkpointer has accumulated for a thread and
// returns the max ts across their turnTs/contextMaxTs tags (see respond()'s
// additional_kwargs above), or undefined when none are tagged yet. A thread
// with real HumanMessage history predating this tagging (i.e. checkpointed
// before this feature shipped) also reads as untagged, so its next turn
// treats the whole thread as cold-start: everything gets refetched and
// re-injected as thread_context once, duplicating content the checkpoint
// already has. Self-limiting to that one turn per pre-existing thread, so no
// backfill migration is done for it.
const computeThreadCursor = (messagesValue: unknown): string | undefined => {
  if (!Array.isArray(messagesValue)) return undefined
  let cursor: string | undefined
  for (const message of messagesValue) {
    if (!HumanMessage.isInstance(message)) continue
    const slack: unknown = message.additional_kwargs['slack']
    if (!isThreadCursorTag(slack)) continue
    for (const ts of [slack.turnTs, slack.contextMaxTs]) {
      if (
        ts !== undefined &&
        (cursor === undefined || Number(ts) > Number(cursor))
      ) {
        cursor = ts
      }
    }
  }
  return cursor
}

export const createConversationAgent = (
  options: ConversationAgentOptions,
): ConversationAgent => {
  const logger = options.logger ?? noopLogger

  const agent = createAgent({
    model: options.model,
    tools: options.tools ?? [],
    checkpointer: options.checkpointer,
    contextSchema: DELEGATION_RUNTIME_CONTEXT_SCHEMA,
    middleware: [
      createGenAiTracingMiddleware({ providerName: GEN_AI_PROVIDER_NAME }),
    ],
    // Passed as a SystemMessage with string content rather than a plain
    // string: createAgent's normalizeSystemPrompt() wraps a plain string in
    // multi-part content ([{type: "text", text: ...}]), and the upstream
    // model (gpt-5.6-luna via OpenCode Go's Zen gateway) silently drops the
    // entire system prompt when it receives multi-part system content.
    ...(options.personaPrompt !== undefined && options.personaPrompt !== ''
      ? { systemPrompt: new SystemMessage(options.personaPrompt) }
      : {}),
  })

  return {
    respond({
      threadId,
      userText,
      imageDescription,
      slackEventId,
      triggerTs,
      threadContext,
    }) {
      // A stable id lets this turn's own messages be located in the
      // checkpointer's full thread history below: LangGraph's messages
      // reducer keys deduplication/append on message id, so this id is
      // guaranteed to survive into result.messages unchanged.
      const turnMessageId = randomUUID()
      const message = new HumanMessage({
        id: turnMessageId,
        contentBlocks: buildHumanMessageContent(
          userText,
          imageDescription,
          threadContext,
        ),
        // Read back by computeThreadCursor (via getThreadCursor) to resume
        // the next turn's thread-context diff sync from where this one left
        // off, without ever rewriting an already-checkpointed message.
        additional_kwargs: {
          slack: {
            turnTs: triggerTs,
            ...(threadContext?.contextMaxTs !== undefined
              ? { contextMaxTs: threadContext.contextMaxTs }
              : {}),
          },
        },
      })
      const parsedThreadId = parseConversationThreadId(threadId)
      if (parsedThreadId.isErr()) return errAsync(parsedThreadId.error)
      const { teamId, channelId, threadRootTs } = parsedThreadId.value
      return ResultAsync.fromPromise(
        agent.invoke(
          { messages: [message] },
          {
            configurable: { thread_id: threadId },
            context: {
              slackEventId,
              threadKey: {
                slackTeamId: teamId,
                slackChannelId: channelId,
                threadRootTs,
              },
              imageDescription,
            },
          },
        ),
        (caughtErr) => {
          const wrapped = new ConversationAgentInvokeError(
            `llm-agent conversation agent invoke failed for thread ${threadId}`,
            caughtErr,
          )
          captureWithFingerprint(
            wrapped,
            CONVERSATION_AGENT_INVOKE_FINGERPRINT,
            {
              extras: { threadId, slackEventId },
            },
          )
          return wrapped
        },
      ).map((result) => {
        const lastMessage = result.messages.at(-1)
        // result.messages is the whole thread history the checkpointer has
        // accumulated, not just this turn's new messages, so delegations
        // from earlier turns must be excluded rather than re-reported here.
        const turnStart = result.messages.findIndex(
          (m) => m.id === turnMessageId,
        )
        const turnMessages =
          turnStart === -1 ? result.messages : result.messages.slice(turnStart)
        const { text, stripped } = stripThinkBlocks(lastMessage?.text ?? '')
        if (stripped) {
          // Signals that reasoning_split (see createOpenCodeGoChatModel
          // above) wasn't honored end-to-end and this fallback was the only
          // thing that kept a <think> block out of Slack.
          logger.warn(
            {
              event: 'llm_agent_think_block_leaked',
              slack_event_id: slackEventId,
            },
            'model reply contained a <think> block; stripped it before returning',
          )
        }
        return {
          text,
          delegations: extractDelegations(turnMessages),
        }
      })
    },
    getThreadCursor(threadId) {
      return ResultAsync.fromPromise(
        agent.graph.getState({ configurable: { thread_id: threadId } }),
        (caughtErr) => {
          const wrapped = new ConversationAgentGetThreadCursorError(
            `llm-agent conversation agent getState failed for thread ${threadId}`,
            caughtErr,
          )
          captureWithFingerprint(
            wrapped,
            CONVERSATION_AGENT_GET_THREAD_CURSOR_FINGERPRINT,
            { extras: { threadId } },
          )
          return wrapped
        },
      ).map((snapshot) => {
        const values: unknown = snapshot.values
        return computeThreadCursor(
          isRecord(values) ? values['messages'] : undefined,
        )
      })
    },
  }
}
