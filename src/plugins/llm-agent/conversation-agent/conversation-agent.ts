import { randomUUID } from 'node:crypto'

import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ContentBlock } from '@langchain/core/messages'
import { HumanMessage } from '@langchain/core/messages'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import { GenAiCallbackHandler } from '@/plugins/llm-agent/conversation-agent/genai-callback-handler'
import type { ImageBlock } from '@/plugins/llm-agent/conversation-agent/image-block'
import { stripThinkBlocks } from '@/plugins/llm-agent/conversation-agent/strip-think-blocks'
import { parseConversationThreadId } from '@/plugins/llm-agent/conversation-agent/thread-id'
// Delegation is defined in remote-agent-registry (the tool call that
// produces it) and re-exported below to keep this module's existing public
// import path (@/plugins/llm-agent/conversation-agent) unchanged.
import type { Delegation } from '@/plugins/llm-agent/remote-agent-registry'
import {
  DELEGATION_RUNTIME_CONTEXT_SCHEMA,
  extractDelegations,
} from '@/plugins/llm-agent/remote-agent-registry'

export type { Delegation } from '@/plugins/llm-agent/remote-agent-registry'

// OpenCode Go's OpenAI-compatible endpoint.
export const DEFAULT_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

const GEN_AI_PROVIDER_NAME = 'opencode'

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

export interface ConversationAgentInput {
  // team:channel:thread_root_ts, see thread-id.ts
  readonly threadId: string
  readonly userText: string
  readonly images: readonly ImageBlock[]
  // Slack event driving this turn; recorded on any a2a_task row a
  // delegation tool call creates during it.
  readonly slackEventId: string
}

export interface ConversationAgent {
  // Concurrent calls for the same threadId are not serialized against each
  // other: the checkpointer's read-then-write means two in-flight calls can
  // both read the same latest checkpoint and each write a child of it, so
  // only one branch survives as the thread's history and the other turn is
  // silently dropped. Callers must ensure at most one in-flight respond()
  // per threadId.
  respond(input: ConversationAgentInput): Promise<ConversationOutcome>
}

type CreateAgentTools = NonNullable<Parameters<typeof createAgent>[0]['tools']>

export interface ConversationAgentOptions {
  readonly model: BaseChatModel
  readonly checkpointer: BaseCheckpointSaver
  // Persona/tone only, never domain knowledge (kept out of this repo by
  // design; domain agents live behind A2A delegation).
  readonly personaPrompt?: string | undefined
  readonly tools?: CreateAgentTools | undefined
  readonly genAiCallbackHandler?: BaseCallbackHandler | undefined
  readonly logger?: Logger | undefined
}

const buildHumanMessageContent = (
  userText: string,
  images: readonly ImageBlock[],
): Array<ContentBlock.Text | ContentBlock.Multimodal.Image> => [
  { type: 'text', text: userText },
  ...images.map((image): ContentBlock.Multimodal.Image => ({
    type: 'image',
    mimeType: image.mimeType,
    data: image.base64,
  })),
]

export const createConversationAgent = (
  options: ConversationAgentOptions,
): ConversationAgent => {
  const genAiCallbackHandler =
    options.genAiCallbackHandler ??
    new GenAiCallbackHandler({ providerName: GEN_AI_PROVIDER_NAME })
  const logger = options.logger ?? noopLogger

  const agent = createAgent({
    model: options.model,
    tools: options.tools ?? [],
    checkpointer: options.checkpointer,
    contextSchema: DELEGATION_RUNTIME_CONTEXT_SCHEMA,
    ...(options.personaPrompt !== undefined && options.personaPrompt !== ''
      ? { systemPrompt: options.personaPrompt }
      : {}),
  })

  return {
    async respond({ threadId, userText, images, slackEventId }) {
      // A stable id lets this turn's own messages be located in the
      // checkpointer's full thread history below: LangGraph's messages
      // reducer keys deduplication/append on message id, so this id is
      // guaranteed to survive into result.messages unchanged.
      const turnMessageId = randomUUID()
      const message = new HumanMessage({
        id: turnMessageId,
        // contentBlocks (not content) is required for @langchain/openai to
        // recognize these as standard v1 content blocks: it sets
        // response_metadata.output_version = 'v1', which is what the
        // Chat Completions/Responses converters key off of to route
        // image blocks through the standard-block conversion path instead
        // of treating them as (unrecognized) provider-native content.
        contentBlocks: buildHumanMessageContent(userText, images),
      })
      const { teamId, channelId, threadRootTs } =
        parseConversationThreadId(threadId)
      const result = await agent.invoke(
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
            images: [...images],
          },
          callbacks: [genAiCallbackHandler],
        },
      )
      const lastMessage = result.messages.at(-1)
      // result.messages is the whole thread history the checkpointer has
      // accumulated, not just this turn's new messages, so delegations from
      // earlier turns must be excluded rather than re-reported here.
      const turnStart = result.messages.findIndex((m) => m.id === turnMessageId)
      const turnMessages =
        turnStart === -1 ? result.messages : result.messages.slice(turnStart)
      const { text, stripped } = stripThinkBlocks(lastMessage?.text ?? '')
      if (stripped) {
        // Signals that reasoning_split (see createOpenCodeGoChatModel above)
        // wasn't honored end-to-end and this fallback was the only thing
        // that kept a <think> block out of Slack.
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
    },
  }
}
