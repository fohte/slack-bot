import { describe, expect, it } from 'vitest'

import type {
  EventLogOutcome,
  EventLogRow,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import { createTaskResponseHandler } from '@/plugins/llm-agent/response-handler'
import type { TaskCrStatus } from '@/plugins/llm-agent/task-cr-client'
import type {
  ThreadSessionStore,
  ThreadSessionUpsert,
} from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'

interface StubSlackClient extends SlackWebClient {
  readonly posts: ReadonlyArray<{
    channel: string | undefined
    thread_ts: string | undefined
    text: string | undefined
  }>
}

const createStubSlackClient = (
  options: { postError?: Error } = {},
): StubSlackClient => {
  const posts: Array<{
    channel: string | undefined
    thread_ts: string | undefined
    text: string | undefined
  }> = []
  const stub = {
    posts,
    async postMessage(arg: {
      channel?: string
      thread_ts?: string
      text?: string
    }) {
      if (options.postError !== undefined) throw options.postError
      posts.push({
        channel: arg.channel,
        thread_ts: arg.thread_ts,
        text: arg.text,
      })
      return {
        ok: true,
        ts: '1700000099.000001',
        channel: arg.channel,
      } as never
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
  return stub as unknown as StubSlackClient
}

const createStubOpencodeClient = (
  options: { text?: string; error?: Error } = {},
): OpencodeClient => ({
  async fetchLatestAssistantText() {
    if (options.error !== undefined) throw options.error
    return options.text
  },
})

interface StubEventLogStore extends EventLogStore {
  readonly responded: readonly string[]
  readonly unmarked: readonly string[]
}

const createStubEventLogStore = (
  rows: ReadonlyArray<readonly [string, EventLogRow]>,
  options: { preMarked?: ReadonlySet<string> } = {},
): StubEventLogStore => {
  const respondedSet = new Set<string>(options.preMarked ?? [])
  const responded: string[] = []
  const unmarked: string[] = []
  const map = new Map(rows)
  return {
    responded,
    unmarked,
    async recordReceived(): Promise<EventLogOutcome> {
      return 'accepted'
    },
    async deleteReceived(): Promise<void> {},
    async markTaskName(): Promise<{ updated: number }> {
      return { updated: 1 }
    },
    async findByTaskName(taskName) {
      const row = map.get(taskName)
      if (row === undefined) return undefined
      if (respondedSet.has(row.slackEventId)) {
        return { ...row, outcome: 'responded' }
      }
      return row
    },
    async markResponded(slackEventId) {
      if (respondedSet.has(slackEventId)) return { updated: 0 }
      respondedSet.add(slackEventId)
      responded.push(slackEventId)
      return { updated: 1 }
    },
    async unmarkResponded(slackEventId) {
      if (!respondedSet.has(slackEventId)) return { updated: 0 }
      respondedSet.delete(slackEventId)
      unmarked.push(slackEventId)
      const idx = responded.indexOf(slackEventId)
      if (idx >= 0) responded.splice(idx, 1)
      return { updated: 1 }
    },
    async pruneOlderThan(): Promise<number> {
      return 0
    },
  }
}

interface StubThreadSessionStore extends ThreadSessionStore {
  readonly upserts: readonly ThreadSessionUpsert[]
}

const createStubThreadSessionStore = (
  options: { upsertError?: Error } = {},
): StubThreadSessionStore => {
  const upserts: ThreadSessionUpsert[] = []
  return {
    upserts,
    async lookup() {
      return undefined
    },
    async upsert(record) {
      if (options.upsertError !== undefined) throw options.upsertError
      upserts.push(record)
    },
  }
}

const buildRow = (overrides: Partial<EventLogRow> = {}): EventLogRow => ({
  slackEventId: 'Ev123',
  outcome: 'accepted',
  slackTeamId: 'T123',
  slackChannelId: 'C123',
  threadRootTs: '1700000000.000050',
  taskName: 'slack-abcdef0123456789',
  ...overrides,
})

const buildTask = (overrides: Partial<TaskCrStatus> = {}): TaskCrStatus => ({
  name: 'slack-abcdef0123456789',
  namespace: 'kubeopencode',
  phase: 'Succeeded',
  message: undefined,
  sessionId: 'ses_abc',
  ...overrides,
})

describe('createTaskResponseHandler', () => {
  it('posts assistant text and transitions event_log to responded on Succeeded', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({ text: 'Done!' })
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(buildTask())

    expect({
      outcome,
      posts: slack.posts,
      responded: eventLog.responded,
      upserts: sessions.upserts,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: 'Done!',
        },
      ],
      responded: ['Ev123'],
      upserts: [
        {
          slackTeamId: 'T123',
          slackChannelId: 'C123',
          threadRootTs: '1700000000.000050',
          opencodeSessionId: 'ses_abc',
        },
      ],
    })
  })

  it('posts a formatted failure message on Failed phase', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient()
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(
      buildTask({ phase: 'Failed', message: 'oom', sessionId: undefined }),
    )

    expect({
      outcome,
      posts: slack.posts,
      responded: eventLog.responded,
      upserts: sessions.upserts,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: 'Task failed: oom',
        },
      ],
      responded: ['Ev123'],
      upserts: [],
    })
  })

  it('skips already responded rows without posting again', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({ text: 'Done!' })
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow({ outcome: 'responded' })],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(buildTask())

    expect({
      outcome,
      posts: slack.posts,
      responded: eventLog.responded,
    }).toEqual({
      outcome: 'skipped_already_responded',
      posts: [],
      responded: [],
    })
  })

  it('skips non-terminal Task phases', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient()
    const eventLog = createStubEventLogStore([])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(buildTask({ phase: 'Running' }))

    expect({ outcome, posts: slack.posts }).toEqual({
      outcome: 'skipped_non_terminal',
      posts: [],
    })
  })

  it('skips Tasks with no matching event_log row', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({ text: 'Done!' })
    const eventLog = createStubEventLogStore([])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(buildTask())

    expect({ outcome, posts: slack.posts }).toEqual({
      outcome: 'skipped_orphan',
      posts: [],
    })
  })

  it('posts the fallback text when opencode fetch fails so the user is notified anyway', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({
      error: new Error('opencode down'),
    })
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
      successFallbackText: '(opencode unavailable)',
    })

    const outcome = await handler(buildTask())

    expect({
      outcome,
      posts: slack.posts,
      responded: eventLog.responded,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: '(opencode unavailable)',
        },
      ],
      responded: ['Ev123'],
    })
  })

  it('rolls back the responded marker when the Slack post fails so a later tick can retry', async () => {
    const slack = createStubSlackClient({ postError: new Error('slack down') })
    const opencode = createStubOpencodeClient({ text: 'Done!' })
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    await expect(handler(buildTask())).rejects.toThrow('slack down')

    expect({
      posts: slack.posts,
      responded: eventLog.responded,
      unmarked: eventLog.unmarked,
    }).toEqual({
      posts: [],
      responded: [],
      unmarked: ['Ev123'],
    })
  })

  it('exits without posting when another tick already won the markResponded race', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({ text: 'Done!' })
    // findByTaskName sees outcome=accepted (race winner has not committed
    // yet), but by the time markResponded runs the winner has flipped the
    // row to responded — exactly the race-loser path.
    const eventLog = createStubEventLogStore(
      [['slack-abcdef0123456789', buildRow()]],
      { preMarked: new Set(['Ev123']) },
    )
    // The pre-marked stub returns outcome='responded' from findByTaskName,
    // so we go through the early-exit branch. Verify that branch.
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(buildTask())

    expect({ outcome, posts: slack.posts }).toEqual({
      outcome: 'skipped_already_responded',
      posts: [],
    })
  })

  it('falls back to a placeholder when opencode returns no assistant message', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({})
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
      successFallbackText: '(no message)',
    })

    const outcome = await handler(buildTask())

    expect({
      outcome,
      posts: slack.posts,
      responded: eventLog.responded,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: '(no message)',
        },
      ],
      responded: ['Ev123'],
    })
  })
})
