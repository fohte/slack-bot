import { describe, expect, it } from 'vitest'

import {
  createTaskDispatcher,
  envelopeFromAccepted,
} from '@/plugins/llm-agent/dispatcher'
import type {
  EventLogRow,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import type {
  TaskCrClient,
  TaskCrCreateOutcome,
  TaskCrSpec,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type {
  ThreadSessionKey,
  ThreadSessionStore,
  ThreadSessionUpsert,
} from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'
import type {
  SlackAppMentionEvent,
  SlackEventCallback,
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

interface SlackCall {
  readonly kind: 'status' | 'post'
  readonly channel: string
  readonly thread: string
  readonly text: string
  readonly loadingMessages: readonly string[] | undefined
}

interface StubSlackClient extends SlackWebClient {
  readonly calls: ReadonlyArray<SlackCall>
}

const createStubSlackClient = (): StubSlackClient => {
  const calls: SlackCall[] = []
  return {
    calls,
    async setAssistantThreadStatus(arg: {
      channel_id: string
      thread_ts: string
      status: string
      loading_messages?: string[]
    }) {
      calls.push({
        kind: 'status',
        channel: arg.channel_id,
        thread: arg.thread_ts,
        text: arg.status,
        loadingMessages: arg.loading_messages,
      })
      return { ok: true } as never
    },
    async postMessage(arg: {
      channel?: string
      thread_ts?: string
      text?: string
    }) {
      calls.push({
        kind: 'post',
        channel: arg.channel ?? '',
        thread: arg.thread_ts ?? '',
        text: arg.text ?? '',
        loadingMessages: undefined,
      })
      return { ok: true } as never
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
  } as StubSlackClient
}

interface StubTaskCrClient extends TaskCrClient {
  readonly creates: ReadonlyArray<TaskCrSpec>
}

const createStubTaskCrClient = (
  options: {
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
      return options.createOutcome ?? 'created'
    },
    async list() {
      // Never resolves so background processMention stays parked while
      // the dispatcher's foreground promise observes only Received→Submitted.
      return new Promise<readonly TaskCrStatus[]>(() => {})
    },
  }
}

const createStubEventLogStore = (
  options: {
    findByTaskName?: (taskName: string) => EventLogRow | undefined
  } = {},
): EventLogStore => ({
  async recordReceived() {
    return 'accepted'
  },
  async deleteReceived() {},
  async markTaskName() {
    return { updated: 1 }
  },
  async findByTaskName(taskName) {
    return options.findByTaskName?.(taskName)
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
})

const createStubThreadSessionStore = (
  options: { lookup?: (key: ThreadSessionKey) => string | undefined } = {},
): ThreadSessionStore & {
  readonly upserts: ReadonlyArray<ThreadSessionUpsert>
} => {
  const upserts: ThreadSessionUpsert[] = []
  return {
    upserts,
    async lookup(key) {
      return options.lookup?.(key)
    },
    async upsert(record) {
      upserts.push(record)
    },
  }
}

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
    const env = envelopeFromAccepted(acceptedMention(), noopLogger)
    expect(env).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'hello bot',
    })
  })

  it('strips a labelled mention prefix `<@U|name>`', () => {
    const env = envelopeFromAccepted(
      acceptedMention({ text: '<@U_BOT|slack-bot> please help' }),
      noopLogger,
    )
    expect(env).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'please help',
    })
  })

  it('uses thread_ts when present so replies stay anchored to the original thread root', () => {
    const env = envelopeFromAccepted(
      acceptedMention({ ts: '333.444', thread_ts: '111.222' }),
      noopLogger,
    )
    expect(env).toEqual({
      eventId: 'Ev1',
      teamId: 'T1',
      channelId: 'C1',
      threadRootTs: '111.222',
      text: 'hello bot',
    })
  })

  it('returns undefined when event_id is absent (so the dispatcher swallows the event without throwing)', () => {
    const env = envelopeFromAccepted(
      acceptedMention({}, { event_id: undefined }),
      noopLogger,
    )
    expect(env).toBeUndefined()
  })

  it('returns undefined when required envelope fields are missing', () => {
    const env = envelopeFromAccepted(
      acceptedMention({}, { team_id: undefined }),
      noopLogger,
    )
    expect(env).toBeUndefined()
  })
})

describe('createTaskDispatcher', () => {
  it('sets the initial Preparing bubble before calling taskCrClient.create()', async () => {
    const slackClient = createStubSlackClient()
    const taskCrClient = createStubTaskCrClient()
    const dispatch = createTaskDispatcher({
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createStubEventLogStore(),
      threadSessionStore: createStubThreadSessionStore(),
      slackClient,
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await dispatch(acceptedMention())
    expect({
      slack: slackClient.calls,
      creates: taskCrClient.creates,
    }).toEqual({
      slack: [
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          loadingMessages: ['Preparing your task…'],
        },
      ],
      creates: [
        {
          name: taskCrNameForSlackEvent('Ev1'),
          namespace: 'kubeopencode',
          agentName: 'slack-bot',
          description: 'hello bot',
          contexts: [
            {
              name: 'slack-channel',
              mountPath: 'slack-context/channel',
              text: 'C1',
            },
            {
              name: 'slack-thread-ts',
              mountPath: 'slack-context/thread-ts',
              text: '111.222',
            },
          ],
        },
      ],
    })
  })

  it('propagates a taskCrClient.create() failure so the plugin layer can roll back event_log', async () => {
    const failure = new Error('k8s API down')
    const dispatch = createTaskDispatcher({
      taskCrClient: createStubTaskCrClient({ createError: failure }),
      opencodeClient: noopOpencodeClient,
      eventLogStore: createStubEventLogStore(),
      threadSessionStore: createStubThreadSessionStore(),
      slackClient: createStubSlackClient(),
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    await expect(dispatch(acceptedMention())).rejects.toBe(failure)
  })

  it('returns once Received → Submitted has run, leaving the rest of the flow in the background', async () => {
    const slackClient = createStubSlackClient()
    const taskCrClient = createStubTaskCrClient()
    const dispatch = createTaskDispatcher({
      taskCrClient,
      opencodeClient: noopOpencodeClient,
      eventLogStore: createStubEventLogStore(),
      threadSessionStore: createStubThreadSessionStore(),
      slackClient,
      logger: noopLogger,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    // `list()` in the stub returns a never-resolving promise; if the
    // dispatcher were not backgrounding processMention, this await would
    // hang the test.
    await dispatch(acceptedMention())
    expect({
      slackCount: slackClient.calls.length,
      createCount: taskCrClient.creates.length,
    }).toEqual({ slackCount: 1, createCount: 1 })
  })
})
