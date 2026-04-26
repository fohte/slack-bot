import {
  type AckPayload,
  createInteractionContext,
  type InteractionContext,
  type InteractionSource,
} from '@/interaction/context'
import type { SlackMessageRef } from '@/interaction/message-updater'
import type { Logger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import type { PluginRegistry } from '@/plugin/registry'
import type { SlackWebClient } from '@/slack/web-client'
import type {
  BlockActionsPayload,
  MessageActionPayload,
  ShortcutPayload,
  SlackEventPayload,
  SlackInteractivityPayload,
  SlashCommandBody,
  ViewClosedPayload,
  ViewSubmissionPayload,
} from '@/types/slack-payloads'

export type RouterResult =
  | { status: 200; body?: AckPayload | undefined }
  | { status: 400; body?: AckPayload | undefined }
  | { status: 404 }

export interface InteractionRouter {
  routeCommand(body: SlashCommandBody): Promise<RouterResult>
  routeInteractivity(payload: SlackInteractivityPayload): Promise<RouterResult>
  routeEvent(payload: SlackEventPayload): Promise<RouterResult>
}

export interface RouterOptions {
  readonly registry: PluginRegistry
  readonly slackClient: SlackWebClient
  readonly logger: Logger
  readonly now?: (() => number) | undefined
}

const ephemeralError = (message: string): AckPayload => ({
  response_type: 'ephemeral',
  text: message,
})

interface DispatchArgs {
  readonly endpoint: 'commands' | 'interactivity' | 'events'
  readonly plugin: Plugin | undefined
  readonly pluginAction: string
  readonly responseUrl: string | undefined
  readonly source: InteractionSource
  readonly initialRef?: SlackMessageRef | undefined
  readonly invoke: (
    plugin: Plugin,
    ctx: InteractionContext,
  ) => Promise<void> | undefined
}

export const createInteractionRouter = (
  options: RouterOptions,
): InteractionRouter => {
  const now = options.now ?? (() => Date.now())

  const dispatch = async (args: DispatchArgs): Promise<RouterResult> => {
    const startedAt = now()
    if (args.plugin === undefined) {
      options.logger.error(
        {
          event: 'plugin_not_found',
          endpoint: args.endpoint,
          target: args.pluginAction,
        },
        'no plugin registered for interaction',
      )
      return {
        status: 200,
        body: ephemeralError(
          'Sorry, that command is not registered. Please contact the bot operator.',
        ),
      }
    }
    const { ctx, ack } = createInteractionContext({
      source: args.source,
      slackClient: options.slackClient,
      responseUrl: args.responseUrl,
      initialRef: args.initialRef,
    })
    const handlerCall = args.invoke(args.plugin, ctx)
    if (handlerCall === undefined) {
      options.logger.error(
        {
          event: 'plugin_handler_missing',
          endpoint: args.endpoint,
          plugin: args.plugin.name,
          target: args.pluginAction,
        },
        'plugin does not implement the required handler',
      )
      return {
        status: 200,
        body: ephemeralError('Sorry, that interaction is not handled.'),
      }
    }
    try {
      await handlerCall
    } catch (err) {
      options.logger.error(
        {
          event: 'plugin_handler_error',
          endpoint: args.endpoint,
          plugin: args.plugin.name,
          target: args.pluginAction,
          duration_ms: now() - startedAt,
          error: serializeError(err),
        },
        'plugin handler threw',
      )
      return {
        status: 200,
        body: ephemeralError(
          'Sorry, an error occurred while handling the request.',
        ),
      }
    }
    options.logger.info(
      {
        event: 'interaction_handled',
        endpoint: args.endpoint,
        plugin: args.plugin.name,
        target: args.pluginAction,
        duration_ms: now() - startedAt,
        status: 'success',
      },
      'interaction handled',
    )
    return { status: 200, body: ack.payload }
  }

  return {
    async routeCommand(body) {
      const plugin = options.registry.lookupCommand(body.command)
      return dispatch({
        endpoint: 'commands',
        plugin,
        pluginAction: body.command,
        responseUrl: body.response_url,
        source: { kind: 'slash_command', command: body.command, body },
        invoke: (p, ctx) => p.onCommand?.(ctx, body),
      })
    },
    async routeInteractivity(payload) {
      switch (payload.type) {
        case 'block_actions':
          return routeBlockActions(payload)
        case 'view_submission':
          return routeViewSubmission(payload)
        case 'view_closed':
          return routeViewClosed(payload)
        case 'shortcut':
          return routeShortcut(payload)
        case 'message_action':
          return routeMessageAction(payload)
        default:
          return { status: 400 }
      }
    },
    async routeEvent(payload) {
      const eventType =
        typeof payload.event?.type === 'string'
          ? payload.event.type
          : payload.type
      const plugin = options.registry.lookupByActionOrCallbackId(eventType)
      if (plugin === undefined) {
        return { status: 200 }
      }
      return dispatch({
        endpoint: 'events',
        plugin,
        pluginAction: eventType,
        responseUrl: undefined,
        source: { kind: 'event', payload },
        invoke: (p, ctx) => p.onEvent?.(ctx, payload),
      })
    },
  }

  function routeBlockActions(
    payload: BlockActionsPayload,
  ): Promise<RouterResult> {
    const first = payload.actions[0]
    if (first === undefined) {
      return Promise.resolve({ status: 400 })
    }
    const plugin = options.registry.lookupByActionOrCallbackId(first.action_id)
    return dispatch({
      endpoint: 'interactivity',
      plugin,
      pluginAction: first.action_id,
      responseUrl: payload.response_url,
      source: { kind: 'block_actions', payload },
      initialRef: pickRefFromBlockActions(payload),
      invoke: (p, ctx) => p.onBlockAction?.(ctx, payload),
    })
  }

  function routeViewSubmission(
    payload: ViewSubmissionPayload,
  ): Promise<RouterResult> {
    const plugin = options.registry.lookupByActionOrCallbackId(
      payload.view.callback_id,
    )
    return dispatch({
      endpoint: 'interactivity',
      plugin,
      pluginAction: payload.view.callback_id,
      responseUrl: payload.response_urls?.[0]?.response_url,
      source: { kind: 'view_submission', payload },
      invoke: (p, ctx) => p.onViewSubmission?.(ctx, payload),
    })
  }

  function routeViewClosed(payload: ViewClosedPayload): Promise<RouterResult> {
    const plugin = options.registry.lookupByActionOrCallbackId(
      payload.view.callback_id,
    )
    return dispatch({
      endpoint: 'interactivity',
      plugin,
      pluginAction: payload.view.callback_id,
      responseUrl: undefined,
      source: { kind: 'view_closed', payload },
      invoke: (p, ctx) => p.onViewClosed?.(ctx, payload),
    })
  }

  function routeShortcut(payload: ShortcutPayload): Promise<RouterResult> {
    const plugin = options.registry.lookupByActionOrCallbackId(
      payload.callback_id,
    )
    return dispatch({
      endpoint: 'interactivity',
      plugin,
      pluginAction: payload.callback_id,
      responseUrl: undefined,
      source: { kind: 'shortcut', payload },
      invoke: (p, ctx) => p.onShortcut?.(ctx, payload),
    })
  }

  function routeMessageAction(
    payload: MessageActionPayload,
  ): Promise<RouterResult> {
    const plugin = options.registry.lookupByActionOrCallbackId(
      payload.callback_id,
    )
    const channel = payload.channel?.id
    const messageTs = payload.message?.ts
    const initialRef =
      typeof channel === 'string' && typeof messageTs === 'string'
        ? { channelId: channel, messageTs }
        : undefined
    return dispatch({
      endpoint: 'interactivity',
      plugin,
      pluginAction: payload.callback_id,
      responseUrl: payload.response_url,
      source: { kind: 'message_action', payload },
      initialRef,
      invoke: (p, ctx) => p.onMessageAction?.(ctx, payload),
    })
  }
}

const pickRefFromBlockActions = (
  payload: BlockActionsPayload,
): SlackMessageRef | undefined => {
  const channel = payload.channel?.id ?? payload.container?.channel_id
  const messageTs = payload.message?.ts ?? payload.container?.message_ts
  if (typeof channel === 'string' && typeof messageTs === 'string') {
    return { channelId: channel, messageTs }
  }
  return undefined
}

const serializeError = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { value: String(err) }
}
