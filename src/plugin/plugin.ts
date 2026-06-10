import type { InteractionContext } from '@/interaction/context'
import type { EventContext } from '@/interaction/event-context'
import type {
  BlockActionsPayload,
  MessageActionPayload,
  ShortcutPayload,
  SlackEvent,
  SlashCommandBody,
  ViewClosedPayload,
  ViewSubmissionPayload,
} from '@/types/slack-payloads'

export interface SlackAppManifestCommand {
  readonly command: string
  readonly description: string
  readonly usage_hint?: string
  readonly should_escape?: boolean
}

export interface Plugin {
  readonly name: string
  readonly commands: readonly SlackAppManifestCommand[]
  onCommand?(ctx: InteractionContext, body: SlashCommandBody): Promise<void>
  onBlockAction?(
    ctx: InteractionContext,
    payload: BlockActionsPayload,
  ): Promise<void>
  onViewSubmission?(
    ctx: InteractionContext,
    payload: ViewSubmissionPayload,
  ): Promise<void>
  onViewClosed?(
    ctx: InteractionContext,
    payload: ViewClosedPayload,
  ): Promise<void>
  onShortcut?(ctx: InteractionContext, payload: ShortcutPayload): Promise<void>
  onMessageAction?(
    ctx: InteractionContext,
    payload: MessageActionPayload,
  ): Promise<void>
  readonly eventSubscriptions?: readonly string[]
  onEvent?(ctx: EventContext, event: SlackEvent): Promise<void>
}
