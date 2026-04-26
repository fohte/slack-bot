import type { InteractionContext } from '@/interaction/context'
import type {
  BlockActionsPayload,
  MessageActionPayload,
  ShortcutPayload,
  SlackEventPayload,
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
  onEvent?(ctx: InteractionContext, payload: SlackEventPayload): Promise<void>
}
