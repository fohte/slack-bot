import { MemorySaver } from '@langchain/langgraph'
import { tool } from 'langchain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createRecordingChatModel } from '@/plugins/llm-agent/conversation-agent/_test-utils'
import { createConversationAgent } from '@/plugins/llm-agent/conversation-agent/conversation-agent'

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

  it('threads slackEventId/threadKey/images into a delegation tool and surfaces its Delegation artifact', async () => {
    let capturedContext: unknown
    const delegateTool = tool(
      async (
        _input: { request: string },
        runtime: { context: unknown },
      ): Promise<[string, Record<string, string>]> => {
        capturedContext = runtime.context
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
    const model = createRecordingChatModel((_messages, callIndex) =>
      callIndex === 0
        ? {
            toolCalls: [
              {
                name: 'delegate_to_meshi',
                args: { request: 'log my lunch' },
                id: 'call-1',
              },
            ],
          }
        : 'handed off to meshi',
    )
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      tools: [delegateTool],
    })

    const outcome = await agent.respond({
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
    expect(outcome).toEqual({
      text: 'handed off to meshi',
      delegations: [
        { agentName: 'meshi', taskId: 'task-1', contextId: 'ctx-1' },
      ],
    })
  })
})
