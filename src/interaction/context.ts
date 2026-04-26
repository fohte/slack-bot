import {
  createOriginalUpdater,
  createRefUpdater,
  type MessageUpdater,
  type SlackMessageRef,
} from '@/interaction/message-updater'
import type { ResponseUrlPayload, SlackWebClient } from '@/slack/web-client'
import type {
  BlockActionsPayload,
  MessageActionPayload,
  ShortcutPayload,
  SlashCommandBody,
  ViewClosedPayload,
  ViewSubmissionPayload,
} from '@/types/slack-payloads'

export type InteractionSource =
  | { kind: 'slash_command'; command: string; body: SlashCommandBody }
  | { kind: 'block_actions'; payload: BlockActionsPayload }
  | { kind: 'view_submission'; payload: ViewSubmissionPayload }
  | { kind: 'view_closed'; payload: ViewClosedPayload }
  | { kind: 'shortcut'; payload: ShortcutPayload }
  | { kind: 'message_action'; payload: MessageActionPayload }

export interface AckPayload {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  response_type?: 'ephemeral' | 'in_channel'
  [key: string]: unknown
}

export interface FollowUpPayload {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  response_type?: 'ephemeral' | 'in_channel'
  thread_ts?: string
  replace_original?: boolean
  [key: string]: unknown
}

export interface InteractionContext {
  readonly source: InteractionSource
  ack(payload?: AckPayload): void
  followUp(payload: FollowUpPayload): Promise<void>
  originalUpdater(): MessageUpdater
  updater(ref: SlackMessageRef): MessageUpdater
}

export interface InteractionContextOptions {
  readonly source: InteractionSource
  readonly slackClient: SlackWebClient
  readonly responseUrl: string | undefined
  readonly defaultEphemeral?: boolean | undefined
  readonly initialRef?: SlackMessageRef | undefined
}

export interface AckCapture {
  called: boolean
  payload: AckPayload | undefined
}

export interface InteractionContextResult {
  readonly ctx: InteractionContext
  readonly ack: AckCapture
}

export const createInteractionContext = (
  options: InteractionContextOptions,
): InteractionContextResult => {
  const ackState: AckCapture = { called: false, payload: undefined }
  let cachedOriginal: MessageUpdater | undefined

  const applyDefaultEphemeral = <T extends { response_type?: string }>(
    payload: T,
  ): T => {
    if (
      options.defaultEphemeral !== false &&
      payload.response_type === undefined
    ) {
      return { ...payload, response_type: 'ephemeral' }
    }
    return payload
  }

  const ctx: InteractionContext = {
    source: options.source,
    ack(payload) {
      if (ackState.called) return
      ackState.called = true
      ackState.payload =
        payload === undefined ? undefined : applyDefaultEphemeral(payload)
    },
    async followUp(payload) {
      if (options.responseUrl === undefined) {
        throw new Error(
          'followUp() requires a response_url, but none is available for this interaction',
        )
      }
      const body: ResponseUrlPayload = applyDefaultEphemeral(payload)
      await options.slackClient.postToResponseUrl(options.responseUrl, body)
    },
    originalUpdater() {
      if (cachedOriginal === undefined) {
        cachedOriginal = createOriginalUpdater({
          responseUrl: options.responseUrl,
          initialRef: options.initialRef,
          client: options.slackClient,
        })
      }
      return cachedOriginal
    },
    updater(ref) {
      return createRefUpdater({ ref, client: options.slackClient })
    },
  }

  return { ctx, ack: ackState }
}
