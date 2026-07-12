import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'

export interface RecordingChatModel extends BaseChatModel {
  readonly calls: ReadonlyArray<readonly BaseMessage[]>
}

// createAgent() always calls model.bindTools(tools) even for an empty tools
// array, so any fake model driven through createAgent must implement
// bindTools even though this module's tests never attach a tool.
class RecordingChatModelImpl
  extends BaseChatModel
  implements RecordingChatModel
{
  readonly calls: BaseMessage[][] = []

  constructor(
    private readonly reply: (
      messages: readonly BaseMessage[],
      callIndex: number,
    ) => string,
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
    const text = this.reply(messages, this.calls.length - 1)
    return { generations: [{ text, message: new AIMessage(text) }] }
  }
}

// Records every call's message list and replies with `reply(messages,
// callIndex)`, so tests can assert on exactly what createAgent sent to the
// model (conversation history, image content blocks, system prompt, etc.)
// without a real LLM call.
export const createRecordingChatModel = (
  reply: (messages: readonly BaseMessage[], callIndex: number) => string,
): RecordingChatModel => new RecordingChatModelImpl(reply)
