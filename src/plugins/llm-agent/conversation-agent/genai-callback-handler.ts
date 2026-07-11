import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { Serialized } from '@langchain/core/load/serializable'
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from '@langchain/core/messages'
import type {
  ChatGeneration,
  Generation,
  LLMResult,
} from '@langchain/core/outputs'
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
} from '@opentelemetry/semantic-conventions/incubating'

// Mirrors the env var used by other OpenTelemetry GenAI instrumentations
// (e.g. opentelemetry-instrumentation-openai-v2, Elastic's EDOT Node.js SDK)
// to gate capture of message content, which is opt-in per the GenAI semantic
// conventions because it may contain PII.
const CAPTURE_MESSAGE_CONTENT_ENV_VAR =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'

const TRACER_NAME = 'slack-bot-conversation-agent'

export interface GenAiCallbackHandlerOptions {
  readonly providerName: string
  readonly captureMessageContent?: boolean | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

// Shapes below follow the GenAI semantic conventions' message format
// (gen_ai.input.messages / gen_ai.output.messages):
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md

interface GenAiTextPart {
  readonly type: 'text'
  readonly content: string
}

interface GenAiToolCallPart {
  readonly type: 'tool_call'
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

interface GenAiToolCallResponsePart {
  readonly type: 'tool_call_response'
  readonly id: string
  readonly response: string
}

type GenAiMessagePart =
  GenAiTextPart | GenAiToolCallPart | GenAiToolCallResponsePart

interface GenAiMessage {
  readonly role: string
  readonly parts: readonly GenAiMessagePart[]
}

interface GenAiOutputMessage extends GenAiMessage {
  readonly finish_reason?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const roleForMessage = (message: BaseMessage): string => {
  if (message.type === 'human') return 'user'
  if (message.type === 'ai') return 'assistant'
  return message.type
}

// Raw image bytes are redacted: they bloat span payloads and, unlike text,
// carry no debugging value once reduced to an opaque data URL.
const contentToGenAiParts = (
  content: BaseMessage['content'],
): GenAiMessagePart[] => {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', content }]
  }
  return content.map((block): GenAiMessagePart => {
    if (isRecord(block) && block['type'] === 'text' && 'text' in block) {
      const text = block['text']
      return { type: 'text', content: typeof text === 'string' ? text : '' }
    }
    const blockType =
      isRecord(block) && typeof block['type'] === 'string'
        ? block['type']
        : 'unknown'
    return { type: 'text', content: `[${blockType} omitted]` }
  })
}

const toolCallsToGenAiParts = (message: BaseMessage): GenAiToolCallPart[] => {
  if (!AIMessage.isInstance(message)) return []
  const toolCalls = message.tool_calls ?? []
  return toolCalls.map((call) => ({
    type: 'tool_call',
    id: call.id ?? '',
    name: call.name,
    arguments: call.args,
  }))
}

const messageToGenAiMessage = (message: BaseMessage): GenAiMessage => {
  if (ToolMessage.isInstance(message)) {
    const content = message.content
    return {
      role: 'tool',
      parts: [
        {
          type: 'tool_call_response',
          id: message.tool_call_id,
          response:
            typeof content === 'string' ? content : JSON.stringify(content),
        },
      ],
    }
  }
  return {
    role: roleForMessage(message),
    parts: [
      ...contentToGenAiParts(message.content),
      ...toolCallsToGenAiParts(message),
    ],
  }
}

const isChatGeneration = (
  generation: Generation,
): generation is ChatGeneration => 'message' in generation

const chatGenerationsOf = (output: LLMResult): ChatGeneration[] =>
  output.generations.flat().filter(isChatGeneration)

const generationInfoString = (
  generation: ChatGeneration | undefined,
  key: string,
): string | undefined => {
  const value: unknown = generation?.generationInfo?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

interface UsageTokens {
  readonly inputTokens: number
  readonly outputTokens: number
}

// AIMessage#usage_metadata is typed through a generic MessageStructure that
// resolves to `undefined` unless the message was constructed with an
// explicit structure parameter, which generic ChatGeneration.message values
// never carry — so this reads the field at runtime instead of through the
// (uninformative) static type.
const usageTokensOf = (message: BaseMessage): UsageTokens | undefined => {
  if (!isRecord(message)) return undefined
  const usageMetadata = message['usage_metadata']
  if (!isRecord(usageMetadata)) return undefined
  const inputTokens = usageMetadata['input_tokens']
  const outputTokens = usageMetadata['output_tokens']
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return undefined
  }
  return { inputTokens, outputTokens }
}

const finishReasonsOf = (generations: readonly ChatGeneration[]): string[] =>
  generations
    .map((g) => generationInfoString(g, 'finish_reason'))
    .filter((r): r is string => r !== undefined)

const outputMessagesOf = (
  generations: readonly ChatGeneration[],
): GenAiOutputMessage[] =>
  generations.map((g): GenAiOutputMessage => {
    const base = messageToGenAiMessage(g.message)
    const finishReason = generationInfoString(g, 'finish_reason')
    return finishReason === undefined
      ? base
      : { ...base, finish_reason: finishReason }
  })

const requestModelOf = (
  extraParams: Record<string, unknown> | undefined,
): string | undefined => {
  const invocationParams = extraParams?.['invocation_params']
  if (!isRecord(invocationParams)) return undefined
  const model = invocationParams['model']
  return typeof model === 'string' && model.length > 0 ? model : undefined
}

const recordSpanException = (span: Span, error: unknown): void => {
  span.recordException(error instanceof Error ? error : String(error))
}

// One CLIENT span per model inference call (handleChatModelStart -> handleLLMEnd
// / handleLLMError), matching the GenAI semantic conventions'
// `{gen_ai.operation.name} {gen_ai.request.model}` span. Ports the span
// contract of meshi's openCodeLlmClient.ts (HTTP-level) to the LangChain
// callback layer; the two implementations are intentionally not shared.
export class GenAiCallbackHandler extends BaseCallbackHandler {
  name = 'gen_ai_callback_handler'

  private readonly providerName: string
  private readonly captureMessageContent: boolean
  private readonly spansByRunId = new Map<string, Span>()

  constructor(options: GenAiCallbackHandlerOptions) {
    super()
    this.providerName = options.providerName
    this.captureMessageContent =
      options.captureMessageContent ??
      (options.env ?? process.env)[CAPTURE_MESSAGE_CONTENT_ENV_VAR] === 'true'
  }

  override handleChatModelStart(
    _llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const requestModel = requestModelOf(extraParams) ?? 'unknown'
    // Resolved per call (not cached at module scope): the OTel API's
    // ProxyTracer freezes its delegate on first use, so a module-level
    // tracer captured before the SDK registers a provider would keep
    // pointing at whatever provider was active at that first call forever.
    const span = trace
      .getTracer(TRACER_NAME)
      .startSpan(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${requestModel}`, {
        kind: SpanKind.CLIENT,
      })
    span.setAttributes({
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      [ATTR_GEN_AI_PROVIDER_NAME]: this.providerName,
      [ATTR_GEN_AI_REQUEST_MODEL]: requestModel,
    })
    if (this.captureMessageContent) {
      try {
        const inputMessages = (messages[0] ?? []).map(messageToGenAiMessage)
        span.setAttribute(
          ATTR_GEN_AI_INPUT_MESSAGES,
          JSON.stringify(inputMessages),
        )
      } catch (error) {
        recordSpanException(span, error)
      }
    }
    this.spansByRunId.set(runId, span)
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const span = this.spansByRunId.get(runId)
    if (span === undefined) return
    this.spansByRunId.delete(runId)

    try {
      const generations = chatGenerationsOf(output)
      const first = generations[0]
      const responseModel = generationInfoString(first, 'model_name')
      if (responseModel !== undefined) {
        span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, responseModel)
      }
      const usage =
        first !== undefined ? usageTokensOf(first.message) : undefined
      if (usage !== undefined) {
        span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens)
        span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens)
      }
      const finishReasons = finishReasonsOf(generations)
      if (finishReasons.length > 0) {
        span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, finishReasons)
      }
      if (this.captureMessageContent) {
        span.setAttribute(
          ATTR_GEN_AI_OUTPUT_MESSAGES,
          JSON.stringify(outputMessagesOf(generations)),
        )
      }
    } catch (error) {
      recordSpanException(span, error)
    } finally {
      span.end()
    }
  }

  override handleLLMError(err: unknown, runId: string): void {
    const span = this.spansByRunId.get(runId)
    if (span === undefined) return
    this.spansByRunId.delete(runId)

    recordSpanException(span, err)
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    })
    span.end()
  }
}
