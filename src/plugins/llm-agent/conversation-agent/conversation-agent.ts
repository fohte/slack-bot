import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ContentBlock } from '@langchain/core/messages'
import { HumanMessage } from '@langchain/core/messages'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'

import { GenAiCallbackHandler } from '@/plugins/llm-agent/conversation-agent/genai-callback-handler'
import type { ImageBlock } from '@/plugins/llm-agent/conversation-agent/image-block'

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
  })

export interface Delegation {
  readonly agentName: string
  readonly taskId: string
  readonly contextId: string
}

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

  const agent = createAgent({
    model: options.model,
    tools: options.tools ?? [],
    checkpointer: options.checkpointer,
    ...(options.personaPrompt !== undefined && options.personaPrompt !== ''
      ? { systemPrompt: options.personaPrompt }
      : {}),
  })

  return {
    async respond({ threadId, userText, images }) {
      const message = new HumanMessage({
        content: buildHumanMessageContent(userText, images),
      })
      const result = await agent.invoke(
        { messages: [message] },
        {
          configurable: { thread_id: threadId },
          callbacks: [genAiCallbackHandler],
        },
      )
      const lastMessage = result.messages.at(-1)
      return {
        text: lastMessage?.text ?? '',
        delegations: [],
      }
    },
  }
}
