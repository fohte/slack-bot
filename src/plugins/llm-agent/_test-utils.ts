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
}

export const createFakeA2aTaskTracker = (
  options: {
    readonly activeInputRequired?: A2aTaskRow | undefined
    readonly contextId?: string | undefined
    readonly transitionResult?: { updated: boolean } | undefined
  } = {},
): RecordingA2aTaskTracker => {
  const recorded: NewA2aTask[] = []
  const transitions: Array<{ taskId: string; to: A2aTaskLifecycle }> = []
  return {
    recorded,
    transitions,
    async recordDelegated(rec) {
      recorded.push(rec)
    },
    async findActiveInputRequired() {
      return options.activeInputRequired
    },
    async findUnsettled() {
      return []
    },
    async transition(taskId, to) {
      transitions.push({ taskId, to })
      return options.transitionResult ?? { updated: true }
    },
    async lookupContext() {
      return options.contextId
    },
  }
}
