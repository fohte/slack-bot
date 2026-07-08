import type { ConfigMapClient } from '@/plugins/llm-agent/configmap-client'
import type {
  EventLogRow,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type {
  ImageResizer,
  ResizeOutcome,
} from '@/plugins/llm-agent/image-resizer'
import type { OpencodeClient } from '@/plugins/llm-agent/opencode-client'
import type { SlackEnvelope } from '@/plugins/llm-agent/process-mention'
import type {
  TaskCrClient,
  TaskCrCreateOutcome,
  TaskCrSpec,
  TaskCrStatus,
} from '@/plugins/llm-agent/task-cr-client'
import type {
  ThreadSessionKey,
  ThreadSessionStore,
  ThreadSessionUpsert,
} from '@/plugins/llm-agent/thread-session-store'
import type { SlackWebClient } from '@/slack/web-client'

export interface SlackCall {
  readonly kind: 'status' | 'post'
  readonly channel: string
  readonly thread: string
  readonly text: string
  readonly blocks: readonly unknown[] | undefined
  readonly loadingMessages: readonly string[] | undefined
}

export interface StubSlackClient extends SlackWebClient {
  readonly calls: ReadonlyArray<SlackCall>
}

export const createStubSlackClient = (): StubSlackClient => {
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
        blocks: undefined,
        loadingMessages: arg.loading_messages,
      })
      return { ok: true } as never
    },
    async postMessage(arg: {
      channel?: string
      thread_ts?: string
      text?: string
      blocks?: unknown[]
    }) {
      calls.push({
        kind: 'post',
        channel: arg.channel ?? '',
        thread: arg.thread_ts ?? '',
        text: arg.text ?? '',
        blocks: arg.blocks,
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
    async downloadFile() {
      throw new Error('not implemented')
    },
  } as StubSlackClient
}

export interface ScriptedTaskCrClient extends TaskCrClient {
  readonly creates: ReadonlyArray<TaskCrSpec>
  readonly listCount: () => number
}

// list() returns the next scripted status per call, then clamps to the
// final element so excess polls keep observing the terminal phase.
export const createScriptedTaskCrClient = (
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

export interface ScriptedEventLogStore extends EventLogStore {
  readonly markedTaskNames: ReadonlyArray<{ id: string; name: string }>
  readonly markedResponded: ReadonlyArray<string>
}

export const createScriptedEventLogStore = (
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
    async hasAcceptedSibling() {
      return false
    },
  }
}

export interface ScriptedThreadSessionStore extends ThreadSessionStore {
  readonly upserts: ReadonlyArray<ThreadSessionUpsert>
}

export const createScriptedThreadSessionStore = (
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

export const fixedOpencodeClient = (
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

export const TEST_ENV: SlackEnvelope = {
  eventId: 'Ev1',
  teamId: 'T1',
  channelId: 'C1',
  threadRootTs: '111.222',
  text: 'hello bot',
  images: [],
}

export interface ScriptedImageResizer extends ImageResizer {
  readonly calls: ReadonlyArray<{ readonly maxBytes: number }>
}

export const createScriptedImageResizer = (
  resize: (bytes: Uint8Array, maxBytes: number) => ResizeOutcome,
): ScriptedImageResizer => {
  const calls: Array<{ maxBytes: number }> = []
  return {
    calls,
    async resize(bytes, maxBytes) {
      calls.push({ maxBytes })
      return resize(bytes, maxBytes)
    },
  }
}

export const noopConfigMapClient: ConfigMapClient = {
  async create() {
    throw new Error('configMapClient.create not implemented for this test')
  },
  async delete() {
    return 'not_found'
  },
}
