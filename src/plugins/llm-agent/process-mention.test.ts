import { describe, expect, it } from 'vitest'

import type {
  EventLogRow,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type {
  Phase,
  ProcessMentionDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention'
import {
  advance,
  bubbleFor,
  processMention,
} from '@/plugins/llm-agent/process-mention'
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

interface ScriptedTaskCrClient extends TaskCrClient {
  readonly creates: ReadonlyArray<TaskCrSpec>
  readonly listCount: () => number
}

// list() returns the next scripted status per call so tests can drive
// phase transitions deterministically.
const createScriptedTaskCrClient = (
  statuses: readonly TaskCrStatus[],
  createOutcome: TaskCrCreateOutcome = 'created',
): ScriptedTaskCrClient => {
  const creates: TaskCrSpec[] = []
  let i = 0
  return {
    creates,
    listCount: () => i,
    async create(task) {
      creates.push(task)
      return createOutcome
    },
    async list() {
      const next = statuses[Math.min(i, statuses.length - 1)]
      i += 1
      return next === undefined ? [] : [next]
    },
  }
}

interface ScriptedEventLogStore extends EventLogStore {
  readonly markedTaskNames: ReadonlyArray<{ id: string; name: string }>
  readonly markedResponded: ReadonlyArray<string>
}

const createScriptedEventLogStore = (
  options: {
    findByTaskName?: (taskName: string) => EventLogRow | undefined
    alreadyResponded?: boolean
  } = {},
): ScriptedEventLogStore => {
  const markedTaskNames: Array<{ id: string; name: string }> = []
  const markedResponded: string[] = []
  let respondedReturnsZero = options.alreadyResponded ?? false
  return {
    markedTaskNames,
    markedResponded,
    async recordReceived() {
      return 'accepted'
    },
    async deleteReceived() {},
    async markTaskName(slackEventId, taskName) {
      markedTaskNames.push({ id: slackEventId, name: taskName })
      return { updated: 1 }
    },
    async findByTaskName(taskName) {
      return options.findByTaskName?.(taskName)
    },
    async markResponded(slackEventId) {
      if (respondedReturnsZero) return { updated: 0 }
      markedResponded.push(slackEventId)
      respondedReturnsZero = true
      return { updated: 1 }
    },
    async unmarkResponded() {
      return { updated: 0 }
    },
    async pruneOlderThan() {
      return 0
    },
  }
}

interface ScriptedThreadSessionStore extends ThreadSessionStore {
  readonly upserts: ReadonlyArray<ThreadSessionUpsert>
}

const createScriptedThreadSessionStore = (
  options: { lookup?: (key: ThreadSessionKey) => string | undefined } = {},
): ScriptedThreadSessionStore => {
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

const fixedOpencodeClient = (
  options: {
    sessionId?: string | undefined
    assistantText?: string | undefined
  } = {},
): OpencodeClient => ({
  async fetchLatestAssistantText() {
    return options.assistantText
  },
  async findSessionIdByTitle() {
    return options.sessionId
  },
})

const ENV: SlackEnvelope = {
  eventId: 'Ev1',
  teamId: 'T1',
  channelId: 'C1',
  threadRootTs: '111.222',
  text: 'hello bot',
}

describe('bubbleFor', () => {
  it('maps every Phase kind to the expected bubble identity', () => {
    const phases: readonly Phase[] = [
      { kind: 'Received', env: ENV },
      { kind: 'Submitted', env: ENV, taskName: 'task-1' },
      { kind: 'Queued', env: ENV, taskName: 'task-1' },
      { kind: 'Running', env: ENV, taskName: 'task-1' },
      { kind: 'Completed', env: ENV, taskName: 'task-1' },
      { kind: 'Failed', env: ENV, taskName: 'task-1', message: undefined },
    ]
    const mapping = phases.map((p) => ({
      kind: p.kind,
      bubble: bubbleFor(p),
    }))
    expect(mapping).toEqual([
      {
        kind: 'Received',
        bubble: {
          status: 'is thinking...',
          loadingMessages: ['Preparing your task…'],
        },
      },
      {
        kind: 'Submitted',
        bubble: {
          status: 'is thinking...',
          loadingMessages: ['Preparing your task…'],
        },
      },
      {
        kind: 'Queued',
        bubble: {
          status: 'is waiting in queue...',
          loadingMessages: ['Waiting in queue…'],
        },
      },
      {
        kind: 'Running',
        bubble: {
          status: 'is working on it...',
          loadingMessages: ['Working on it…'],
        },
      },
      { kind: 'Completed', bubble: undefined },
      { kind: 'Failed', bubble: undefined },
    ])
  })

  it('returns the same singleton for Received and Submitted', () => {
    const received = bubbleFor({ kind: 'Received', env: ENV })
    const submitted = bubbleFor({ kind: 'Submitted', env: ENV, taskName: 't' })
    expect(received === submitted).toBe(true)
  })
})

describe('advance', () => {
  it('Received → Submitted creates a Task CR and records its name', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore,
      slackClient: createStubSlackClient(),
    }

    const next = await advance({ kind: 'Received', env: ENV }, deps)

    const expectedName = taskCrNameForSlackEvent(ENV.eventId)
    expect({
      next,
      creates: taskCrClient.creates,
      marked: eventLogStore.markedTaskNames,
    }).toEqual({
      next: { kind: 'Submitted', env: ENV, taskName: expectedName },
      creates: [
        {
          name: expectedName,
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
      marked: [{ id: 'Ev1', name: expectedName }],
    })
  })

  it('Received → Submitted attaches the opencode session id when a thread is mapped', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore({
        lookup: () => 'ses_abc',
      }),
      slackClient: createStubSlackClient(),
    }
    await advance({ kind: 'Received', env: ENV }, deps)
    expect(taskCrClient.creates[0]?.contexts).toEqual([
      { name: 'slack-channel', mountPath: 'slack-context/channel', text: 'C1' },
      {
        name: 'slack-thread-ts',
        mountPath: 'slack-context/thread-ts',
        text: '111.222',
      },
      {
        name: 'opencode-session-id',
        mountPath: 'slack-context/session-id',
        text: 'ses_abc',
      },
    ])
  })

  it('polls until the Task CR phase differs from the current k8s phase', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Pending',
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Pending',
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ])
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    const next = await advance({ kind: 'Submitted', env: ENV, taskName }, deps)
    expect({ next, listCount: taskCrClient.listCount() }).toEqual({
      next: { kind: 'Running', env: ENV, taskName },
      listCount: 3,
    })
  })

  it('keeps sleeping past unknown / undefined phases without busy-looping', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: undefined,
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Cancelled',
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
    ])
    let sleepCount = 0
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
      pollIntervalMs: 0,
      sleep: async () => {
        sleepCount += 1
      },
    }
    const next = await advance({ kind: 'Submitted', env: ENV, taskName }, deps)
    expect({ next, sleepCount }).toEqual({
      next: { kind: 'Running', env: ENV, taskName },
      sleepCount: 2,
    })
  })

  it('throws when called on a terminal phase', async () => {
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
    }
    await expect(
      advance({ kind: 'Completed', env: ENV, taskName: 't' }, deps),
    ).rejects.toThrow('advance called on terminal phase Completed')
  })
})

describe('processMention', () => {
  it('drives a Submitted task through Queued → Running → Completed and posts the slackified reply', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Queued',
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Running',
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: '**bold** answer',
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    await processMention({ kind: 'Submitted', env: ENV, taskName }, deps)

    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          loadingMessages: ['Preparing your task…'],
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is waiting in queue...',
          loadingMessages: ['Waiting in queue…'],
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is working on it...',
          loadingMessages: ['Working on it…'],
        },
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: '​*bold*​ answer',
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          loadingMessages: undefined,
        },
      ],
      upserts: [
        {
          slackTeamId: 'T1',
          slackChannelId: 'C1',
          threadRootTs: '111.222',
          opencodeSessionId: 'ses_xyz',
        },
      ],
    })
  })

  it('posts an escaped failure message on Failed and does not upsert thread session', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Failed',
        message: '<oops> & died',
      },
    ])
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    await processMention(
      { kind: 'Submitted', env: ENV, taskName },
      deps,
      // Pre-set the Preparing bubble (as the dispatcher would have done)
      // so we only observe transitions past it.
      {
        previousBubble: {
          status: 'is thinking...',
          loadingMessages: ['Preparing your task…'],
        },
      },
    )

    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'Task failed: &lt;oops&gt; &amp; died',
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          loadingMessages: undefined,
        },
      ],
      upserts: [],
    })
  })

  it('falls back to the placeholder text when the opencode session yields no assistant message', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: undefined,
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    await processMention({ kind: 'Submitted', env: ENV, taskName }, deps, {
      previousBubble: {
        status: 'is thinking...',
        loadingMessages: ['Preparing your task…'],
      },
    })

    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: '(opencode did not produce an assistant message)',
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        loadingMessages: undefined,
      },
    ])
  })

  it('skips the Slack post when event_log markResponded reports already-responded', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: 'answer',
      }),
      eventLogStore: createScriptedEventLogStore({ alreadyResponded: true }),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    await processMention({ kind: 'Submitted', env: ENV, taskName }, deps, {
      previousBubble: {
        status: 'is thinking...',
        loadingMessages: ['Preparing your task…'],
      },
    })

    expect(slackClient.calls).toEqual([])
  })
})
