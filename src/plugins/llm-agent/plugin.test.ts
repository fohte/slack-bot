import { describe, expect, it, vi } from 'vitest'

import type { EventContext } from '@/interaction/event-context'
import { noopLogger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import { createPluginRegistry } from '@/plugin/registry'
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

const normalizePlugin = (plugin: Plugin): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(plugin)) {
    out[key] = typeof value === 'function' ? '<fn>' : value
  }
  return out
}

describe('createLlmAgentPlugin', () => {
  it('exposes the expected plugin shape', () => {
    expect(normalizePlugin(createLlmAgentPlugin())).toEqual({
      name: LLM_AGENT_PLUGIN_NAME,
      commands: [],
      eventSubscriptions: LLM_AGENT_EVENT_SUBSCRIPTIONS,
      onEvent: '<fn>',
    })
  })

  it('dispatches message and app_mention events through the router', async () => {
    const onEvent = vi.fn<OnEventFn>(async () => {})
    const plugin = createLlmAgentPlugin()
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
    const plugin = createLlmAgentPlugin()
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
})
