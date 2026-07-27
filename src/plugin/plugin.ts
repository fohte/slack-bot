import type { ResultAsync } from 'neverthrow'

import type { InteractionContext } from '#interaction/context'
import type { EventContext } from '#interaction/event-context'
import type {
  BlockActionsPayload,
  MessageActionPayload,
  ShortcutPayload,
  SlackEvent,
  SlashCommandBody,
  ViewClosedPayload,
  ViewSubmissionPayload,
} from '#types/slack-payloads'

export interface SlackAppManifestCommand {
  readonly command: string
  readonly description: string
  readonly usage_hint?: string
  readonly should_escape?: boolean
}

export interface Plugin {
  readonly name: string
  readonly commands: readonly SlackAppManifestCommand[]
  onCommand?(
    ctx: InteractionContext,
    body: SlashCommandBody,
  ): ResultAsync<void, unknown>
  onBlockAction?(
    ctx: InteractionContext,
    payload: BlockActionsPayload,
  ): ResultAsync<void, unknown>
  onViewSubmission?(
    ctx: InteractionContext,
    payload: ViewSubmissionPayload,
  ): ResultAsync<void, unknown>
  onViewClosed?(
    ctx: InteractionContext,
    payload: ViewClosedPayload,
  ): ResultAsync<void, unknown>
  onShortcut?(
    ctx: InteractionContext,
    payload: ShortcutPayload,
  ): ResultAsync<void, unknown>
  onMessageAction?(
    ctx: InteractionContext,
    payload: MessageActionPayload,
  ): ResultAsync<void, unknown>
  readonly eventSubscriptions?: readonly string[]
  onEvent?(ctx: EventContext, event: SlackEvent): ResultAsync<void, unknown>
}
