import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'

export interface RecordingChatModel extends BaseChatModel {
  readonly calls: ReadonlyArray<readonly BaseMessage[]>
}

export interface RecordingChatModelToolCall {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly id: string
}

export interface RecordingChatModelReply {
  readonly content?: string
  // Simulates the model deciding to call a tool; createAgent's graph routes
  // these to the matching bound tool exactly as it would a real model's
  // function-calling output.
  readonly toolCalls?: readonly RecordingChatModelToolCall[]
}

// createAgent() always calls model.bindTools(tools) even for an empty tools
// array, so any fake model driven through createAgent must implement
// bindTools even though most of this module's tests never attach a tool.
class RecordingChatModelImpl
  extends BaseChatModel
  implements RecordingChatModel
{
  readonly calls: BaseMessage[][] = []

  constructor(
    private readonly reply: (
      messages: readonly BaseMessage[],
      callIndex: number,
    ) => string | RecordingChatModelReply,
  ) {
    super({})
  }

  override _llmType(): string {
    return 'recording-fake'
  }

  override bindTools(): this {
    return this
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const replied = this.reply(messages, this.calls.length - 1)
    const { content, toolCalls } =
      typeof replied === 'string'
        ? { content: replied, toolCalls: undefined }
        : replied
    const message = new AIMessage({
      content: content ?? '',
      ...(toolCalls !== undefined
        ? {
            tool_calls: toolCalls.map((call) => ({
              name: call.name,
              args: call.args,
              id: call.id,
              type: 'tool_call' as const,
            })),
          }
        : {}),
    })
    return { generations: [{ text: content ?? '', message }] }
  }
}

// Records every call's message list and replies with `reply(messages,
// callIndex)`, so tests can assert on exactly what createAgent sent to the
// model (conversation history, image content blocks, system prompt, etc.)
// without a real LLM call. `reply` may return a plain string, or an object
// with `toolCalls` to simulate the model invoking a bound tool.
export const createRecordingChatModel = (
  reply: (
    messages: readonly BaseMessage[],
    callIndex: number,
  ) => string | RecordingChatModelReply,
): RecordingChatModel => new RecordingChatModelImpl(reply)
