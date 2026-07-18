import type { AgentCard, Message, MessageSendParams, Task } from '@a2a-js/sdk'
import type { Client } from '@a2a-js/sdk/client'

import type { Logger } from '@/logger/logger'
import type {
  A2aTaskLifecycle,
  A2aTaskRow,
  A2aTaskTracker,
  NewA2aTask,
  ThreadKey,
} from '@/plugins/llm-agent/a2a-task-tracker'
import {
  FIND_UNSETTLED_LIMIT,
  isA2aTaskTerminalState,
  transitionGuard,
} from '@/plugins/llm-agent/a2a-task-tracker'
import type {
  ConversationAgent,
  ConversationAgentInput,
  ConversationOutcome,
} from '@/plugins/llm-agent/conversation-agent'
import type { SlackEnvelope } from '@/plugins/llm-agent/dispatcher-deps'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import type {
  ImageResizer,
  ResizeOutcome,
} from '@/plugins/llm-agent/image-resizer'
import type {
  RemoteAgentHandle,
  RemoteAgentRegistry,
} from '@/plugins/llm-agent/remote-agent-registry'
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
    async getFileInfo() {
      throw new Error('not implemented')
    },
  } as StubSlackClient
}

export interface ScriptedEventLogStore extends EventLogStore {
  readonly markedResponded: ReadonlyArray<string>
}

// markResponded/unmarkResponded model the real store's conditional-UPDATE
// idempotency (a second markResponded for the same event_id is a no-op);
// the other EventLogStore methods are unused by the new dispatcher and
// stubbed only to satisfy the interface.
export const createScriptedEventLogStore = (
  options: { alreadyResponded?: boolean } = {},
): ScriptedEventLogStore => {
  const markedResponded: string[] = []
  const responded = new Set<string>()
  return {
    markedResponded,
    async recordReceived() {
      return 'accepted'
    },
    async deleteReceived() {},
    async markTaskName() {
      return { updated: 0 }
    },
    async findByTaskName() {
      return undefined
    },
    async findDispatchedUnresponded() {
      return []
    },
    async markResponded(slackEventId) {
      if (options.alreadyResponded === true || responded.has(slackEventId)) {
        return { updated: 0 }
      }
      responded.add(slackEventId)
      markedResponded.push(slackEventId)
      return { updated: 1 }
    },
    async unmarkResponded(slackEventId) {
      if (!responded.has(slackEventId)) return { updated: 0 }
      responded.delete(slackEventId)
      return { updated: 1 }
    },
    async pruneOlderThan() {
      return 0
    },
    async hasAcceptedSibling() {
      return false
    },
  }
}

export const TEST_ENV: SlackEnvelope = {
  eventId: 'Ev1',
  teamId: 'T1',
  channelId: 'C1',
  threadRootTs: '111.222',
  text: 'hello bot',
  images: [],
}

export const TEST_THREAD_KEY: ThreadKey = {
  slackTeamId: TEST_ENV.teamId,
  slackChannelId: TEST_ENV.channelId,
  threadRootTs: TEST_ENV.threadRootTs,
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

export interface LogEntry {
  readonly level: 'warn' | 'error'
  readonly payload: Record<string, unknown>
  readonly message: string
}

export interface RecordingLogger extends Logger {
  readonly entries: ReadonlyArray<LogEntry>
}

export const createRecordingLogger = (): RecordingLogger => {
  const entries: LogEntry[] = []
  const logger: RecordingLogger = {
    entries,
    debug() {},
    info() {},
    warn(payload, message) {
      entries.push({ level: 'warn', payload, message: message ?? '' })
    },
    error(payload, message) {
      entries.push({ level: 'error', payload, message: message ?? '' })
    },
    child() {
      return logger
    },
  }
  return logger
}

export interface RecordingConversationAgent extends ConversationAgent {
  readonly calls: ReadonlyArray<ConversationAgentInput>
}

// Records every respond() call and replies with `reply(input)`, so tests
// can assert on exactly what the dispatcher sent the conversation agent
// without a real LangGraph/LLM call.
export const createFakeConversationAgent = (
  reply: (
    input: ConversationAgentInput,
  ) => ConversationOutcome | Promise<ConversationOutcome>,
): RecordingConversationAgent => {
  const calls: ConversationAgentInput[] = []
  return {
    calls,
    async respond(input) {
      calls.push(input)
      return reply(input)
    },
  }
}

export const createFakeRemoteAgentRegistry = (
  handles: readonly RemoteAgentHandle[],
): RemoteAgentRegistry => ({
  async listAgents() {
    return handles
  },
})

export const cardFor = (overrides: Partial<AgentCard> = {}): AgentCard => ({
  protocolVersion: '0.3.0',
  name: 'meshi',
  description: 'Tracks meals and food logs.',
  url: 'https://meshi.example.com',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
  ...overrides,
})

// Wraps a canned sendMessage response with a call recorder, so tests assert
// on the params actually sent instead of asserting from inside the stub
// (which would pass vacuously if sendMessage were never called).
export const recordingHandleFor = (
  respond: (params: MessageSendParams) => Promise<Message | Task>,
  card: AgentCard = cardFor(),
): {
  readonly handle: RemoteAgentHandle
  readonly calls: MessageSendParams[]
} => {
  const calls: MessageSendParams[] = []
  const sendMessage = async (params: MessageSendParams) => {
    calls.push(params)
    return respond(params)
  }
  return {
    handle: {
      name: card.name,
      card,
      client: { sendMessage } as unknown as Client,
    },
    calls,
  }
}

// Wraps a canned getTask response with a call recorder, mirroring
// recordingHandleFor but for tasks/get instead of message/send. Used by
// ResponseFinalizer tests, which only ever call getTask on a handle.
export const recordingHandleForGetTask = (
  respond: (taskId: string) => Promise<Task>,
  card: AgentCard = cardFor(),
): {
  readonly handle: RemoteAgentHandle
  readonly calls: string[]
} => {
  const calls: string[] = []
  const getTask = async (params: { id: string }) => {
    calls.push(params.id)
    return respond(params.id)
  }
  return {
    handle: {
      name: card.name,
      card,
      client: { getTask } as unknown as Client,
    },
    calls,
  }
}

// Wraps a handle wired for both message/send and tasks/get, so a single
// remote agent can carry a task through delegation and settlement in the
// same test (unlike recordingHandleFor/recordingHandleForGetTask above,
// which each cover only one leg of that lifecycle).
export const createStubRemoteAgent = (options: {
  readonly card?: AgentCard
  readonly sendResult: (params: MessageSendParams) => Promise<Message | Task>
  readonly getTaskResult: (taskId: string) => Promise<Task>
}): { readonly handle: RemoteAgentHandle; readonly getTaskCalls: string[] } => {
  const getTaskCalls: string[] = []
  const sendMessage = async (params: MessageSendParams) =>
    options.sendResult(params)
  const getTask = async (params: { id: string }) => {
    getTaskCalls.push(params.id)
    return options.getTaskResult(params.id)
  }
  const card = options.card ?? cardFor()
  return {
    handle: {
      name: card.name,
      card,
      client: { sendMessage, getTask } as unknown as Client,
    },
    getTaskCalls,
  }
}

export const taskResult = (overrides: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: 'submitted' },
  ...overrides,
})

export interface RecordingA2aTaskTracker extends A2aTaskTracker {
  readonly recorded: NewA2aTask[]
  readonly transitions: ReadonlyArray<{
    readonly taskId: string
    readonly to: A2aTaskLifecycle
  }>
  readonly unsettled: string[]
}

export const createFakeA2aTaskTracker = (
  options: {
    readonly activeInputRequired?: A2aTaskRow | undefined
    readonly contextId?: string | undefined
    readonly transitionResult?: { updated: boolean } | undefined
    readonly rowsByTaskId?: Record<string, A2aTaskRow | undefined> | undefined
  } = {},
): RecordingA2aTaskTracker => {
  const recorded: NewA2aTask[] = []
  const transitions: Array<{ taskId: string; to: A2aTaskLifecycle }> = []
  const unsettled: string[] = []
  return {
    recorded,
    transitions,
    unsettled,
    async recordDelegated(rec) {
      recorded.push(rec)
    },
    async findActiveInputRequired() {
      return options.activeInputRequired
    },
    async findUnsettled() {
      return []
    },
    async findByTaskId(taskId) {
      return options.rowsByTaskId?.[taskId]
    },
    async transition(taskId, to) {
      transitions.push({ taskId, to })
      return options.transitionResult ?? { updated: true }
    },
    async unsettle(taskId) {
      unsettled.push(taskId)
      return { updated: true }
    },
    async lookupContext() {
      return options.contextId
    },
    async deleteSettledOlderThan() {
      return 0
    },
  }
}

// Full reference implementation of A2aTaskTracker backed by a plain Map,
// reusing the production guard/settled decisions (transitionGuard,
// A2A_TASK_TERMINAL_STATES) so its conditional-UPDATE semantics track the
// real Postgres store. Unlike createFakeA2aTaskTracker above (which just
// records calls and returns a fixed result), this one is genuinely
// stateful — needed by tests that exercise a sequence of calls against the
// same row (e.g. a duplicate push notification, or a reconciler poll after
// a push already settled it) and assert on how the state evolved.
export const createInMemoryA2aTaskTracker = (
  options: { now?: () => Date } = {},
): A2aTaskTracker => {
  const now = options.now ?? (() => new Date())
  const rows = new Map<string, A2aTaskRow>()

  return {
    async recordDelegated(rec) {
      if (rows.has(rec.taskId)) return
      const timestamp = now()
      rows.set(rec.taskId, {
        ...rec,
        settled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    },
    async findActiveInputRequired(threadKey) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.slackTeamId === threadKey.slackTeamId &&
            row.slackChannelId === threadKey.slackChannelId &&
            row.threadRootTs === threadKey.threadRootTs &&
            row.state === 'input-required' &&
            !row.settled,
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    },
    async findUnsettled(olderThan) {
      return [...rows.values()]
        .filter((row) => !row.settled && row.updatedAt < olderThan)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, FIND_UNSETTLED_LIMIT)
    },
    async findByTaskId(taskId) {
      return rows.get(taskId)
    },
    async transition(taskId, to) {
      const row = rows.get(taskId)
      if (row === undefined || row.settled) return { updated: false }
      const guard = transitionGuard(to)
      if (
        guard.requireStates !== undefined &&
        !guard.requireStates.includes(row.state)
      ) {
        return { updated: false }
      }
      if (
        to.ifDeadlineAtOrBefore !== undefined &&
        row.deadlineAt > to.ifDeadlineAtOrBefore
      ) {
        return { updated: false }
      }
      rows.set(taskId, {
        ...row,
        state: to.state,
        settled: isA2aTaskTerminalState(to.state),
        deadlineAt: to.deadlineAt ?? row.deadlineAt,
        updatedAt: now(),
      })
      return { updated: true }
    },
    async unsettle(taskId) {
      const row = rows.get(taskId)
      if (row === undefined || !row.settled) return { updated: false }
      rows.set(taskId, { ...row, settled: false, updatedAt: now() })
      return { updated: true }
    },
    async lookupContext(threadKey, agentName) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.slackTeamId === threadKey.slackTeamId &&
            row.slackChannelId === threadKey.slackChannelId &&
            row.threadRootTs === threadKey.threadRootTs &&
            row.agentName === agentName,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        ?.contextId
    },
    async deleteSettledOlderThan(cutoff) {
      const toDelete = [...rows.values()].filter(
        (row) => row.settled && row.updatedAt < cutoff,
      )
      for (const row of toDelete) rows.delete(row.taskId)
      return toDelete.length
    },
  }
}
