import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from '@langchain/core/messages'
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
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
import { createMiddleware } from 'langchain'

// Mirrors the env var used by other OpenTelemetry GenAI instrumentations
// (e.g. opentelemetry-instrumentation-openai-v2, Elastic's EDOT Node.js SDK)
// to gate capture of message content, which is opt-in per the GenAI semantic
// conventions because it may contain PII.
const CAPTURE_MESSAGE_CONTENT_ENV_VAR =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'

const TRACER_NAME = 'slack-bot-conversation-agent'

export interface GenAiTracingMiddlewareOptions {
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
    if (typeof block === 'string') {
      return { type: 'text', content: block }
    }
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

// AIMessage#response_metadata is typed as Record<string, any>: chat model
// integrations (e.g. @langchain/openai) merge their provider-specific
// response fields (finish_reason, model_name, ...) into it uniformly,
// whether the call streamed internally or not.
const responseMetadataString = (
  message: AIMessage,
  key: string,
): string | undefined => {
  const value: unknown = message.response_metadata[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

interface UsageTokens {
  readonly inputTokens: number
  readonly outputTokens: number
}

// AIMessage#usage_metadata is typed through a generic MessageStructure that
// resolves to `undefined` unless the message was constructed with an
// explicit structure parameter, which a handler-returned AIMessage never
// carries — so this reads the field at runtime instead of through the
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

const outputMessagesOf = (message: AIMessage): GenAiOutputMessage[] => {
  const base = messageToGenAiMessage(message)
  const finishReason = responseMetadataString(message, 'finish_reason')
  return [
    finishReason === undefined
      ? base
      : { ...base, finish_reason: finishReason },
  ]
}

// request.model is typed as the generic AgentLanguageModelLike (a bare
// Runnable), but chat model integrations (e.g. ChatOpenAI) expose the
// requested model id as a public `model` field, so this reads it at runtime
// instead of through that uninformative static type.
const requestModelOf = (model: unknown): string | undefined => {
  if (!isRecord(model)) return undefined
  const value = model['model']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const recordSpanException = (span: Span, error: unknown): void => {
  span.recordException(error instanceof Error ? error : String(error))
}

// One CLIENT span per model inference call, matching the GenAI semantic
// conventions' `{gen_ai.operation.name} {gen_ai.request.model}` span. Wraps
// the actual model invocation (langchain's wrapModelCall middleware hook)
// so the span stays active in context for the call's duration, letting any
// HTTP instrumentation spans it produces (e.g. undici's span for the
// underlying fetch) nest under it as children rather than landing as
// unrelated siblings. Ports the span contract of meshi's
// openCodeLlmClient.ts (HTTP-level) to the LangChain middleware layer; the
// two implementations are intentionally not shared.
export const createGenAiTracingMiddleware = (
  options: GenAiTracingMiddlewareOptions,
) => {
  const providerName = options.providerName
  const captureMessageContent =
    options.captureMessageContent ??
    (options.env ?? process.env)[CAPTURE_MESSAGE_CONTENT_ENV_VAR] === 'true'

  return createMiddleware({
    name: 'GenAiTracingMiddleware',
    wrapModelCall: async (request, handler) => {
      const requestModel = requestModelOf(request.model) ?? 'unknown'
      // Resolved per call (not cached at module scope): the OTel API's
      // ProxyTracer freezes its delegate on first use, so a module-level
      // tracer captured before the SDK registers a provider would keep
      // pointing at whatever provider was active at that first call forever.
      const tracer = trace.getTracer(TRACER_NAME)
      // eslint-disable-next-line no-restricted-syntax -- put into the active context via context.with() below, so spans created during the model call (e.g. undici's HTTP span) nest under it correctly
      const span = tracer.startSpan(
        `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${requestModel}`,
        { kind: SpanKind.CLIENT },
      )
      span.setAttributes({
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_PROVIDER_NAME]: providerName,
        [ATTR_GEN_AI_REQUEST_MODEL]: requestModel,
      })
      if (captureMessageContent) {
        // eslint-disable-next-line no-restricted-syntax -- boundary: input-message capture must not fail the model call itself; a serialization error is recorded on the span and swallowed
        try {
          const inputMessages = request.messages.map(messageToGenAiMessage)
          span.setAttribute(
            ATTR_GEN_AI_INPUT_MESSAGES,
            JSON.stringify(inputMessages),
          )
        } catch (error) {
          recordSpanException(span, error)
        }
      }

      const spanContext = trace.setSpan(context.active(), span)
      // eslint-disable-next-line no-restricted-syntax -- boundary: wraps LangChain's throw-based wrapModelCall handler contract; finally guarantees span.end() runs even when the model call throws
      try {
        const response = await context.with(spanContext, () => handler(request))
        // eslint-disable-next-line no-restricted-syntax -- boundary: response-attribute capture must not fail the model call itself; a serialization error is recorded on the span and swallowed
        try {
          const responseModel = responseMetadataString(response, 'model_name')
          if (responseModel !== undefined) {
            span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, responseModel)
          }
          const usage = usageTokensOf(response)
          if (usage !== undefined) {
            span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens)
            span.setAttribute(
              ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
              usage.outputTokens,
            )
          }
          const finishReason = responseMetadataString(response, 'finish_reason')
          if (finishReason !== undefined) {
            span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [
              finishReason,
            ])
          }
          if (captureMessageContent) {
            span.setAttribute(
              ATTR_GEN_AI_OUTPUT_MESSAGES,
              JSON.stringify(outputMessagesOf(response)),
            )
          }
        } catch (error) {
          recordSpanException(span, error)
        }
        return response
      } catch (error) {
        recordSpanException(span, error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
        // eslint-disable-next-line no-restricted-syntax -- boundary: LangChain's wrapModelCall middleware contract requires either returning the handler's result or re-throwing its error
        throw error
      } finally {
        span.end()
      }
    },
  })
}
