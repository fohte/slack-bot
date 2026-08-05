import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { MemorySaver } from '@langchain/langgraph'
import { tool } from 'langchain'
import { err, ok } from 'neverthrow'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { LogFields, Logger } from '#logger/logger'
import { createRecordingChatModel } from '#plugins/llm-agent/conversation-agent/_test-utils'
import { createConversationAgent } from '#plugins/llm-agent/conversation-agent/conversation-agent'
import {
  ConversationAgentGetThreadCursorError,
  ConversationAgentInvokeError,
  ConversationThreadIdParseError,
} from '#types/errors'

// Asia/Tokyo is UTC+9 year-round, so this always renders as
// 2026-08-05T12:34:56+09:00 (see CURRENT_DATETIME_META_TEXT below).
const FIXED_NOW = () => new Date('2026-08-05T03:34:56.000Z')
const CURRENT_DATETIME_META_TEXT =
  '(meta: current_datetime=2026-08-05T12:34:56+09:00, timezone=Asia/Tokyo)'
const CURRENT_DATETIME_META_BLOCK = {
  type: 'text',
  text: CURRENT_DATETIME_META_TEXT,
}
const CURRENT_DATETIME_INSTRUCTION =
  'Every message from the user starts with a ' +
  '`(meta: current_datetime=<ISO 8601>, timezone=<IANA name>)` line. Treat ' +
  'current_datetime as the actual current date and time, in the given ' +
  'timezone, at the moment the user sent the message. Anchor every date or ' +
  'time you resolve to it — including relative expressions such as ' +
  '"today"/"yesterday" or a bare month/day such as "7/27" that omits the ' +
  'year — instead of guessing from anything else.'
const SYSTEM_MESSAGE_ENTRY = ['system', CURRENT_DATETIME_INSTRUCTION]

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const CONVERSATION_AGENT_INVOKE_FINGERPRINT =
  'llm-agent.conversation-agent.invoke-failed'
const CONVERSATION_AGENT_GET_THREAD_CURSOR_FINGERPRINT =
  'llm-agent.conversation-agent.get-thread-cursor-failed'

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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the model reply as text with no delegations', async () => {
    const model = createRecordingChatModel(() => 'hello from the model')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(outcome).toEqual(
      ok({
        text: 'hello from the model',
        delegations: [],
      }),
    )
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
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(outcome).toEqual(
      ok({
        text: 'hello from the model',
        delegations: [],
      }),
    )
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
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
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
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
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
      now: FIXED_NOW,
    })
    const threadId = 'T1:C1:111.222'

    await agent.respond({
      threadId,
      userText: 'first turn',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })
    await agent.respond({
      threadId,
      userText: 'second turn',
      imageDescription: undefined,
      slackEventId: 'Ev2',
      triggerTs: '111.222',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.text])),
    ).toEqual([
      [
        SYSTEM_MESSAGE_ENTRY,
        ['human', `${CURRENT_DATETIME_META_TEXT}first turn`],
      ],
      [
        SYSTEM_MESSAGE_ENTRY,
        ['human', `${CURRENT_DATETIME_META_TEXT}first turn`],
        ['ai', 'reply-0'],
        ['human', `${CURRENT_DATETIME_META_TEXT}second turn`],
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
      now: FIXED_NOW,
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'thread one turn',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })
    await agent.respond({
      threadId: 'T1:C2:333.444',
      userText: 'thread two turn',
      imageDescription: undefined,
      slackEventId: 'Ev2',
      triggerTs: '333.444',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.text])),
    ).toEqual([
      [
        SYSTEM_MESSAGE_ENTRY,
        ['human', `${CURRENT_DATETIME_META_TEXT}thread one turn`],
      ],
      [
        SYSTEM_MESSAGE_ENTRY,
        ['human', `${CURRENT_DATETIME_META_TEXT}thread two turn`],
      ],
    ])
  })

  it('embeds the image description as a text block alongside the user text, never as raw image bytes', async () => {
    const model = createRecordingChatModel(() => 'described the photo')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      now: FIXED_NOW,
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'what is this?',
      imageDescription: '[画像 1] a photo of a receipt',
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(outcome._unsafeUnwrap().text).toBe('described the photo')
    const [, humanMessage] = model.calls[0] ?? []
    expect(humanMessage?.content).toEqual([
      CURRENT_DATETIME_META_BLOCK,
      { type: 'text', text: 'what is this?' },
      {
        type: 'text',
        text: '<attached_images>\n[画像 1] a photo of a receipt\n</attached_images>',
      },
    ])
  })

  // Asserts on `content` (not `text`) because the `text` getter normalizes
  // both string and multi-part content to the same string, which would hide
  // a regression to multi-part content — the shape an upstream model used in
  // production (gpt-5.6-luna via OpenCode Go's Zen gateway) silently drops
  // the entire system prompt for.
  it('prepends the persona prompt as a system message with string content', async () => {
    const model = createRecordingChatModel(() => 'ok')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      personaPrompt: 'You are a cheerful assistant.',
      now: FIXED_NOW,
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.content])),
    ).toEqual([
      [
        [
          'system',
          `You are a cheerful assistant.\n\n${CURRENT_DATETIME_INSTRUCTION}`,
        ],
        ['human', [CURRENT_DATETIME_META_BLOCK, { type: 'text', text: 'hi' }]],
      ],
    ])
  })

  it('includes the current-datetime instruction in the system message even with no persona prompt', async () => {
    const model = createRecordingChatModel(() => 'ok')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
      now: FIXED_NOW,
    })

    await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.content])),
    ).toEqual([
      [
        ['system', CURRENT_DATETIME_INSTRUCTION],
        ['human', [CURRENT_DATETIME_META_BLOCK, { type: 'text', text: 'hi' }]],
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

  it('threads slackEventId/threadKey/imageDescription into a delegation tool as runtime context', async () => {
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
      imageDescription: '[画像 1] a photo of a receipt',
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(capturedContext).toEqual({
      slackEventId: 'Ev1',
      threadKey: {
        slackTeamId: 'T1',
        slackChannelId: 'C1',
        threadRootTs: '111.222',
      },
      imageDescription: '[画像 1] a photo of a receipt',
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
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(outcome).toEqual(
      ok({
        text: 'handed off to meshi',
        delegations: [
          { agentName: 'meshi', taskId: 'task-1', contextId: 'ctx-1' },
        ],
      }),
    )
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
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })
    const secondOutcome = await agent.respond({
      threadId,
      userText: 'thanks',
      imageDescription: undefined,
      slackEventId: 'Ev2',
      triggerTs: '111.222',
    })

    expect(secondOutcome).toEqual(
      ok({
        text: 'ok, anything else?',
        delegations: [],
      }),
    )
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
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(outcome).toEqual(
      ok({
        text: 'Sorry, I could not list the strategies just now.',
        delegations: [],
      }),
    )
    // The exact error-wrapping text (e.g. "Error: ...\n Please fix your
    // mistakes.") is toolErrorMiddleware's onError formatting, which mirrors
    // createAgent's own default but isn't this test's concern, so only the
    // message sequence is asserted here.
    expect((model.calls[1] ?? []).map((m) => m.type)).toEqual([
      'system',
      'human',
      'ai',
      'tool',
    ])
  })

  it('returns an Err with ConversationThreadIdParseError for a malformed threadId', async () => {
    const model = createRecordingChatModel(() => 'hello')
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    const outcome = await agent.respond({
      threadId: 'not-a-valid-thread-id',
      userText: 'hi',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    expect(outcome).toEqual(
      err(new ConversationThreadIdParseError('not-a-valid-thread-id')),
    )
    expect(vi.mocked(captureWithFingerprint)).not.toHaveBeenCalled()
  })

  it('reports a model invoke failure to Sentry and returns a ConversationAgentInvokeError', async () => {
    const model = createRecordingChatModel(() => {
      throw new Error('llm unreachable')
    })
    const agent = createConversationAgent({
      model,
      checkpointer: new MemorySaver(),
    })

    const outcome = await agent.respond({
      threadId: 'T1:C1:111.222',
      userText: 'hi',
      imageDescription: undefined,
      slackEventId: 'Ev1',
      triggerTs: '111.222',
    })

    const error = outcome._unsafeUnwrapErr()
    expect(error).toBeInstanceOf(ConversationAgentInvokeError)
    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [
        error,
        CONVERSATION_AGENT_INVOKE_FINGERPRINT,
        { extras: { threadId: 'T1:C1:111.222', slackEventId: 'Ev1' } },
      ],
    ])
  })

  describe('current datetime injection', () => {
    it('formats the current-datetime meta block in Asia/Tokyo regardless of the UTC calendar date', async () => {
      const model = createRecordingChatModel(() => 'ok')
      const agent = createConversationAgent({
        model,
        checkpointer: new MemorySaver(),
        // 2026-08-04T15:00:00Z is 2026-08-05T00:00:00+09:00: crosses into
        // the next calendar day once converted to Asia/Tokyo.
        now: () => new Date('2026-08-04T15:00:00.000Z'),
      })

      await agent.respond({
        threadId: 'T1:C1:111.222',
        userText: 'hi',
        imageDescription: undefined,
        slackEventId: 'Ev1',
        triggerTs: '111.222',
      })

      const [, humanMessage] = model.calls[0] ?? []
      expect(humanMessage?.content).toEqual([
        {
          type: 'text',
          text: '(meta: current_datetime=2026-08-05T00:00:00+09:00, timezone=Asia/Tokyo)',
        },
        { type: 'text', text: 'hi' },
      ])
    })
  })

  describe('thread context injection', () => {
    it('prepends the thread context text block ahead of the user text block, wrapping the context image description and the turn own image description in distinct tags', async () => {
      const model = createRecordingChatModel(() => 'ok')
      const agent = createConversationAgent({
        model,
        checkpointer: new MemorySaver(),
        now: FIXED_NOW,
      })

      await agent.respond({
        threadId: 'T1:C1:111.222',
        userText: 'what happened?',
        imageDescription: '[画像 1] a photo of a receipt',
        slackEventId: 'Ev1',
        triggerTs: '111.222',
        threadContext: {
          text: '<thread_context>\n[2026-01-01T00:00:00.000Z] <@U2>: retry [画像 1]\n</thread_context>',
          imageDescription: '[画像 1] a photo of a cat',
          contextMaxTs: '100.000',
        },
      })

      const [, humanMessage] = model.calls[0] ?? []
      expect(humanMessage?.content).toEqual([
        CURRENT_DATETIME_META_BLOCK,
        {
          type: 'text',
          text: '<thread_context>\n[2026-01-01T00:00:00.000Z] <@U2>: retry [画像 1]\n</thread_context>',
        },
        { type: 'text', text: 'what happened?' },
        {
          type: 'text',
          text: '<thread_context_images>\n[画像 1] a photo of a cat\n</thread_context_images>',
        },
        {
          type: 'text',
          text: '<attached_images>\n[画像 1] a photo of a receipt\n</attached_images>',
        },
      ])
    })

    it('tags additional_kwargs.slack with turnTs and contextMaxTs', async () => {
      const model = createRecordingChatModel(() => 'ok')
      const agent = createConversationAgent({
        model,
        checkpointer: new MemorySaver(),
      })

      await agent.respond({
        threadId: 'T1:C1:111.222',
        userText: 'hi',
        imageDescription: undefined,
        slackEventId: 'Ev1',
        triggerTs: '111.222',
        threadContext: {
          text: undefined,
          imageDescription: undefined,
          contextMaxTs: '100.000',
        },
      })

      const [, humanMessage] = model.calls[0] ?? []
      expect(humanMessage?.additional_kwargs).toEqual({
        slack: { turnTs: '111.222', contextMaxTs: '100.000' },
      })
    })

    it('omits contextMaxTs from the tag when threadContext is absent', async () => {
      const model = createRecordingChatModel(() => 'ok')
      const agent = createConversationAgent({
        model,
        checkpointer: new MemorySaver(),
      })

      await agent.respond({
        threadId: 'T1:C1:111.222',
        userText: 'hi',
        imageDescription: undefined,
        slackEventId: 'Ev1',
        triggerTs: '111.222',
      })

      const [, humanMessage] = model.calls[0] ?? []
      expect(humanMessage?.additional_kwargs).toEqual({
        slack: { turnTs: '111.222' },
      })
    })
  })

  describe('getThreadCursor', () => {
    it('returns undefined for a thread with no checkpoint yet', async () => {
      const agent = createConversationAgent({
        model: createRecordingChatModel(() => 'ok'),
        checkpointer: new MemorySaver(),
      })

      expect(await agent.getThreadCursor('T1:C1:999.999')).toEqual(
        ok(undefined),
      )
    })

    it("returns the latest turn's turnTs after a turn with no thread context", async () => {
      const agent = createConversationAgent({
        model: createRecordingChatModel(() => 'ok'),
        checkpointer: new MemorySaver(),
      })
      const threadId = 'T1:C1:111.222'

      await agent.respond({
        threadId,
        userText: 'hi',
        imageDescription: undefined,
        slackEventId: 'Ev1',
        triggerTs: '111.222',
      })

      expect(await agent.getThreadCursor(threadId)).toEqual(ok('111.222'))
    })

    // contextMaxTs never legitimately exceeds its own turn's triggerTs (the
    // fetch range that produces it is always upper-bounded by the trigger),
    // so a realistic call can't distinguish "cursor reads turnTs" from
    // "cursor reads max(turnTs, contextMaxTs)". This deliberately passes an
    // out-of-range contextMaxTs to prove computeThreadCursor actually folds
    // it in, not just turnTs.
    it("folds a turn's contextMaxTs into the cursor alongside turnTs", async () => {
      const agent = createConversationAgent({
        model: createRecordingChatModel(() => 'ok'),
        checkpointer: new MemorySaver(),
      })
      const threadId = 'T1:C1:111.222'

      await agent.respond({
        threadId,
        userText: 'hi',
        imageDescription: undefined,
        slackEventId: 'Ev1',
        triggerTs: '111.222',
        threadContext: {
          text: undefined,
          imageDescription: undefined,
          contextMaxTs: '999.999',
        },
      })

      expect(await agent.getThreadCursor(threadId)).toEqual(ok('999.999'))
    })

    it('advances across multiple turns to the newest turnTs', async () => {
      const agent = createConversationAgent({
        model: createRecordingChatModel(() => 'ok'),
        checkpointer: new MemorySaver(),
      })
      const threadId = 'T1:C1:111.222'

      await agent.respond({
        threadId,
        userText: 'first',
        imageDescription: undefined,
        slackEventId: 'Ev1',
        triggerTs: '111.222',
      })
      await agent.respond({
        threadId,
        userText: 'second',
        imageDescription: undefined,
        slackEventId: 'Ev2',
        triggerTs: '222.333',
      })

      expect(await agent.getThreadCursor(threadId)).toEqual(ok('222.333'))
    })

    it('reports a getState failure to Sentry and returns a ConversationAgentGetThreadCursorError', async () => {
      class ThrowingCheckpointSaver extends MemorySaver {
        override async getTuple(): Promise<never> {
          throw new Error('checkpoint store unreachable')
        }
      }
      const agent = createConversationAgent({
        model: createRecordingChatModel(() => 'ok'),
        checkpointer: new ThrowingCheckpointSaver(),
      })

      const outcome = await agent.getThreadCursor('T1:C1:111.222')

      const error = outcome._unsafeUnwrapErr()
      expect(error).toBeInstanceOf(ConversationAgentGetThreadCursorError)
      expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
        [
          error,
          CONVERSATION_AGENT_GET_THREAD_CURSOR_FINGERPRINT,
          { extras: { threadId: 'T1:C1:111.222' } },
        ],
      ])
    })
  })
})
