import { describe, expect, it } from 'vitest'

import type {
  EventLogRow,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type {
  ProcessMentionDeps,
  SlackEnvelope,
  TerminalOutcome,
} from '@/plugins/llm-agent/process-mention'
import {
  bubbleForK8sPhase,
  PREPARING_BUBBLE,
  processMention,
  QUEUED_BUBBLE,
  respond,
  RUNNING_BUBBLE,
  submitTask,
  waitForCompletion,
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

describe('bubbleForK8sPhase', () => {
  it('maps each non-terminal k8s phase to its bubble and everything else to undefined', () => {
    expect({
      Pending: bubbleForK8sPhase('Pending'),
      Queued: bubbleForK8sPhase('Queued'),
      Running: bubbleForK8sPhase('Running'),
      Completed: bubbleForK8sPhase('Completed'),
      Failed: bubbleForK8sPhase('Failed'),
      Unknown: bubbleForK8sPhase('Cancelled'),
      Undefined: bubbleForK8sPhase(undefined),
    }).toEqual({
      Pending: PREPARING_BUBBLE,
      Queued: QUEUED_BUBBLE,
      Running: RUNNING_BUBBLE,
      Completed: undefined,
      Failed: undefined,
      Unknown: undefined,
      Undefined: undefined,
    })
  })
})

describe('submitTask', () => {
  it('creates a Task CR with the Slack envelope contexts and records the task_name', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
    }

    const result = await submitTask(ENV, deps)

    const expectedName = taskCrNameForSlackEvent(ENV.eventId)
    expect({
      result,
      creates: taskCrClient.creates,
      marked: eventLogStore.markedTaskNames,
    }).toEqual({
      result: { taskName: expectedName },
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

  it('attaches the opencode session id when a thread is already mapped', async () => {
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
    await submitTask(ENV, deps)
    const expectedName = taskCrNameForSlackEvent(ENV.eventId)
    expect(taskCrClient.creates).toEqual([
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
          {
            name: 'opencode-session-id',
            mountPath: 'slack-context/session-id',
            text: 'ses_abc',
          },
        ],
      },
    ])
  })
})

describe('waitForCompletion', () => {
  it('polls until the Task CR reaches Completed and emits a bubble whenever the displayed status changes', async () => {
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
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    const outcome = await waitForCompletion(ENV, taskName, deps, {
      initialBubble: PREPARING_BUBBLE,
    })

    expect({
      outcome,
      listCount: taskCrClient.listCount(),
      slackCalls: slackClient.calls,
    }).toEqual({
      outcome: { kind: 'completed' },
      listCount: 3,
      slackCalls: [
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: QUEUED_BUBBLE.status,
          loadingMessages: QUEUED_BUBBLE.loadingMessages,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: RUNNING_BUBBLE.status,
          loadingMessages: RUNNING_BUBBLE.loadingMessages,
        },
      ],
    })
  })

  it('returns Failed with the cluster message and does not emit a bubble when the Task CR transitions straight to Failed', async () => {
    const taskName = 'task-1'
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: 'Failed',
          message: 'boom',
        },
      ]),
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    const outcome = await waitForCompletion(ENV, taskName, deps)
    expect({ outcome, slackCalls: slackClient.calls }).toEqual({
      outcome: { kind: 'failed', message: 'boom' },
      slackCalls: [],
    })
  })

  it('keeps sleeping past unknown / undefined phases without busy-looping', async () => {
    const taskName = 'task-1'
    let sleepCount = 0
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([
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
          phase: 'Completed',
          message: undefined,
        },
      ]),
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
      pollIntervalMs: 0,
      sleep: async () => {
        sleepCount += 1
      },
    }
    const outcome = await waitForCompletion(ENV, taskName, deps)
    expect({ outcome, sleepCount }).toEqual({
      outcome: { kind: 'completed' },
      sleepCount: 2,
    })
  })

  it('throws when the Task CR is absent from the list result so the background poll loop terminates', async () => {
    const taskName = 'task-1'
    const deps: ProcessMentionDeps = {
      taskCrClient: {
        async create() {
          return 'created'
        },
        async list() {
          return []
        },
      },
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    await expect(waitForCompletion(ENV, taskName, deps)).rejects.toThrow(
      `Task CR ${taskName} not found in namespace kubeopencode`,
    )
  })

  it('does not re-emit the Preparing bubble when the first observed phase is Pending', async () => {
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
        phase: 'Completed',
        message: undefined,
      },
    ])
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    const outcome = await waitForCompletion(ENV, taskName, deps, {
      initialBubble: PREPARING_BUBBLE,
    })
    expect({
      outcome,
      slackCalls: slackClient.calls,
      listCount: taskCrClient.listCount(),
    }).toEqual({
      outcome: { kind: 'completed' },
      slackCalls: [],
      listCount: 2,
    })
  })
})

describe('respond', () => {
  it('posts the slackified assistant text and upserts the opencode session id on completed', async () => {
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: '**bold** answer',
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
    }
    const outcome: TerminalOutcome = { kind: 'completed' }
    await respond(ENV, 'task-1', outcome, deps)
    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
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

  it('posts an escaped failure message and does not upsert thread session on failed', async () => {
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
    }
    const outcome: TerminalOutcome = {
      kind: 'failed',
      message: '<oops> & died',
    }
    await respond(ENV, 'task-1', outcome, deps)
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
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: undefined,
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
    }
    await respond(ENV, 'task-1', { kind: 'completed' }, deps)
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

  it('skips the Slack post and per-task teardown when event_log markResponded reports already-responded', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      alreadyResponded: true,
    })
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: 'answer',
      }),
      eventLogStore,
      threadSessionStore,
      slackClient,
    }
    await respond(ENV, 'task-1', { kind: 'completed' }, deps)
    expect({
      slackCalls: slackClient.calls,
      markedResponded: eventLogStore.markedResponded,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [],
      markedResponded: [],
      upserts: [],
    })
  })
})

describe('processMention', () => {
  it('drives a submitted task through Queued → Running → Completed and posts the slackified reply', async () => {
    const taskName = 'task-1'
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      taskCrClient: createScriptedTaskCrClient([
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
      ]),
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

    await processMention(ENV, taskName, deps, {
      initialBubble: PREPARING_BUBBLE,
    })

    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: QUEUED_BUBBLE.status,
          loadingMessages: QUEUED_BUBBLE.loadingMessages,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: RUNNING_BUBBLE.status,
          loadingMessages: RUNNING_BUBBLE.loadingMessages,
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
})
