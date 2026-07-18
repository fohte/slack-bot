import { MemorySaver } from '@langchain/langgraph'
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai'
import { tool } from 'langchain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { LogFields, Logger } from '@/logger/logger'
import { createRecordingChatModel } from '@/plugins/llm-agent/conversation-agent/_test-utils'
import { createConversationAgent } from '@/plugins/llm-agent/conversation-agent/conversation-agent'

const createRecordingLogger = (): Logger & {
  readonly warnCalls: LogFields[]
} => {
  const warnCalls: LogFields[] = []
  return {
    warnCalls,
    debug: () => undefined,
    info: () => undefined,
    warn: (fields) => {
      warnCalls.push(fields)
    },
    error: () => undefined,
    child() {
      return this
    },
  }
}

describe('createConversationAgent', () => {
  it('returns the model reply as text with no delegations', async () => {
    const model = createRecordingChatModel(() => 'hello from the model')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(outcome).toEqual({
      text: 'hello from the model',
      delegations: [],
    })
  })

  it('strips a <think> block from the model reply before returning it', async () => {
    const model = createRecordingChatModel(
      () => '<think>\nreasoning\n</think>\nhello from the model',
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(outcome).toEqual({
      text: 'hello from the model',
      delegations: [],
    })
  })

  it('logs a warning when a <think> block had to be stripped', async () => {
    const model = createRecordingChatModel(
      () => '<think>reasoning</think>hello from the model',
    )
    const logger = createRecordingLogger()
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      logger,
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(logger.warnCalls).toEqual([
      {
        event: 'llm_agent_think_block_leaked',
        slack_event_id: 'Ev1',
      },
    ])
  })

  it('does not log a warning when the reply has no <think> block', async () => {
    const model = createRecordingChatModel(() => 'hello from the model')
    const logger = createRecordingLogger()
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      logger,
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(logger.warnCalls).toEqual([])
  })

  it('continues multi-turn context via the checkpointer', async () => {
    const model = createRecordingChatModel(
      (_messages, callIndex) => `reply-${String(callIndex)}`,
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })
    const threadId = 'T1:C1:111.222'

    await agent.respond({
      threadId,
      userText: 'first turn',
      images: [],
      slackEventId: 'Ev1',
    })
    await agent.respond({
      threadId,
      userText: 'second turn',
      images: [],
      slackEventId: 'Ev2',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.text])),
    ).toEqual([
      [['human', 'first turn']],
      [
        ['human', 'first turn'],
        ['ai', 'reply-0'],
        ['human', 'second turn'],
      ],
    ])
  })

  it('keeps separate threads independent', async () => {
    const model = createRecordingChatModel(
      (_messages, callIndex) => `reply-${String(callIndex)}`,
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'thread one turn',
      images: [],
      slackEventId: 'Ev1',
    })
    await agent.respond({
      threadId: 'T1:C2:333.444',
      userText: 'thread two turn',
      images: [],
      slackEventId: 'Ev2',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.text])),
    ).toEqual([[['human', 'thread one turn']], [['human', 'thread two turn']]])
  })

  it('embeds resized images as base64 content blocks alongside the text', async () => {
    const model = createRecordingChatModel(() => 'described the photo')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'what is this?',
      images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
      slackEventId: 'Ev1',
    })

    expect(outcome.text).toBe('described the photo')
    const [humanMessage] = model.calls[0] ?? []
    expect(humanMessage?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
    ])
  })

  // Guards against images silently becoming invisible to the model:
  // @langchain/openai only routes content through its standard-block-aware
  // converter when response_metadata.output_version is 'v1', which only
  // `contentBlocks` (not `content`) sets. The 'embeds resized images as
  // base64 content blocks alongside the text' test above can't catch that
  // on its own, since both fields end up holding the same array; this
  // asserts on the actual OpenAI wire format the image must reach to be
  // visible to the model.
  it('converts the image content block to an OpenAI image_url part', async () => {
    const model = createRecordingChatModel(() => 'described the photo')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'what is this?',
      images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
      slackEventId: 'Ev1',
    })

    const [humanMessage] = model.calls[0] ?? []
    expect(
      convertMessagesToCompletionsMessageParams({
        messages: humanMessage ? [humanMessage] : [],
      }),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,AAAA' },
          },
        ],
      },
    ])
  })

  it('prepends the persona prompt as a system message', async () => {
    const model = createRecordingChatModel(() => 'ok')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      personaPrompt: 'You are a cheerful assistant.',
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.text])),
    ).toEqual([
      [
        ['system', 'You are a cheerful assistant.'],
        ['human', 'hi'],
      ],
    ])
  })

  // A stub delegation tool exercising the same content_and_artifact
  // contract real delegation tools use (see remote-agent-registry), without
  // depending on that module's construction details.
  const stubDelegationTool = (onInvoke?: (context: unknown) => void) =>
    tool(
      async (
        _input: { request: string },
        runtime: { context: unknown },
      ): Promise<[string, Record<string, string>]> => {
        onInvoke?.(runtime.context)
        return [
          'delegated',
          { agentName: 'meshi', taskId: 'task-1', contextId: 'ctx-1' },
        ]
      },
      {
        name: 'delegate_to_meshi',
        description: 'Delegate to meshi.',
        schema: z.object({ request: z.string() }),
        responseFormat: 'content_and_artifact',
      },
    )

  const toolCallReply = {
    toolCalls: [
      {
        name: 'delegate_to_meshi',
        args: { request: 'log my lunch' },
        id: 'call-1',
      },
    ],
  }

  it('threads slackEventId/threadKey/images into a delegation tool as runtime context', async () => {
    let capturedContext: unknown
    const model = createRecordingChatModel((_messages, callIndex) =>
      callIndex === 0 ? toolCallReply : 'handed off to meshi',
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      tools: [stubDelegationTool((context) => (capturedContext = context))],
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'log my lunch',
      images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
      slackEventId: 'Ev1',
    })

    expect(capturedContext).toEqual({
      slackEventId: 'Ev1',
      threadKey: {
        slackTeamId: 'T1',
        slackChannelId: 'C1',
        threadRootTs: '111.222',
      },
      images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
    })
  })

  it('surfaces a delegation tool call as a Delegation in the outcome', async () => {
    const model = createRecordingChatModel((_messages, callIndex) =>
      callIndex === 0 ? toolCallReply : 'handed off to meshi',
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      tools: [stubDelegationTool()],
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'log my lunch',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(outcome).toEqual({
      text: 'handed off to meshi',
      delegations: [
        { agentName: 'meshi', taskId: 'task-1', contextId: 'ctx-1' },
      ],
    })
  })

  it('does not re-report a prior turn delegation on a later turn with no new delegation', async () => {
    const model = createRecordingChatModel((_messages, callIndex) =>
      callIndex === 0 ? toolCallReply : 'ok, anything else?',
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      tools: [stubDelegationTool()],
    })
    const threadId = 'T1:C1:111.222'

    await agent.respond({
      threadId,
      userText: 'log my lunch',
      images: [],
      slackEventId: 'Ev1',
    })
    const secondOutcome = await agent.respond({
      threadId,
      userText: 'thanks',
      images: [],
      slackEventId: 'Ev2',
    })

    expect(secondOutcome).toEqual({
      text: 'ok, anything else?',
      delegations: [],
    })
  })

  // MCP tools (see mcp-tools/) are plain tool() functions with no
  // content_and_artifact contract, so a call that fails throws instead of
  // returning a description. createAgent's tool-calling node catches that
  // and reports it back to the model as a tool error.
  it('reports a thrown tool error back to the model instead of failing the turn', async () => {
    const failingTool = tool(
      async (): Promise<string> => {
        throw new Error('mgmt MCP server unreachable')
      },
      {
        name: 'list_strategies',
        description: 'List strategies.',
        schema: z.object({}),
      },
    )
    const model = createRecordingChatModel((_messages, callIndex) =>
      callIndex === 0
        ? {
            toolCalls: [{ name: 'list_strategies', args: {}, id: 'call-1' }],
          }
        : 'Sorry, I could not list the strategies just now.',
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      tools: [failingTool],
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'list my strategies',
      images: [],
      slackEventId: 'Ev1',
    })

    expect(outcome).toEqual({
      text: 'Sorry, I could not list the strategies just now.',
      delegations: [],
    })
    // The exact error-wrapping text (e.g. "Error: ...\n Please fix your
    // mistakes.") is createAgent's own tool-error formatting, not this
    // repo's, so only the message sequence is asserted here.
    expect((model.calls[1] ?? []).map((m) => m.type)).toEqual([
      'human',
      'ai',
      'tool',
    ])
  })
})
