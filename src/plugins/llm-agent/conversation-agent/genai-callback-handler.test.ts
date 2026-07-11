import type { Serialized } from '@langchain/core/load/serializable'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages'
import type { ChatGeneration, LLMResult } from '@langchain/core/outputs'
import type { Attributes } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GenAiCallbackHandler } from '@/plugins/llm-agent/conversation-agent/genai-callback-handler'

const FAKE_SERIALIZED: Serialized = {
  lc: 1,
  type: 'not_implemented',
  id: ['test'],
}

const resultOf = (generations: ChatGeneration[]): LLMResult => ({
  generations: [generations],
})

interface SpanRow {
  readonly name: string
  readonly attributes: Attributes
  readonly statusCode: SpanStatusCode
}

let spanExporter: InMemorySpanExporter
let tracerProvider: BasicTracerProvider

const collectSpans = async (): Promise<readonly SpanRow[]> => {
  await tracerProvider.forceFlush()
  return spanExporter.getFinishedSpans().map((s) => ({
    name: s.name,
    attributes: s.attributes,
    statusCode: s.status.code,
  }))
}

beforeEach(() => {
  spanExporter = new InMemorySpanExporter()
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  })
  trace.setGlobalTracerProvider(tracerProvider)
})

afterEach(async () => {
  await tracerProvider.shutdown()
  trace.disable()
})

describe('GenAiCallbackHandler', () => {
  it('records a CLIENT span with GenAI attributes on success', async () => {
    const handler = new GenAiCallbackHandler({ providerName: 'opencode' })
    const aiMessage = new AIMessage({ content: 'hello there' })
    // AIMessage's usage_metadata is only typed through a generic structure
    // parameter that a plain `new AIMessage({...})` call can't infer;
    // Object.assign sidesteps that generic without weakening the field's
    // runtime shape (verified by genai-callback-handler.ts's own read path).
    Object.assign(aiMessage, {
      usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

    handler.handleChatModelStart(
      FAKE_SERIALIZED,
      [[new HumanMessage('hi')]],
      'run-1',
      undefined,
      { invocation_params: { model: 'opencode-go/gpt-5' } },
    )
    handler.handleLLMEnd(
      resultOf([
        {
          text: 'hello there',
          message: aiMessage,
          generationInfo: {
            finish_reason: 'stop',
            model_name: 'opencode-go/gpt-5-2025',
          },
        },
      ]),
      'run-1',
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.response.model': 'opencode-go/gpt-5-2025',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 5,
          'gen_ai.response.finish_reasons': ['stop'],
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('records an ERROR span on handleLLMError', async () => {
    const handler = new GenAiCallbackHandler({ providerName: 'opencode' })

    handler.handleChatModelStart(
      FAKE_SERIALIZED,
      [[new HumanMessage('hi')]],
      'run-err',
      undefined,
      { invocation_params: { model: 'opencode-go/gpt-5' } },
    )
    handler.handleLLMError(new Error('go usage limit'), 'run-err')

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
        },
        statusCode: SpanStatusCode.ERROR,
      },
    ])
  })

  it('omits message content by default', async () => {
    const handler = new GenAiCallbackHandler({ providerName: 'opencode' })
    const aiMessage = new AIMessage({ content: 'secret reply' })

    handler.handleChatModelStart(
      FAKE_SERIALIZED,
      [[new SystemMessage('persona'), new HumanMessage('secret question')]],
      'run-content',
      undefined,
      { invocation_params: { model: 'opencode-go/gpt-5' } },
    )
    handler.handleLLMEnd(
      resultOf([{ text: 'secret reply', message: aiMessage }]),
      'run-content',
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('captures redacted message content when opted in', async () => {
    const handler = new GenAiCallbackHandler({
      providerName: 'opencode',
      captureMessageContent: true,
    })
    const aiMessage = new AIMessage({ content: 'described the photo' })

    handler.handleChatModelStart(
      FAKE_SERIALIZED,
      [
        [
          new HumanMessage({
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', mimeType: 'image/jpeg', data: 'BASE64DATA' },
            ],
          }),
        ],
      ],
      'run-capture',
      undefined,
      { invocation_params: { model: 'opencode-go/gpt-5' } },
    )
    handler.handleLLMEnd(
      resultOf([
        {
          text: 'described the photo',
          message: aiMessage,
          generationInfo: { finish_reason: 'stop' },
        },
      ]),
      'run-capture',
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.response.finish_reasons': ['stop'],
          'gen_ai.input.messages': JSON.stringify([
            {
              role: 'user',
              parts: [
                { type: 'text', content: 'what is this?' },
                { type: 'text', content: '[image omitted]' },
              ],
            },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            {
              role: 'assistant',
              parts: [{ type: 'text', content: 'described the photo' }],
              finish_reason: 'stop',
            },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('captures a bare string element inside a content array as text', async () => {
    const handler = new GenAiCallbackHandler({
      providerName: 'opencode',
      captureMessageContent: true,
    })
    // BaseMessage['content'] is typed as string | ContentBlock[], but
    // @langchain/core's own BaseMessage#text getter defensively handles a
    // bare string inside that array too, so upstream message sources can
    // still produce this shape; the constructor won't accept it directly,
    // so it's assigned here to exercise it.
    const humanMessage = new HumanMessage('placeholder')
    Object.assign(humanMessage, { content: ['plain string element'] })

    handler.handleChatModelStart(
      FAKE_SERIALIZED,
      [[humanMessage]],
      'run-plain-string',
      undefined,
      { invocation_params: { model: 'opencode-go/gpt-5' } },
    )
    handler.handleLLMEnd(
      resultOf([{ text: 'ok', message: new AIMessage('ok') }]),
      'run-plain-string',
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            {
              role: 'user',
              parts: [{ type: 'text', content: 'plain string element' }],
            },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('ignores handleLLMEnd/handleLLMError for an unknown run id', async () => {
    const handler = new GenAiCallbackHandler({ providerName: 'opencode' })

    handler.handleLLMEnd(
      resultOf([{ text: '', message: new AIMessage('x') }]),
      'no-such-run',
    )
    handler.handleLLMError(new Error('boom'), 'no-such-run')

    expect(await collectSpans()).toEqual([])
  })
})
