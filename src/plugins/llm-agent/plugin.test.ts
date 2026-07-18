import { emptyCheckpoint, MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'

import type { EventContext } from '@/interaction/event-context'
import { noopLogger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import { createPluginRegistry } from '@/plugin/registry'
import { createFakeA2aTaskTracker } from '@/plugins/llm-agent/_test-utils'
import type { A2aTaskRow } from '@/plugins/llm-agent/a2a-task-tracker'
import { deriveConversationThreadId } from '@/plugins/llm-agent/conversation-agent'
import type {
  EventLogOutcome,
  EventLogRecord,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type {
  LlmAgentAcceptedEvent,
  LlmAgentPluginOptions,
} from '@/plugins/llm-agent/plugin'
import {
  createLlmAgentPlugin,
  LLM_AGENT_EVENT_SUBSCRIPTIONS,
  LLM_AGENT_PLUGIN_NAME,
} from '@/plugins/llm-agent/plugin'
import { createInteractionRouter } from '@/router/router'
import type { SlackWebClient } from '@/slack/web-client'
import type {
  SlackAppMentionEvent,
  SlackEvent,
  SlackEventCallback,
  SlackMessageEvent,
} from '@/types/slack-payloads'

type OnEventFn = NonNullable<Plugin['onEvent']>
type OnEventArgs = [EventContext, SlackEvent]

const stubSlackClient = (): SlackWebClient =>
  ({
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    openView: vi.fn(),
    updateView: vi.fn(),
    pushView: vi.fn(),
    postToResponseUrl: vi.fn(),
  }) as unknown as SlackWebClient

interface InMemoryEventLogStore extends EventLogStore {
  readonly records: readonly EventLogRecord[]
}

const createInMemoryEventLogStore = (): InMemoryEventLogStore => {
  const seen = new Set<string>()
  const records: EventLogRecord[] = []
  return {
    records,
    async recordReceived(record): Promise<EventLogOutcome> {
      if (seen.has(record.slackEventId)) return 'rejected_duplicate'
      seen.add(record.slackEventId)
      records.push(record)
      return 'accepted'
    },
    async deleteReceived(slackEventId): Promise<void> {
      seen.delete(slackEventId)
      const index = records.findIndex((r) => r.slackEventId === slackEventId)
      if (index >= 0) records.splice(index, 1)
    },
    async markTaskName(): Promise<{ updated: number }> {
      return { updated: 1 }
    },
    async findByTaskName() {
      return undefined
    },
    async findDispatchedUnresponded() {
      return []
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
    async hasAcceptedSibling({
      slackTeamId,
      slackChannelId,
      messageTs,
      excludeSlackEventId,
    }): Promise<boolean> {
      return records.some(
        (r) =>
          r.slackEventId !== excludeSlackEventId &&
          r.slackTeamId === slackTeamId &&
          r.slackChannelId === slackChannelId &&
          r.messageTs === messageTs,
      )
    },
  }
}

const BOT_USER_ID = 'U_BOT'

// Marks a thread_id as having existing conversation state, using the real
// in-memory BaseCheckpointSaver implementation rather than a hand-rolled
// fake, so a method this suite doesn't stub can't silently no-op.
const seedCheckpoint = (
  checkpointer: MemorySaver,
  threadId: string,
): Promise<unknown> =>
  checkpointer.put(
    { configurable: { thread_id: threadId } },
    emptyCheckpoint(),
    {
      source: 'update',
      step: -1,
      parents: {},
    },
  )

const buildPluginOptions = (
  overrides: Partial<LlmAgentPluginOptions> = {},
): LlmAgentPluginOptions => ({
  eventLogStore: createInMemoryEventLogStore(),
  checkpointer: new MemorySaver(),
  a2aTaskTracker: createFakeA2aTaskTracker(),
  botUserId: BOT_USER_ID,
  ...overrides,
})

const normalizePlugin = (plugin: Plugin): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(plugin)) {
    out[key] = typeof value === 'function' ? '<fn>' : value
  }
  return out
}

const buildMessageEnvelope = (
  eventId: string,
  overrides: Partial<SlackMessageEvent> = {},
): SlackEventCallback => {
  const event: SlackMessageEvent = {
    type: 'message',
    channel: 'C123',
    user: 'U123',
    text: 'hello',
    ts: '1700000000.000100',
    channel_type: 'im',
    ...overrides,
  }
  return {
    type: 'event_callback',
    team_id: 'T123',
    event,
    event_id: eventId,
    event_time: 1700000000,
  }
}

const buildAppMentionEnvelope = (
  eventId: string,
  overrides: Partial<SlackAppMentionEvent> = {},
): SlackEventCallback => {
  const event: SlackAppMentionEvent = {
    type: 'app_mention',
    channel: 'C123',
    user: 'U123',
    text: '<@U_BOT> hi',
    ts: '1700000000.000100',
    ...overrides,
  }
  return {
    type: 'event_callback',
    team_id: 'T123',
    event,
    event_id: eventId,
    event_time: 1700000000,
  }
}

describe('createLlmAgentPlugin', () => {
  it('exposes the expected plugin shape', () => {
    const plugin = createLlmAgentPlugin(buildPluginOptions())
    expect(normalizePlugin(plugin)).toEqual({
      name: LLM_AGENT_PLUGIN_NAME,
      commands: [],
      eventSubscriptions: LLM_AGENT_EVENT_SUBSCRIPTIONS,
      onEvent: '<fn>',
    })
  })

  it('dispatches message and app_mention events through the router', async () => {
    const onEvent = vi.fn<OnEventFn>(async () => {})
    const plugin = createLlmAgentPlugin(buildPluginOptions())
    const wrappedPlugin = { ...plugin, onEvent }
    const registry = createPluginRegistry()
    registry.register(wrappedPlugin)

    const router = createInteractionRouter({
      registry,
      slackClient: stubSlackClient(),
      logger: noopLogger,
      now: () => 0,
    })

    const messageEvent: SlackMessageEvent = {
      type: 'message',
      channel: 'C123',
      user: 'U123',
      text: 'hello',
      ts: '1700000000.000100',
    }
    const messageEnvelope: SlackEventCallback = {
      type: 'event_callback',
      team_id: 'T123',
      event: messageEvent,
      event_id: 'Ev1',
      event_time: 1700000000,
    }
    await router.routeEvent(messageEnvelope)

    const appMentionEvent: SlackAppMentionEvent = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U123',
      text: '<@U_BOT> hi',
      ts: '1700000001.000200',
    }
    const appMentionEnvelope: SlackEventCallback = {
      type: 'event_callback',
      team_id: 'T123',
      event: appMentionEvent,
      event_id: 'Ev2',
      event_time: 1700000001,
    }
    await router.routeEvent(appMentionEnvelope)

    const calls = onEvent.mock.calls as readonly OnEventArgs[]
    const normalized = calls.map(([ctx, event]) => ({
      envelope: ctx.envelope,
      event,
    }))
    expect(normalized).toEqual([
      { envelope: messageEnvelope, event: messageEvent },
      { envelope: appMentionEnvelope, event: appMentionEvent },
    ])
  })

  it('does not dispatch events whose type is not subscribed', async () => {
    const onEvent = vi.fn<OnEventFn>(async () => {})
    const plugin = createLlmAgentPlugin(buildPluginOptions())
    const wrappedPlugin = { ...plugin, onEvent }
    const registry = createPluginRegistry()
    registry.register(wrappedPlugin)

    const router = createInteractionRouter({
      registry,
      slackClient: stubSlackClient(),
      logger: noopLogger,
      now: () => 0,
    })

    await router.routeEvent({
      type: 'event_callback',
      team_id: 'T123',
      event: { type: 'reaction_added' },
      event_id: 'Ev3',
      event_time: 1700000002,
    })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('records the event and invokes onAccepted on first delivery', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-first', {
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-first',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000050',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted).toHaveBeenCalledTimes(1)
    expect(onAccepted.mock.calls[0]?.[0]).toEqual({
      ctx: { envelope },
      event: envelope.event,
    })
  })

  it('falls back to event ts as thread root when thread_ts is absent', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const plugin = createLlmAgentPlugin(buildPluginOptions({ eventLogStore }))
    const envelope = buildMessageEnvelope('Ev-no-thread')

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-no-thread',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
  })

  it('treats a redelivered event as rejected_duplicate and skips onAccepted', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-retry')

    await plugin.onEvent?.({ envelope }, envelope.event)
    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-retry',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted).toHaveBeenCalledTimes(1)
  })

  it('skips event_log writes for bot_message subtype', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-bot', { subtype: 'bot_message' })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(recordSpy).not.toHaveBeenCalled()
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('skips event_log writes for messages carrying bot_id', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin(buildPluginOptions({ eventLogStore }))
    const envelope = buildMessageEnvelope('Ev-botid', { bot_id: 'B1' })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('rolls back the event_log row when onAccepted throws so retries can re-process', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const error = new Error('downstream failure')
    const onAccepted = vi
      .fn<(event: LlmAgentAcceptedEvent) => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined)
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-retryable')

    await expect(
      plugin.onEvent?.({ envelope }, envelope.event),
    ).rejects.toThrow(error)
    expect(eventLogStore.records).toEqual([])

    await plugin.onEvent?.({ envelope }, envelope.event)
    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-retryable',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted).toHaveBeenCalledTimes(2)
  })

  it('skips event_log writes for app_mention events carrying bot_id', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin(buildPluginOptions({ eventLogStore }))
    const envelope: SlackEventCallback = {
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@U_BOT> hi',
        ts: '1700000001.000200',
        bot_id: 'B1',
      },
      event_id: 'Ev-mention-bot',
      event_time: 1700000001,
    }

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('skips event_log writes when envelope has no event_id', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin(buildPluginOptions({ eventLogStore }))
    const envelope: SlackEventCallback = {
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U123',
        text: 'hi',
        ts: '1700000000.000100',
      },
      event_time: 1700000000,
    }

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('accepts DM messages without requiring a bot mention', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-dm', {
      channel_type: 'im',
      text: 'just chatting',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-dm',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('accepts channel app_mention events', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildAppMentionEnvelope('Ev-mention', {
      ts: '1700000001.000200',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-mention',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000001.000200',
        messageTs: '1700000001.000200',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('skips channel message events that mention the bot to avoid duplicating the app_mention delivery', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-msg-with-mention', {
      channel_type: 'channel',
      text: '<@U_BOT|botname> hi there',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([])
    expect(onAccepted.mock.calls.length).toBe(0)
  })

  it('dispatches a mention only once when both message and app_mention are delivered', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )

    const messageEnvelope = buildMessageEnvelope('Ev-dup-msg', {
      channel_type: 'channel',
      text: '<@U_BOT> hi',
    })
    const appMentionEnvelope = buildAppMentionEnvelope('Ev-dup-mention')

    await plugin.onEvent?.({ envelope: messageEnvelope }, messageEnvelope.event)
    await plugin.onEvent?.(
      { envelope: appMentionEnvelope },
      appMentionEnvelope.event,
    )

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-dup-mention',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('accepts mention-less channel messages when the thread already has conversation checkpoint state', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const checkpointer = new MemorySaver()
    await seedCheckpoint(
      checkpointer,
      deriveConversationThreadId({
        teamId: 'T123',
        channelId: 'C123',
        threadRootTs: '1700000000.000050',
      }),
    )
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, checkpointer, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-thread-hit', {
      channel_type: 'channel',
      text: 'follow up',
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-thread-hit',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000050',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('accepts mention-less channel messages when the thread has an active input-required task', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const activeInputRequired: A2aTaskRow = {
      taskId: 'task-1',
      contextId: 'ctx-1',
      agentName: 'meshi',
      slackTeamId: 'T123',
      slackChannelId: 'C123',
      threadRootTs: '1700000000.000050',
      slackEventId: 'Ev-delegated',
      state: 'input-required',
      settled: false,
      deadlineAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }
    const a2aTaskTracker = createFakeA2aTaskTracker({ activeInputRequired })
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, a2aTaskTracker, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-task-resume', {
      channel_type: 'channel',
      text: 'here is the missing detail',
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-task-resume',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000050',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('accepts mention-less channel messages via the active task hit when the checkpoint lookup fails', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const activeInputRequired: A2aTaskRow = {
      taskId: 'task-1',
      contextId: 'ctx-1',
      agentName: 'meshi',
      slackTeamId: 'T123',
      slackChannelId: 'C123',
      threadRootTs: '1700000000.000050',
      slackEventId: 'Ev-delegated',
      state: 'input-required',
      settled: false,
      deadlineAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }
    const a2aTaskTracker = createFakeA2aTaskTracker({ activeInputRequired })
    const checkpointer = new MemorySaver()
    vi.spyOn(checkpointer, 'get').mockRejectedValue(
      new Error('checkpoint store unavailable'),
    )
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({
        eventLogStore,
        checkpointer,
        a2aTaskTracker,
        onAccepted,
      }),
    )
    const envelope = buildMessageEnvelope('Ev-task-resume-checkpoint-down', {
      channel_type: 'channel',
      text: 'here is the missing detail',
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-task-resume-checkpoint-down',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000050',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('accepts mention-less channel messages via the checkpoint hit when the active task lookup fails', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const checkpointer = new MemorySaver()
    await seedCheckpoint(
      checkpointer,
      deriveConversationThreadId({
        teamId: 'T123',
        channelId: 'C123',
        threadRootTs: '1700000000.000050',
      }),
    )
    const a2aTaskTracker = createFakeA2aTaskTracker()
    vi.spyOn(a2aTaskTracker, 'findActiveInputRequired').mockRejectedValue(
      new Error('a2a_task query failed'),
    )
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({
        eventLogStore,
        checkpointer,
        a2aTaskTracker,
        onAccepted,
      }),
    )
    const envelope = buildMessageEnvelope('Ev-thread-hit-task-lookup-down', {
      channel_type: 'channel',
      text: 'follow up',
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-thread-hit-task-lookup-down',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000050',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('skips mention-less channel messages when no conversation state exists for the thread', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-thread-miss', {
      channel_type: 'channel',
      text: 'random chatter',
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([])
    expect(onAccepted.mock.calls.length).toBe(0)
  })

  it('rejects top-level channel messages without thread_ts when there is no mention', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-top-level', {
      channel_type: 'channel',
      text: 'random chatter',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([])
    expect(onAccepted.mock.calls.length).toBe(0)
  })

  it('skips the conversation state lookups for top-level channel messages without thread_ts', async () => {
    const checkpointer = new MemorySaver()
    const a2aTaskTracker = createFakeA2aTaskTracker()
    const getSpy = vi.spyOn(checkpointer, 'get')
    const findActiveInputRequiredSpy = vi.spyOn(
      a2aTaskTracker,
      'findActiveInputRequired',
    )
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ checkpointer, a2aTaskTracker }),
    )
    const envelope = buildMessageEnvelope('Ev-top-level-lookup', {
      channel_type: 'channel',
      text: 'random chatter',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(getSpy.mock.calls.length).toBe(0)
    expect(findActiveInputRequiredSpy.mock.calls.length).toBe(0)
  })

  it('skips message_changed subtype even when the edited body mentions the bot', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-edited', {
      channel_type: 'channel',
      subtype: 'message_changed',
      text: '<@U_BOT> please',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([])
    expect(onAccepted.mock.calls.length).toBe(0)
  })

  it('accepts file_share subtype messages when the thread already has conversation checkpoint state', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const checkpointer = new MemorySaver()
    await seedCheckpoint(
      checkpointer,
      deriveConversationThreadId({
        teamId: 'T123',
        channelId: 'C123',
        threadRootTs: '1700000000.000050',
      }),
    )
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, checkpointer, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-file-thread-hit', {
      channel_type: 'channel',
      subtype: 'file_share',
      text: 'this is what I had for lunch',
      thread_ts: '1700000000.000050',
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-file-thread-hit',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000050',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('accepts a channel message that mentions the bot when it carries a file_share attachment', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )
    const envelope = buildMessageEnvelope('Ev-img-msg', {
      channel_type: 'channel',
      subtype: 'file_share',
      text: '<@U_BOT> this is what I had for lunch',
      files: [{ id: 'F1', mimetype: 'image/png' }],
    })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-img-msg',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.map(([event]) => event)).toEqual([
      { ctx: { envelope }, event: envelope.event },
    ])
  })

  it('rejects app_mention as duplicate once its file_share sibling has been accepted', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )

    const messageEnvelope = buildMessageEnvelope('Ev-img-msg-first', {
      channel_type: 'channel',
      subtype: 'file_share',
      text: '<@U_BOT> hi',
      files: [{ id: 'F1', mimetype: 'image/png' }],
    })
    const appMentionEnvelope = buildAppMentionEnvelope('Ev-img-mention-second')

    await plugin.onEvent?.({ envelope: messageEnvelope }, messageEnvelope.event)
    await plugin.onEvent?.(
      { envelope: appMentionEnvelope },
      appMentionEnvelope.event,
    )

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-img-msg-first',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(1)
  })

  it('still accepts a later file_share message when its app_mention sibling was accepted first', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin(
      buildPluginOptions({ eventLogStore, onAccepted }),
    )

    const appMentionEnvelope = buildAppMentionEnvelope('Ev-mention-first')
    const messageEnvelope = buildMessageEnvelope('Ev-img-msg-second', {
      channel_type: 'channel',
      subtype: 'file_share',
      text: '<@U_BOT> hi',
      files: [{ id: 'F1', mimetype: 'image/png' }],
    })

    await plugin.onEvent?.(
      { envelope: appMentionEnvelope },
      appMentionEnvelope.event,
    )
    await plugin.onEvent?.({ envelope: messageEnvelope }, messageEnvelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-mention-first',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
      {
        slackEventId: 'Ev-img-msg-second',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
        messageTs: '1700000000.000100',
      },
    ])
    expect(onAccepted.mock.calls.length).toBe(2)
  })
})
