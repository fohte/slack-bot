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
  createScriptedTaskCrClient,
  createStubSlackClient,
  noopConfigMapClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import type { ConfigMapClient } from '@/plugins/llm-agent/configmap-client'
import {
  createTaskDispatcher,
  envelopeFromAccepted,
  resolveInlineImageFiles,
  runProcessMentionInBackground,
} from '@/plugins/llm-agent/dispatcher'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import type { SlackEnvelope } from '@/plugins/llm-agent/process-mention-deps'
import { DISPATCH_FAILURE_TEXT } from '@/plugins/llm-agent/steps/report-dispatch-failure'
import type {
  TaskCrClient,
  TaskCrCreateOutcome,
  TaskCrSpec,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type { ThreadSessionStore } from '@/plugins/llm-agent/thread-session-store'
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

// A single ordered tape of side-effects so order-sensitive contracts
// (e.g. "set the bubble before calling create") can be expressed as a
// single equality check.
type TimelineEntry =
  | { readonly kind: 'status'; readonly status: string }
  | { readonly kind: 'create'; readonly taskName: string }

const createTimeline = (): {
  readonly entries: TimelineEntry[]
  push(entry: TimelineEntry): void
} => {
  const entries: TimelineEntry[] = []
  return {
    entries,
    push(entry) {
      entries.push(entry)
    },
  }
}

const createSlackClient = (
  options: {
    timeline?: { push(entry: TimelineEntry): void }
  } = {},
): SlackWebClient =>
  ({
    async setAssistantThreadStatus(arg: {
      channel_id: string
      thread_ts: string
      status: string
      loading_messages?: string[]
    }) {
      options.timeline?.push({ kind: 'status', status: arg.status })
      return { ok: true } as never
    },
    async postMessage() {
      throw new Error('not implemented')
    },
    async updateMessage() {
      throw new Error('not implemented')
    },
    async deleteMessage() {
      throw new Error('not implemented')
    },
    async openView() {
      throw new Error('not implemented')
    },
    async updateView() {
      throw new Error('not implemented')
    },
    async pushView() {
      throw new Error('not implemented')
    },
    async postToResponseUrl() {
      throw new Error('not implemented')
    },
    async downloadFile() {
      throw new Error('not implemented')
    },
    async getFileInfo() {
      throw new Error('not implemented')
    },
  }) as SlackWebClient

interface StubTaskCrClient extends TaskCrClient {
  readonly creates: ReadonlyArray<TaskCrSpec>
}

const createTaskCrClient = (
  options: {
    timeline?: { push(entry: TimelineEntry): void }
    createOutcome?: TaskCrCreateOutcome
    createError?: Error
  } = {},
): StubTaskCrClient => {
  const creates: TaskCrSpec[] = []
  return {
    creates,
    async create(task) {
      if (options.createError !== undefined) throw options.createError
      creates.push(task)
      options.timeline?.push({ kind: 'create', taskName: task.name })
      return options.createOutcome ?? 'created'
    },
    async list() {
      // Never resolves so background processMention stays parked while
      // the dispatcher's foreground promise observes only Received→Submitted.
      return new Promise<readonly TaskCrStatus[]>(() => {})
    },
  }
}

const createConfigMapClientStub = (): ConfigMapClient => ({
  async create() {
    return 'created'
  },
  async delete() {
    return 'deleted'
  },
})

const createEventLogStore = (): EventLogStore => ({
  async recordReceived() {
    return 'accepted'
  },
  async deleteReceived() {},
  async markTaskName() {
    return { updated: 1 }
  },
  async findByTaskName() {
    return undefined
  },
  async markResponded() {
    return { updated: 1 }
  },
  async unmarkResponded() {
    return { updated: 0 }
  },
  async pruneOlderThan() {
    return 0
  },
  async hasAcceptedSibling() {
    return false
  },
})

const createThreadSessionStore = (): ThreadSessionStore => ({
  async lookup() {
    return undefined
  },
  async upsert() {},
})

const noopOpencodeClient: OpencodeClient = {
  async fetchLatestAssistantText() {
    return undefined
  },
  async findSessionIdByTitle() {
    return undefined
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
      createSlackClient(),
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
      ...createSlackClient(),
      async getFileInfo(fileId: string) {
        calls.push(fileId)
        return imageFile
      },
    } as SlackWebClient
    const env: SlackEnvelope = {
      ...TEST_ENV,
      text: 'F0BG20H5AVA これ昼たべたから記録しといて',
    }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect({ result, calls }).toEqual({
      result: {
        ...TEST_ENV,
        text: 'これ昼たべたから記録しといて',
        images: [imageFile],
      },
      calls: ['F0BG20H5AVA'],
    })
  })

  it('leaves the text and images unchanged when the resolved file is not an image', async () => {
    const pdfFile: SlackFile = {
      id: 'F0BG20H5AVA',
      name: 'menu.pdf',
      mimetype: 'application/pdf',
    }
    const slackClient: SlackWebClient = {
      ...createSlackClient(),
      async getFileInfo() {
        return pdfFile
      },
    } as SlackWebClient
    const env: SlackEnvelope = { ...TEST_ENV, text: 'F0BG20H5AVA menu please' }
    const result = await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(result).toEqual(env)
  })

  it('leaves the ID as plain text when the lookup fails', async () => {
    const slackClient: SlackWebClient = {
      ...createSlackClient(),
      async getFileInfo() {
        throw new Error('file_not_found')
      },
    } as SlackWebClient
    const env: SlackEnvelope = { ...TEST_ENV, text: 'F0BG20H5AVA menu please' }
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
      ...createSlackClient(),
      async getFileInfo() {
        return otherChannelFile
      },
    } as SlackWebClient
    const env: SlackEnvelope = { ...TEST_ENV, text: 'F0BG20H5AVA menu please' }
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
      ...createSlackClient(),
      async getFileInfo() {
        return existing
      },
    } as SlackWebClient
    const env: SlackEnvelope = {
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
      ...createSlackClient(),
      async getFileInfo(fileId: string) {
        calls.push(fileId)
        return undefined
      },
    } as SlackWebClient
    const env: SlackEnvelope = { ...TEST_ENV, text: ids.join(' ') }
    await resolveInlineImageFiles(env, slackClient, noopLogger)
    expect(calls).toEqual(ids.slice(0, 10))
  })
})

describe('createTaskDispatcher', () => {
  it('sets the initial Preparing bubble before calling taskCrClient.create()', async () => {
    const timeline = createTimeline()
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient: createTaskCrClient({ timeline }),
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient({ timeline }),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await dispatch(acceptedMention())
    expect(timeline.entries).toEqual([
      { kind: 'status', status: 'is thinking...' },
      { kind: 'create', taskName: taskCrNameForSlackEvent('Ev1') },
    ])
  })

  it('builds the Task CR spec from the Slack envelope', async () => {
    const taskCrClient = createTaskCrClient()
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await dispatch(acceptedMention())
    expect(taskCrClient.creates).toEqual([
      {
        name: taskCrNameForSlackEvent('Ev1'),
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description: 'hello bot',
        contexts: [
          {
            kind: 'text',
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C1',
          },
          {
            kind: 'text',
            name: 'slack-thread-ts',
            mountPath: 'slack-context/thread-ts',
            text: '111.222',
          },
        ],
      },
    ])
  })

  it('propagates a taskCrClient.create() failure so the plugin layer can roll back event_log', async () => {
    const failure = new Error('k8s API down')
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient: createTaskCrClient({ createError: failure }),
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await expect(dispatch(acceptedMention())).rejects.toBe(failure)
  })

  it('notifies the Slack thread and clears the assistant status when taskCrClient.create() fails', async () => {
    const failure = new Error('k8s API down')
    const slackClient = createStubSlackClient()
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient: createTaskCrClient({ createError: failure }),
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient,
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
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

  it('returns once Received → Submitted has run, leaving the rest of the flow in the background', async () => {
    const taskCrClient = createTaskCrClient()
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    // taskCrClient.list() never resolves; if the dispatcher were not
    // backgrounding processMention this await would hang the test.
    await dispatch(acceptedMention())
    expect(taskCrClient.creates.length).toBe(1)
  })

  it('resolves an inline file ID reference into the Task CR image ConfigMap context', async () => {
    const taskCrClient = createTaskCrClient()
    const imageFile: SlackFile = {
      id: 'F0BG20H5AVA',
      name: 'lunch.jpg',
      mimetype: 'image/jpeg',
      url_private: 'https://files.slack.com/lunch.jpg',
      channels: ['C1'],
    }
    const slackClient: SlackWebClient = {
      ...createSlackClient(),
      async getFileInfo() {
        return imageFile
      },
      async downloadFile() {
        return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }
      },
    } as SlackWebClient
    const dispatch = createTaskDispatcher({
      configMapClient: createConfigMapClientStub(),
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient,
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await dispatch(
      acceptedMention({
        text: '<@U_BOT> F0BG20H5AVA これ昼たべたから記録しといて',
      }),
    )
    expect(taskCrClient.creates).toEqual([
      {
        name: taskCrNameForSlackEvent('Ev1'),
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description:
          'The user attached 1 image file(s) to this Slack message.\n' +
          'They are included directly in this conversation as image attachments, so you can view their contents without calling any tool. Original filenames, in attachment order:\n' +
          '- lunch.jpg\n\n' +
          'これ昼たべたから記録しといて',
        contexts: [
          {
            kind: 'text',
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C1',
          },
          {
            kind: 'text',
            name: 'slack-thread-ts',
            mountPath: 'slack-context/thread-ts',
            text: '111.222',
          },
          {
            kind: 'configMap',
            name: 'slack-images',
            mountPath: 'slack-images',
            configMapName: `${taskCrNameForSlackEvent('Ev1')}-images`,
          },
        ],
      },
    ])
  })
})

describe('runProcessMentionInBackground', () => {
  it('notifies the Slack thread and clears the assistant status when the Task CR disappears mid-poll', async () => {
    const slackClient = createStubSlackClient()
    await runProcessMentionInBackground(
      TEST_ENV,
      'task-1',
      {
        configMapClient: noopConfigMapClient,
        taskCrClient: createScriptedTaskCrClient([]),
        opencodeClient: noopOpencodeClient,
        eventLogStore: createEventLogStore(),
        threadSessionStore: createThreadSessionStore(),
        slackClient,
        pollIntervalMs: 0,
        sleep: async () => {},
      },
      noopLogger,
    )
    expect(slackClient.calls).toEqual([
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
    const taskCrClient = createTaskCrClient()
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
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

  it('calls submitTask under the active span so its traceparent lands in the Task CR contexts', async () => {
    const taskCrClient = createTaskCrClient()
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await dispatch(acceptedMention())
    const [span] = spanExporter.getFinishedSpans()
    if (span === undefined) throw new Error('expected one finished span')
    const spanCtx = span.spanContext()
    const expectedTraceparent = `00-${spanCtx.traceId}-${spanCtx.spanId}-01`
    expect(taskCrClient.creates).toEqual([
      {
        name: taskCrNameForSlackEvent('Ev1'),
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description: 'hello bot',
        contexts: [
          {
            kind: 'text',
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C1',
          },
          {
            kind: 'text',
            name: 'slack-thread-ts',
            mountPath: 'slack-context/thread-ts',
            text: '111.222',
          },
          {
            kind: 'text',
            name: 'traceparent',
            mountPath: 'slack-context/traceparent',
            text: expectedTraceparent,
          },
        ],
      },
    ])
  })

  it('records the exception on the span when submitTask fails', async () => {
    const failure = new Error('k8s API down')
    const dispatch = createTaskDispatcher({
      configMapClient: noopConfigMapClient,
      taskCrClient: createTaskCrClient({ createError: failure }),
      opencodeClient: noopOpencodeClient,
      eventLogStore: createEventLogStore(),
      threadSessionStore: createThreadSessionStore(),
      slackClient: createSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
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
        exceptionMessages: ['k8s API down'],
      },
    ])
  })
})
