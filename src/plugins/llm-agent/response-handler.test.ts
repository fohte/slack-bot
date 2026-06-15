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
  readonly statusCalls: ReadonlyArray<{
    channel_id: string
    thread_ts: string
    status: string
  }>
}

const createStubSlackClient = (
  options: { postError?: Error; statusError?: Error } = {},
): StubSlackClient => {
  const posts: Array<{
    channel: string | undefined
    thread_ts: string | undefined
    text: string | undefined
  }> = []
  const statusCalls: Array<{
    channel_id: string
    thread_ts: string
    status: string
  }> = []
  const stub = {
    posts,
    statusCalls,
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

interface StubOpencodeOptions {
  readonly text?: string
  readonly error?: Error
  readonly sessionId?: string | undefined
  readonly explicitSessionId?: boolean
  readonly sessionLookupError?: Error
}

const createStubOpencodeClient = (
  options: StubOpencodeOptions = {},
): OpencodeClient => ({
  async fetchLatestAssistantText() {
    if (options.error !== undefined) throw options.error
    return options.text
  },
  async findSessionIdByTitle() {
    if (options.sessionLookupError !== undefined) {
      throw options.sessionLookupError
    }
    if (options.explicitSessionId === true) return options.sessionId
    // Default to a found session so happy-path tests don't need to set it.
    return 'ses_abc'
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
  options: {
    upsertError?: Error
    lookupResult?: string | undefined
    lookupError?: Error
  } = {},
): StubThreadSessionStore => {
  const upserts: ThreadSessionUpsert[] = []
  return {
    upserts,
    async lookup() {
      if (options.lookupError !== undefined) throw options.lookupError
      return options.lookupResult
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
  phase: 'Completed',
  message: undefined,
  ...overrides,
})

describe('createTaskResponseHandler', () => {
  it('posts assistant text and transitions event_log to responded on Completed', async () => {
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

  it('converts CommonMark/GFM markdown in the assistant text to Slack mrkdwn before posting', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({
      text: '**bold** and [link](https://example.com)\n\n- item one\n- item two',
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
    })

    await handler(buildTask())

    expect(slack.posts).toEqual([
      {
        channel: 'C123',
        thread_ts: '1700000000.000050',
        text: '​*bold*​ and <https://example.com|link>\n\n•   item one\n•   item two',
      },
    ])
  })

  it('does not convert the success fallback when opencode returns no assistant text (markdown-like fallback would otherwise be mangled)', async () => {
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
      successFallbackText: '(no **assistant** message)',
    })

    await handler(buildTask())

    expect(slack.posts).toEqual([
      {
        channel: 'C123',
        thread_ts: '1700000000.000050',
        text: '(no **assistant** message)',
      },
    ])
  })

  it('falls back to the success fallback when the assistant text collapses to empty after slackify conversion (chat.postMessage would otherwise reject with no_text)', async () => {
    const slack = createStubSlackClient()
    // HTML comments are stripped by slackify-markdown's removeHtmlComments plugin
    const opencode = createStubOpencodeClient({ text: '<!-- nothing -->' })
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore()
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
      successFallbackText: '(empty after conversion)',
    })

    await handler(buildTask())

    expect(slack.posts).toEqual([
      {
        channel: 'C123',
        thread_ts: '1700000000.000050',
        text: '(empty after conversion)',
      },
    ])
  })

  it('uses the thread_session_map entry for resumed threads instead of the stale opencode title', async () => {
    const slack = createStubSlackClient()
    const fetchCalls: string[] = []
    const titleCalls: string[] = []
    const opencode: OpencodeClient = {
      async fetchLatestAssistantText(sessionId) {
        fetchCalls.push(sessionId)
        return 'Resumed answer'
      },
      async findSessionIdByTitle(title) {
        titleCalls.push(title)
        return undefined
      },
    }
    const eventLog = createStubEventLogStore([
      [
        'slack-resumed-task-name',
        buildRow({ taskName: 'slack-resumed-task-name' }),
      ],
    ])
    const sessions = createStubThreadSessionStore({
      lookupResult: 'ses_resumed',
    })
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(
      buildTask({ name: 'slack-resumed-task-name' }),
    )

    expect({
      outcome,
      posts: slack.posts,
      responded: eventLog.responded,
      upserts: sessions.upserts,
      fetchCalls,
      titleCalls,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: 'Resumed answer',
        },
      ],
      responded: ['Ev123'],
      upserts: [
        {
          slackTeamId: 'T123',
          slackChannelId: 'C123',
          threadRootTs: '1700000000.000050',
          opencodeSessionId: 'ses_resumed',
        },
      ],
      fetchCalls: ['ses_resumed'],
      titleCalls: [],
    })
  })

  it('falls back to the opencode title lookup when thread_session_map has no entry', async () => {
    const slack = createStubSlackClient()
    const fetchCalls: string[] = []
    const titleCalls: string[] = []
    const opencode: OpencodeClient = {
      async fetchLatestAssistantText(sessionId) {
        fetchCalls.push(sessionId)
        return 'First answer'
      },
      async findSessionIdByTitle(title) {
        titleCalls.push(title)
        return 'ses_first'
      },
    }
    const eventLog = createStubEventLogStore([
      [
        'slack-first-task-name',
        buildRow({ taskName: 'slack-first-task-name' }),
      ],
    ])
    const sessions = createStubThreadSessionStore({ lookupResult: undefined })
    const handler = createTaskResponseHandler({
      slackClient: slack,
      opencodeClient: opencode,
      eventLogStore: eventLog,
      threadSessionStore: sessions,
    })

    const outcome = await handler(buildTask({ name: 'slack-first-task-name' }))

    expect({
      outcome,
      posts: slack.posts,
      upserts: sessions.upserts,
      fetchCalls,
      titleCalls,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: 'First answer',
        },
      ],
      upserts: [
        {
          slackTeamId: 'T123',
          slackChannelId: 'C123',
          threadRootTs: '1700000000.000050',
          opencodeSessionId: 'ses_first',
        },
      ],
      fetchCalls: ['ses_first'],
      titleCalls: ['slack-first-task-name'],
    })
  })

  it('falls back to the opencode title lookup when thread_session_map lookup throws', async () => {
    const slack = createStubSlackClient()
    const fetchCalls: string[] = []
    const titleCalls: string[] = []
    const opencode: OpencodeClient = {
      async fetchLatestAssistantText(sessionId) {
        fetchCalls.push(sessionId)
        return 'Recovered answer'
      },
      async findSessionIdByTitle(title) {
        titleCalls.push(title)
        return 'ses_recovered'
      },
    }
    const eventLog = createStubEventLogStore([
      ['slack-abcdef0123456789', buildRow()],
    ])
    const sessions = createStubThreadSessionStore({
      lookupError: new Error('db down'),
    })
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
      upserts: sessions.upserts,
      fetchCalls,
      titleCalls,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: 'Recovered answer',
        },
      ],
      upserts: [
        {
          slackTeamId: 'T123',
          slackChannelId: 'C123',
          threadRootTs: '1700000000.000050',
          opencodeSessionId: 'ses_recovered',
        },
      ],
      fetchCalls: ['ses_recovered'],
      titleCalls: ['slack-abcdef0123456789'],
    })
  })

  it('escapes Slack mrkdwn metacharacters in the failure status message', async () => {
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

    await handler(
      buildTask({
        phase: 'Failed',
        message: 'oom <U123> & <#C456>',
      }),
    )

    expect(slack.posts).toEqual([
      {
        channel: 'C123',
        thread_ts: '1700000000.000050',
        text: 'Task failed: oom &lt;U123&gt; &amp; &lt;#C456&gt;',
      },
    ])
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
      buildTask({ phase: 'Failed', message: 'oom' }),
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

  it('terminates with the fallback text when no opencode session matches the Task name', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({
      sessionId: undefined,
      explicitSessionId: true,
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
      successFallbackText: '(opencode session missing)',
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
          text: '(opencode session missing)',
        },
      ],
      responded: ['Ev123'],
      upserts: [],
    })
  })

  it('terminates with the fallback text when the session lookup itself errors', async () => {
    const slack = createStubSlackClient()
    const opencode = createStubOpencodeClient({
      sessionLookupError: new Error('opencode unreachable'),
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
      upserts: sessions.upserts,
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
      upserts: [],
    })
  })

  it('clears the assistant thread status after a successful post', async () => {
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

    await handler(buildTask())

    expect(slack.statusCalls).toEqual([
      {
        channel_id: 'C123',
        thread_ts: '1700000000.000050',
        status: '',
      },
    ])
  })

  it('still returns responded when clearing the assistant status fails', async () => {
    const slack = createStubSlackClient({
      statusError: new Error('channel_not_supported'),
    })
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
      statusCalls: slack.statusCalls,
      responded: eventLog.responded,
    }).toEqual({
      outcome: 'responded',
      posts: [
        {
          channel: 'C123',
          thread_ts: '1700000000.000050',
          text: 'Done!',
        },
      ],
      statusCalls: [],
      responded: ['Ev123'],
    })
  })

  it('does not attempt to clear the assistant status when the post itself fails', async () => {
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
    expect(slack.statusCalls).toEqual([])
  })
})
