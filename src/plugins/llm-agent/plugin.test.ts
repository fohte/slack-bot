import { describe, expect, it, vi } from 'vitest'

import type { EventContext } from '@/interaction/event-context'
import { noopLogger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import { createPluginRegistry } from '@/plugin/registry'
import type {
  EventLogOutcome,
  EventLogRecord,
  EventLogStore,
} from '@/plugins/llm-agent/event-log-store'
import type { LlmAgentAcceptedEvent } from '@/plugins/llm-agent/plugin'
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
    async pruneOlderThan(): Promise<number> {
      return 0
    },
  }
}

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
    const plugin = createLlmAgentPlugin({
      eventLogStore: createInMemoryEventLogStore(),
    })
    expect(normalizePlugin(plugin)).toEqual({
      name: LLM_AGENT_PLUGIN_NAME,
      commands: [],
      eventSubscriptions: LLM_AGENT_EVENT_SUBSCRIPTIONS,
      onEvent: '<fn>',
    })
  })

  it('dispatches message and app_mention events through the router', async () => {
    const onEvent = vi.fn<OnEventFn>(async () => {})
    const plugin = createLlmAgentPlugin({
      eventLogStore: createInMemoryEventLogStore(),
    })
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
    const plugin = createLlmAgentPlugin({
      eventLogStore: createInMemoryEventLogStore(),
    })
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
    const plugin = createLlmAgentPlugin({ eventLogStore, onAccepted })
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
    const plugin = createLlmAgentPlugin({ eventLogStore })
    const envelope = buildMessageEnvelope('Ev-no-thread')

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-no-thread',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
      },
    ])
  })

  it('treats a redelivered event as rejected_duplicate and skips onAccepted', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const plugin = createLlmAgentPlugin({ eventLogStore, onAccepted })
    const envelope = buildMessageEnvelope('Ev-retry')

    await plugin.onEvent?.({ envelope }, envelope.event)
    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(eventLogStore.records).toEqual([
      {
        slackEventId: 'Ev-retry',
        slackTeamId: 'T123',
        slackChannelId: 'C123',
        threadRootTs: '1700000000.000100',
      },
    ])
    expect(onAccepted).toHaveBeenCalledTimes(1)
  })

  it('skips event_log writes for bot_message subtype', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const onAccepted = vi.fn<(event: LlmAgentAcceptedEvent) => void>()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin({ eventLogStore, onAccepted })
    const envelope = buildMessageEnvelope('Ev-bot', { subtype: 'bot_message' })

    await plugin.onEvent?.({ envelope }, envelope.event)

    expect(recordSpy).not.toHaveBeenCalled()
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('skips event_log writes for messages carrying bot_id', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin({ eventLogStore })
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
    const plugin = createLlmAgentPlugin({ eventLogStore, onAccepted })
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
      },
    ])
    expect(onAccepted).toHaveBeenCalledTimes(2)
  })

  it('skips event_log writes for app_mention events carrying bot_id', async () => {
    const eventLogStore = createInMemoryEventLogStore()
    const recordSpy = vi.spyOn(eventLogStore, 'recordReceived')
    const plugin = createLlmAgentPlugin({ eventLogStore })
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
    const plugin = createLlmAgentPlugin({ eventLogStore })
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
})
