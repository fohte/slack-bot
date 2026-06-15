import { describe, expect, it } from 'vitest'

import type {
  EventLogRow,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import { createTaskPhaseStatusHandler } from '@/plugins/llm-agent/phase-status-handler'
import type { TaskCrStatus } from '@/plugins/llm-agent/task-cr-client'
import type { SlackWebClient } from '@/slack/web-client'

interface RecordingSlackClient extends SlackWebClient {
  readonly statusCalls: ReadonlyArray<{
    channel_id: string
    thread_ts: string
    status: string
    loading_messages: readonly string[] | undefined
  }>
}

const createRecordingSlackClient = (): RecordingSlackClient => {
  const statusCalls: Array<{
    channel_id: string
    thread_ts: string
    status: string
    loading_messages: readonly string[] | undefined
  }> = []
  const stub = {
    statusCalls,
    async setAssistantThreadStatus(arg: {
      channel_id: string
      thread_ts: string
      status: string
      loading_messages?: string[]
    }) {
      statusCalls.push({
        channel_id: arg.channel_id,
        thread_ts: arg.thread_ts,
        status: arg.status,
        loading_messages: arg.loading_messages,
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

const createStubEventLogStore = (
  rowsByTaskName: ReadonlyMap<string, EventLogRow>,
): EventLogStore => ({
  async recordReceived() {
    return 'accepted'
  },
  async deleteReceived() {},
  async markTaskName() {
    return { updated: 0 }
  },
  async findByTaskName(taskName) {
    return rowsByTaskName.get(taskName)
  },
  async markResponded() {
    return { updated: 0 }
  },
  async unmarkResponded() {
    return { updated: 0 }
  },
  async pruneOlderThan() {
    return 0
  },
})

const knownRow: EventLogRow = {
  slackEventId: 'Ev-known',
  outcome: 'accepted',
  slackTeamId: 'T1',
  slackChannelId: 'C0123ABCD',
  threadRootTs: '1700000000.000050',
  taskName: 'slack-known',
}

const makeTask = (phase: string | undefined): TaskCrStatus => ({
  name: 'slack-known',
  namespace: 'kubeopencode',
  phase,
  message: undefined,
})

describe('createTaskPhaseStatusHandler', () => {
  it.each([
    {
      phase: 'Pending',
      status: 'is thinking...',
      loading_messages: ['Preparing your task…'],
    },
    {
      phase: 'Queued',
      status: 'is waiting in queue...',
      loading_messages: ['Waiting in queue…'],
    },
    {
      phase: 'Running',
      status: 'is working on it...',
      loading_messages: ['Working on it…'],
    },
  ])(
    'sets status and loading_messages for $phase',
    async ({ phase, status, loading_messages }) => {
      const slackClient = createRecordingSlackClient()
      const eventLogStore = createStubEventLogStore(
        new Map([[knownRow.taskName ?? '', knownRow]]),
      )
      const handler = createTaskPhaseStatusHandler({
        slackClient,
        eventLogStore,
      })

      await handler(makeTask(phase))

      expect(slackClient.statusCalls).toEqual([
        {
          channel_id: 'C0123ABCD',
          thread_ts: '1700000000.000050',
          status,
          loading_messages,
        },
      ])
    },
  )

  it.each(['Completed', 'Failed', 'Unknown', undefined])(
    'does not call setStatus for non-mapped phase %s',
    async (phase) => {
      const slackClient = createRecordingSlackClient()
      const eventLogStore = createStubEventLogStore(
        new Map([[knownRow.taskName ?? '', knownRow]]),
      )
      const handler = createTaskPhaseStatusHandler({
        slackClient,
        eventLogStore,
      })

      await handler(makeTask(phase))

      expect(slackClient.statusCalls).toEqual([])
    },
  )

  it('does not call setStatus when event_log row is missing', async () => {
    const slackClient = createRecordingSlackClient()
    const eventLogStore = createStubEventLogStore(new Map())
    const handler = createTaskPhaseStatusHandler({
      slackClient,
      eventLogStore,
    })

    await handler(makeTask('Running'))

    expect(slackClient.statusCalls).toEqual([])
  })

  it('does not call setStatus when channel/thread envelope is missing', async () => {
    const slackClient = createRecordingSlackClient()
    const eventLogStore = createStubEventLogStore(
      new Map([
        [
          'slack-known',
          {
            ...knownRow,
            slackChannelId: undefined,
            threadRootTs: undefined,
          },
        ],
      ]),
    )
    const handler = createTaskPhaseStatusHandler({
      slackClient,
      eventLogStore,
    })

    await handler(makeTask('Running'))

    expect(slackClient.statusCalls).toEqual([])
  })
})
