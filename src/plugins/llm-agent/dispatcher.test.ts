import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createTaskDispatcher } from '@/plugins/llm-agent/dispatcher'
import type {
  EventLogOutcome,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
import type {
  TaskCrClient,
  TaskCrCreateOutcome,
  TaskCrSpec,
} from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type {
  ThreadSessionKey,
  ThreadSessionStore,
} from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'
import type {
  SlackAppMentionEvent,
  SlackEventCallback,
} from '@/types/slack-payloads'

interface RecordingSlackClient extends SlackWebClient {
  readonly statusCalls: ReadonlyArray<{
    channel_id: string
    thread_ts: string
    status: string
  }>
}

const createRecordingSlackClient = (
  options: { statusError?: Error } = {},
): RecordingSlackClient => {
  const statusCalls: Array<{
    channel_id: string
    thread_ts: string
    status: string
  }> = []
  const stub = {
    statusCalls,
    async setAssistantThreadStatus(arg: {
      channel_id: string
      thread_ts: string
      status: string
    }) {
      if (options.statusError !== undefined) throw options.statusError
      statusCalls.push({
        channel_id: arg.channel_id,
        thread_ts: arg.thread_ts,
        status: arg.status,
      })
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
  }
  return stub as unknown as RecordingSlackClient
}

interface RecordingTaskCrClient extends TaskCrClient {
  readonly created: readonly TaskCrSpec[]
}

const createRecordingTaskCrClient = (
  result: TaskCrCreateOutcome | Error = 'created',
): RecordingTaskCrClient => {
  const created: TaskCrSpec[] = []
  return {
    created,
    async create(task) {
      created.push(task)
      if (result instanceof Error) throw result
      return result
    },
    async list() {
      return []
    },
  }
}

const createSessionStore = (
  sessions: ReadonlyArray<readonly [ThreadSessionKey, string]> = [],
): ThreadSessionStore => ({
  async lookup(key) {
    for (const [k, sessionId] of sessions) {
      if (
        k.slackTeamId === key.slackTeamId &&
        k.slackChannelId === key.slackChannelId &&
        k.threadRootTs === key.threadRootTs
      ) {
        return sessionId
      }
    }
    return undefined
  },
  async upsert() {},
})

interface RecordingEventLogStore extends EventLogStore {
  readonly marks: ReadonlyArray<readonly [string, string]>
}

const createRecordingEventLogStore = (
  override?: Partial<EventLogStore>,
): RecordingEventLogStore => {
  const marks: Array<[string, string]> = []
  return {
    marks,
    async recordReceived(): Promise<EventLogOutcome> {
      return 'accepted'
    },
    async deleteReceived(): Promise<void> {},
    async markTaskName(eventId, taskName): Promise<{ updated: number }> {
      marks.push([eventId, taskName])
      return { updated: 1 }
    },
    async findByTaskName() {
      return undefined
    },
    async markResponded(): Promise<{ updated: number }> {
      return { updated: 0 }
    },
    async unmarkResponded(): Promise<{ updated: number }> {
      return { updated: 0 }
    },
    async pruneOlderThan(): Promise<number> {
      return 0
    },
    ...override,
  }
}

const buildAccepted = (
  overrides: {
    eventId?: string
    teamId?: string
    channel?: string
    ts?: string
    threadTs?: string
    text?: string
  } = {},
): LlmAgentAcceptedEvent => {
  const event: SlackAppMentionEvent = {
    type: 'app_mention',
    channel: overrides.channel ?? 'C0123ABCD',
    user: 'U999',
    text: overrides.text ?? '<@U_BOT> please help',
    ts: overrides.ts ?? '1700000000.000100',
    ...(overrides.threadTs !== undefined
      ? { thread_ts: overrides.threadTs }
      : {}),
  }
  const envelope: SlackEventCallback = {
    type: 'event_callback',
    team_id: overrides.teamId ?? 'T123',
    event,
    event_id: overrides.eventId ?? 'Ev01',
    event_time: 1700000000,
  }
  return { ctx: { envelope }, event }
}

describe('createTaskDispatcher', () => {
  it('creates a Task CR without session-id context when no thread session exists', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    await dispatcher(
      buildAccepted({
        eventId: 'Ev-new-thread',
        threadTs: '1700000000.000050',
        text: '<@U_BOT> hello world',
      }),
    )

    const expectedName = taskCrNameForSlackEvent('Ev-new-thread')
    expect(taskCrClient.created).toEqual([
      {
        name: expectedName,
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description: 'hello world',
        contexts: [
          {
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C0123ABCD',
          },
          {
            name: 'slack-thread-ts',
            mountPath: 'slack-context/thread-ts',
            text: '1700000000.000050',
          },
        ],
      },
    ])
    expect(eventLogStore.marks).toEqual([['Ev-new-thread', expectedName]])
  })

  it('appends opencode-session-id context when a thread session exists', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore([
      [
        {
          slackTeamId: 'T123',
          slackChannelId: 'C0123ABCD',
          threadRootTs: '1700000000.000050',
        },
        'ses_abcdef',
      ],
    ])
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    await dispatcher(
      buildAccepted({
        eventId: 'Ev-resume',
        threadTs: '1700000000.000050',
        text: '<@U_BOT> follow up',
      }),
    )

    const expectedName = taskCrNameForSlackEvent('Ev-resume')
    expect(taskCrClient.created).toEqual([
      {
        name: expectedName,
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description: 'follow up',
        contexts: [
          {
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C0123ABCD',
          },
          {
            name: 'slack-thread-ts',
            mountPath: 'slack-context/thread-ts',
            text: '1700000000.000050',
          },
          {
            name: 'opencode-session-id',
            mountPath: 'slack-context/session-id',
            text: 'ses_abcdef',
          },
        ],
      },
    ])
    expect(eventLogStore.marks).toEqual([['Ev-resume', expectedName]])
  })

  it('falls back to event ts as thread root when thread_ts is absent', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    await dispatcher(
      buildAccepted({
        eventId: 'Ev-no-thread',
        ts: '1700000000.999999',
      }),
    )

    expect(taskCrClient.created).toEqual([
      {
        name: taskCrNameForSlackEvent('Ev-no-thread'),
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description: 'please help',
        contexts: [
          {
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C0123ABCD',
          },
          {
            name: 'slack-thread-ts',
            mountPath: 'slack-context/thread-ts',
            text: '1700000000.999999',
          },
        ],
      },
    ])
  })

  it('treats a 409 (already_exists) as accepted and still marks task_name', async () => {
    const taskCrClient = createRecordingTaskCrClient('already_exists')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    await expect(
      dispatcher(buildAccepted({ eventId: 'Ev-conflict' })),
    ).resolves.toBeUndefined()

    expect(eventLogStore.marks).toEqual([
      ['Ev-conflict', taskCrNameForSlackEvent('Ev-conflict')],
    ])
  })

  it('propagates a K8s API failure so the plugin can roll back event_log', async () => {
    const apiError = new Error('500 internal server error')
    const taskCrClient = createRecordingTaskCrClient(apiError)
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    await expect(
      dispatcher(buildAccepted({ eventId: 'Ev-server-error' })),
    ).rejects.toBe(apiError)
    expect(eventLogStore.marks).toEqual([])
  })

  it('propagates a DB lookup failure so the plugin can roll back event_log', async () => {
    const lookupError = new Error('db down')
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore: ThreadSessionStore = {
      async lookup() {
        throw lookupError
      },
      async upsert() {},
    }
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    await expect(
      dispatcher(buildAccepted({ eventId: 'Ev-db-error' })),
    ).rejects.toBe(lookupError)
    expect(taskCrClient.created).toEqual([])
    expect(eventLogStore.marks).toEqual([])
  })

  it('skips dispatch without throwing when team_id is missing', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
    })

    const accepted = buildAccepted({ eventId: 'Ev-no-team' })
    const acceptedWithoutTeam: LlmAgentAcceptedEvent = {
      ctx: {
        envelope: {
          type: 'event_callback',
          event: accepted.event,
          event_id: 'Ev-no-team',
          event_time: 1700000000,
        },
      },
      event: accepted.event,
    }

    await expect(dispatcher(acceptedWithoutTeam)).resolves.toBeUndefined()
    expect(taskCrClient.created).toEqual([])
    expect(eventLogStore.marks).toEqual([])
  })

  it('sets the assistant thread status after dispatch when slackClient is provided', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const slackClient = createRecordingSlackClient()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
      slackClient,
    })

    await dispatcher(
      buildAccepted({
        eventId: 'Ev-status',
        threadTs: '1700000000.000050',
      }),
    )

    expect(slackClient.statusCalls).toEqual([
      {
        channel_id: 'C0123ABCD',
        thread_ts: '1700000000.000050',
        status: '考え中…',
      },
    ])
  })

  it('honors a custom thinkingStatus override', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const slackClient = createRecordingSlackClient()
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
      slackClient,
      thinkingStatus: 'is thinking...',
    })

    await dispatcher(buildAccepted({ eventId: 'Ev-custom-status' }))

    expect(slackClient.statusCalls).toEqual([
      {
        channel_id: 'C0123ABCD',
        thread_ts: '1700000000.000100',
        status: 'is thinking...',
      },
    ])
  })

  it('does not throw when setStatus fails (best-effort status indicator)', async () => {
    const taskCrClient = createRecordingTaskCrClient('created')
    const threadSessionStore = createSessionStore()
    const eventLogStore = createRecordingEventLogStore()
    const slackClient = createRecordingSlackClient({
      statusError: new Error('channel_not_supported'),
    })
    const dispatcher = createTaskDispatcher({
      taskCrClient,
      threadSessionStore,
      eventLogStore,
      slackClient,
    })

    await expect(
      dispatcher(buildAccepted({ eventId: 'Ev-status-fail' })),
    ).resolves.toBeUndefined()

    expect({
      created: taskCrClient.created.length,
      statusCalls: slackClient.statusCalls,
      marks: eventLogStore.marks,
    }).toEqual({
      created: 1,
      statusCalls: [],
      marks: [['Ev-status-fail', taskCrNameForSlackEvent('Ev-status-fail')]],
    })
  })

  it('produces a stable Task CR name from the Slack event_id', () => {
    const expected =
      'slack-' +
      createHash('sha256').update('Ev08AB12CDEFGHIJ').digest('hex').slice(0, 16)
    expect(taskCrNameForSlackEvent('Ev08AB12CDEFGHIJ')).toEqual(expected)
  })
})
