import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  cardFor,
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createScriptedEventLogStore,
  createStubSlackClient,
  recordingHandleFor,
  taskResult,
  TEST_ENV,
  TEST_THREAD_KEY,
} from '@/plugins/llm-agent/_test-utils'
import type { A2aTaskRow } from '@/plugins/llm-agent/a2a-task-tracker'
import type { TaskDispatcherOptions } from '@/plugins/llm-agent/dispatcher'
import {
  createTaskDispatcher,
  envelopeFromAccepted,
  resolveInlineImageFiles,
} from '@/plugins/llm-agent/dispatcher'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import { DISPATCH_FAILURE_TEXT } from '@/plugins/llm-agent/steps/report-dispatch-failure'
import { createDeferred } from '@/server/_test-utils'
import { createInFlightTasks } from '@/server/in-flight-tasks'
import type { SlackWebClient } from '@/slack/web-client'
import type {
  SlackAppMentionEvent,
  SlackEventCallback,
  SlackFile,
  SlackMessageEvent,
} from '@/types/slack-payloads'

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger
  },
}

const acceptedMention = (
  override: Partial<SlackAppMentionEvent> = {},
  envelopeOverride: Partial<Record<keyof SlackEventCallback, unknown>> = {},
): LlmAgentAcceptedEvent => {
  const event: SlackAppMentionEvent = {
    type: 'app_mention',
    user: 'U_USER',
    text: '<@U_BOT> hello bot',
    ts: '111.222',
    channel: 'C1',
    event_ts: '111.222',
    ...override,
  }
  const envelope = {
    type: 'event_callback',
    token: 'T',
    team_id: 'T1',
    api_app_id: 'A',
    event,
    event_id: 'Ev1',
    event_time: 1,
    authorizations: [],
    is_ext_shared_channel: false,
    ...envelopeOverride,
  } as unknown as SlackEventCallback
  return { ctx: { envelope }, event }
}

const baseOptions = (
  overrides: Partial<TaskDispatcherOptions> = {},
): TaskDispatcherOptions => ({
  conversationAgent: createFakeConversationAgent(() => ({
    text: 'hi there',
    delegations: [],
  })),
  remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
  a2aTaskTracker: createFakeA2aTaskTracker(),
  eventLogStore: createScriptedEventLogStore(),
  slackClient: createStubSlackClient(),
  logger: noopLogger,
  ...overrides,
})

const ACTIVE_TASK: A2aTaskRow = {
  ...TEST_THREAD_KEY,
  taskId: 'task-1',
  contextId: 'ctx-1',
  agentName: 'meshi',
  slackEventId: 'Ev0',
  state: 'input-required',
  settled: false,
  deadlineAt: new Date('2026-01-01T00:15:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

describe('envelopeFromAccepted', () => {
  it('strips a plain mention prefix and returns the channel / team / thread root', () => {
    expect(envelopeFromAccepted(acceptedMention(), noopLogger)).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'hello bot',
      images: [],
    })
  })

  it('strips a labelled mention prefix `<@U|name>`', () => {
    expect(
      envelopeFromAccepted(
        acceptedMention({ text: '<@U_BOT|slack-bot> please help' }),
        noopLogger,
      ),
    ).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'please help',
      images: [],
    })
  })

  it('uses thread_ts when present so replies stay anchored to the original thread root', () => {
    expect(
      envelopeFromAccepted(
        acceptedMention({ ts: '333.444', thread_ts: '111.222' }),
        noopLogger,
      ),
    ).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'hello bot',
      images: [],
    })
  })

  it('returns undefined when event_id is absent (so the dispatcher swallows the event without throwing)', () => {
    expect(
      envelopeFromAccepted(
        acceptedMention({}, { event_id: undefined }),
        noopLogger,
      ),
    ).toBeUndefined()
  })

  it('returns undefined when required envelope fields are missing', () => {
    expect(
      envelopeFromAccepted(
        acceptedMention({}, { team_id: undefined }),
        noopLogger,
      ),
    ).toBeUndefined()
  })

  it('extracts image files and strips the mention prefix from an accepted file_share message event', () => {
    const event: SlackMessageEvent = {
      type: 'message',
      subtype: 'file_share',
      user: 'U_USER',
      text: '<@U_BOT> this is what I had for lunch',
      ts: '111.222',
      channel: 'C1',
      files: [
        { id: 'F1', mimetype: 'image/png' },
        { id: 'F2', mimetype: 'text/plain' },
      ],
    }
    const envelope = {
      type: 'event_callback',
      team_id: 'T1',
      event,
      event_id: 'Ev1',
      event_time: 1,
    } as unknown as SlackEventCallback
    const accepted: LlmAgentAcceptedEvent = { ctx: { envelope }, event }

    expect(envelopeFromAccepted(accepted, noopLogger)).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'this is what I had for lunch',
      images: [{ id: 'F1', mimetype: 'image/png' }],
    })
  })
})

describe('resolveInlineImageFiles', () => {
  it('returns the envelope unchanged when there is no inline file ID reference', async () => {
    const result = await resolveInlineImageFiles(
      TEST_ENV,
      createStubSlackClient(),
      noopLogger,
    )
    expect(result).toEqual(TEST_ENV)
  })

  it('resolves an inline file ID into an image attachment and strips it from the text', async () => {
    const imageFile: SlackFile = {
      id: 'F0BG20H5AVA',
      name: 'lunch.jpg',
      mimetype: 'image/jpeg',
      url_private: 'https://files.slack.com/lunch.jpg',
      channels: ['C1'],
    }
    const calls: string[] = []
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getFileInfo(fileId: string) {
        calls.push(fileId)
        return imageFile
      },
    } as SlackWebClient
    const env = {
      ...TEST_ENV,
      text: 'F0BG20H5AVA これ昼たべたから記録しといて',
    }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(result).toEqual({
      ...TEST_ENV,
      text: 'これ昼たべたから記録しといて',
      images: [imageFile],
    })
    expect(calls).toEqual(['F0BG20H5AVA'])
  })

  it('leaves the ID as plain text when the lookup fails', async () => {
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getFileInfo() {
        throw new Error('file_not_found')
      },
    } as SlackWebClient
    const env = { ...TEST_ENV, text: 'F0BG20H5AVA menu please' }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(result).toEqual(env)
  })

  it('leaves the text and images unchanged when the resolved file is not an image', async () => {
    const pdfFile: SlackFile = {
      id: 'F0BG20H5AVA',
      name: 'menu.pdf',
      mimetype: 'application/pdf',
    }
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getFileInfo() {
        return pdfFile
      },
    } as SlackWebClient
    const env = { ...TEST_ENV, text: 'F0BG20H5AVA menu please' }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(result).toEqual(env)
  })

  it('leaves the ID as plain text when the resolved file is not shared into this channel', async () => {
    const otherChannelFile: SlackFile = {
      id: 'F0BG20H5AVA',
      name: 'lunch.jpg',
      mimetype: 'image/jpeg',
      channels: ['C_OTHER'],
    }
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getFileInfo() {
        return otherChannelFile
      },
    } as SlackWebClient
    const env = { ...TEST_ENV, text: 'F0BG20H5AVA menu please' }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(result).toEqual(env)
  })

  it('does not duplicate a file already present via event.files', async () => {
    const existing: SlackFile = {
      id: 'F0BG20H5AVA',
      name: 'lunch.jpg',
      mimetype: 'image/jpeg',
      channels: ['C1'],
    }
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getFileInfo() {
        return existing
      },
    } as SlackWebClient
    const env = {
      ...TEST_ENV,
      text: 'F0BG20H5AVA これ',
      images: [existing],
    }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(result).toEqual({ ...TEST_ENV, text: 'これ', images: [existing] })
  })

  it('caps the number of inline file IDs resolved per message', async () => {
    const ids = Array.from({ length: 11 }, (_, i) =>
      `F${String(i).padStart(8, '0')}`.toUpperCase(),
    )
    const calls: string[] = []
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getFileInfo(fileId: string) {
        calls.push(fileId)
        return undefined
      },
    } as SlackWebClient
    const env = { ...TEST_ENV, text: ids.join(' ') }
    await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(calls).toEqual(ids.slice(0, 10))
  })
})

describe('createTaskDispatcher', () => {
  it('sets the initial thinking bubble before the conversation agent responds', async () => {
    const slackClient = createStubSlackClient()
    const dispatch = createTaskDispatcher(baseOptions({ slackClient }))

    await dispatch(acceptedMention())

    expect(slackClient.calls[0]).toEqual({
      kind: 'status',
      channel: 'C1',
      thread: '111.222',
      text: 'is thinking...',
      blocks: undefined,
      loadingMessages: ['Preparing your task…'],
    })
  })

  it('invokes the conversation agent and posts its reply when there is no active input-required task', async () => {
    const slackClient = createStubSlackClient()
    const conversationAgent = createFakeConversationAgent(() => ({
      text: 'sure, here is the answer',
      delegations: [],
    }))
    const inFlightTasks = createInFlightTasks()
    const dispatch = createTaskDispatcher(
      baseOptions({ slackClient, conversationAgent, inFlightTasks }),
    )

    await dispatch(acceptedMention())
    await inFlightTasks.waitForIdle()

    expect(conversationAgent.calls).toEqual([
      {
        threadId: 'T1:C1:111.222',
        userText: 'hello bot',
        images: [],
        slackEventId: 'Ev1',
      },
    ])
    expect(slackClient.calls).toEqual([
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: 'is thinking...',
        blocks: undefined,
        loadingMessages: ['Preparing your task…'],
      },
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: 'sure, here is the answer',
        blocks: [{ type: 'markdown', text: 'sure, here is the answer' }],
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
  })

  it('takes the resume path instead of the conversation agent when the thread has an active input-required task', async () => {
    const slackClient = createStubSlackClient()
    const conversationAgent = createFakeConversationAgent(() => {
      throw new Error('must not be called during a resume')
    })
    const { handle, calls } = recordingHandleFor(
      async () => taskResult({ status: { state: 'working' } }),
      cardFor({ name: 'meshi' }),
    )
    const inFlightTasks = createInFlightTasks()
    const dispatch = createTaskDispatcher(
      baseOptions({
        slackClient,
        conversationAgent,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        a2aTaskTracker: createFakeA2aTaskTracker({
          activeInputRequired: ACTIVE_TASK,
        }),
        randomUUID: () => 'generated-id',
        inFlightTasks,
      }),
    )

    await dispatch(acceptedMention({ text: '<@U_BOT> here is more info' }))
    await inFlightTasks.waitForIdle()

    expect(conversationAgent.calls).toEqual([])
    expect(calls).toEqual([
      {
        message: {
          kind: 'message',
          messageId: 'generated-id',
          role: 'user',
          contextId: 'ctx-1',
          taskId: 'task-1',
          parts: [{ kind: 'text', text: 'here is more info' }],
        },
        configuration: { blocking: false },
      },
    ])
    const resumeAckText =
      "Sent your reply to meshi. I'll follow up here once it's ready."
    expect(slackClient.calls.filter((c) => c.kind === 'post')).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: resumeAckText,
        blocks: [{ type: 'markdown', text: resumeAckText }],
        loadingMessages: undefined,
      },
    ])
  })

  it('does not post a second reply for a duplicate delivery of the same Slack event', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore()
    const inFlightTasks = createInFlightTasks()
    const dispatch = createTaskDispatcher(
      baseOptions({ slackClient, eventLogStore, inFlightTasks }),
    )

    await dispatch(acceptedMention())
    await inFlightTasks.waitForIdle()
    await dispatch(acceptedMention())
    await inFlightTasks.waitForIdle()

    expect(slackClient.calls.filter((c) => c.kind === 'post')).toHaveLength(1)
  })

  it('propagates a gating failure so the plugin layer can roll back event_log', async () => {
    const failure = new Error('db unavailable')
    const a2aTaskTracker = createFakeA2aTaskTracker()
    a2aTaskTracker.findActiveInputRequired = async () => {
      throw failure
    }
    const dispatch = createTaskDispatcher(baseOptions({ a2aTaskTracker }))

    await expect(dispatch(acceptedMention())).rejects.toBe(failure)
  })

  it('notifies the Slack thread and clears the assistant status when a gating failure occurs', async () => {
    const failure = new Error('db unavailable')
    const a2aTaskTracker = createFakeA2aTaskTracker()
    a2aTaskTracker.findActiveInputRequired = async () => {
      throw failure
    }
    const slackClient = createStubSlackClient()
    const dispatch = createTaskDispatcher(
      baseOptions({ slackClient, a2aTaskTracker }),
    )

    await dispatch(acceptedMention()).catch(() => {})

    expect(slackClient.calls).toEqual([
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: 'is thinking...',
        blocks: undefined,
        loadingMessages: ['Preparing your task…'],
      },
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: DISPATCH_FAILURE_TEXT,
        blocks: undefined,
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
  })

  it('notifies the Slack thread when the backgrounded mention processing throws unexpectedly', async () => {
    const slackClient = createStubSlackClient()
    const conversationAgent = createFakeConversationAgent(() => {
      throw new Error('LLM call exploded')
    })
    const inFlightTasks = createInFlightTasks()
    const dispatch = createTaskDispatcher(
      baseOptions({ slackClient, conversationAgent, inFlightTasks }),
    )

    await dispatch(acceptedMention())
    await inFlightTasks.waitForIdle()

    expect(slackClient.calls.slice(1)).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: DISPATCH_FAILURE_TEXT,
        blocks: undefined,
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
  })

  it('returns once the foreground gating step has run, leaving the LLM/A2A work in the background', async () => {
    const deferred = createDeferred<{ text: string; delegations: [] }>()
    const conversationAgent = createFakeConversationAgent(
      async () => deferred.promise,
    )
    const dispatch = createTaskDispatcher(baseOptions({ conversationAgent }))

    // conversationAgent never resolves; if the dispatcher were not
    // backgrounding it, this await would hang the test.
    await dispatch(acceptedMention())
    expect(conversationAgent.calls).toHaveLength(1)
  })
})

describe('createTaskDispatcher inFlightTasks tracking', () => {
  it('keeps the tracker non-idle until the backgrounded mention processing completes', async () => {
    const deferred = createDeferred<{ text: string; delegations: [] }>()
    const conversationAgent = createFakeConversationAgent(
      async () => deferred.promise,
    )
    const inFlightTasks = createInFlightTasks()
    const timeline: string[] = []
    const dispatch = createTaskDispatcher(
      baseOptions({ conversationAgent, inFlightTasks }),
    )

    await dispatch(acceptedMention())
    void inFlightTasks.waitForIdle().then(() => timeline.push('idle'))
    await Promise.resolve()
    timeline.push('checked-still-in-flight')

    deferred.resolve({ text: 'done', delegations: [] })
    await inFlightTasks.waitForIdle()
    expect(timeline).toEqual(['checked-still-in-flight', 'idle'])
  })
})

describe('createTaskDispatcher OTel span', () => {
  let spanExporter: InMemorySpanExporter
  let tracerProvider: BasicTracerProvider
  let contextManager: AsyncLocalStorageContextManager

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter()
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    trace.setGlobalTracerProvider(tracerProvider)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    contextManager = new AsyncLocalStorageContextManager()
    contextManager.enable()
    context.setGlobalContextManager(contextManager)
  })

  afterEach(async () => {
    await tracerProvider.shutdown()
    trace.disable()
    propagation.disable()
    context.disable()
    contextManager.disable()
  })

  it('wraps the dispatch in a slack.mention.handle span carrying Slack ID attributes', async () => {
    const dispatch = createTaskDispatcher(baseOptions())

    await dispatch(acceptedMention())

    const spans = spanExporter.getFinishedSpans()
    expect(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        statusCode: s.status.code,
      })),
    ).toEqual([
      {
        name: 'slack.mention.handle',
        attributes: {
          'slack.channel': 'C1',
          'slack.thread_ts': '111.222',
          'slack.event_id': 'Ev1',
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('records the exception on the span when the gating step fails', async () => {
    const failure = new Error('db unavailable')
    const a2aTaskTracker = createFakeA2aTaskTracker()
    a2aTaskTracker.findActiveInputRequired = async () => {
      throw failure
    }
    const dispatch = createTaskDispatcher(baseOptions({ a2aTaskTracker }))

    await dispatch(acceptedMention()).catch(() => {})

    const spans = spanExporter.getFinishedSpans()
    expect(
      spans.map((s) => ({
        name: s.name,
        statusCode: s.status.code,
        exceptionMessages: s.events
          .filter((e) => e.name === 'exception')
          .map((e) => e.attributes?.['exception.message']),
      })),
    ).toEqual([
      {
        name: 'slack.mention.handle',
        statusCode: SpanStatusCode.ERROR,
        exceptionMessages: ['db unavailable'],
      },
    ])
  })
})
