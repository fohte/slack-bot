export interface SlashCommandBody {
  readonly token?: string
  readonly team_id?: string
  readonly team_domain?: string
  readonly enterprise_id?: string
  readonly enterprise_name?: string
  readonly channel_id?: string
  readonly channel_name?: string
  readonly user_id?: string
  readonly user_name?: string
  readonly command: string
  readonly text?: string
  readonly response_url?: string
  readonly trigger_id?: string
  readonly api_app_id?: string
  readonly is_enterprise_install?: string
  readonly [key: string]: string | undefined
}

export interface BlockActionPayloadAction {
  readonly action_id: string
  readonly block_id?: string
  readonly value?: string
  readonly type?: string
  readonly [key: string]: unknown
}

export interface BlockActionsPayload {
  readonly type: 'block_actions'
  readonly actions: readonly BlockActionPayloadAction[]
  readonly response_url?: string
  readonly trigger_id?: string
  readonly user?: { readonly id?: string }
  readonly channel?: { readonly id?: string }
  readonly message?: { readonly ts?: string }
  readonly container?: {
    readonly channel_id?: string
    readonly message_ts?: string
  }
  readonly [key: string]: unknown
}

export interface ViewPayloadView {
  readonly id?: string
  readonly callback_id: string
  readonly type?: string
  readonly state?: { readonly values?: Record<string, unknown> }
  readonly [key: string]: unknown
}

export interface ViewSubmissionPayload {
  readonly type: 'view_submission'
  readonly view: ViewPayloadView
  readonly user?: { readonly id?: string }
  readonly response_urls?: ReadonlyArray<{ readonly response_url?: string }>
  readonly [key: string]: unknown
}

export interface ViewClosedPayload {
  readonly type: 'view_closed'
  readonly view: ViewPayloadView
  readonly user?: { readonly id?: string }
  readonly [key: string]: unknown
}

export interface ShortcutPayload {
  readonly type: 'shortcut'
  readonly callback_id: string
  readonly trigger_id?: string
  readonly user?: { readonly id?: string }
  readonly [key: string]: unknown
}

export interface MessageActionPayload {
  readonly type: 'message_action'
  readonly callback_id: string
  readonly trigger_id?: string
  readonly response_url?: string
  readonly channel?: { readonly id?: string }
  readonly message?: { readonly ts?: string }
  readonly user?: { readonly id?: string }
  readonly [key: string]: unknown
}

export type SlackInteractivityPayload =
  | BlockActionsPayload
  | ViewSubmissionPayload
  | ViewClosedPayload
  | ShortcutPayload
  | MessageActionPayload

export interface SlackEventBase {
  readonly type: string
  readonly [key: string]: unknown
}

export interface SlackUnknownEvent extends SlackEventBase {
  readonly type: string
}

export interface SlackMessageEvent extends SlackEventBase {
  readonly type: 'message'
  readonly channel?: string
  readonly user?: string
  readonly text?: string
  readonly ts?: string
  readonly thread_ts?: string
  readonly channel_type?: string
  readonly subtype?: string
  readonly bot_id?: string
}

export interface SlackAppMentionEvent extends SlackEventBase {
  readonly type: 'app_mention'
  readonly channel?: string
  readonly user?: string
  readonly text?: string
  readonly ts?: string
  readonly thread_ts?: string
}

export type SlackEvent =
  | SlackMessageEvent
  | SlackAppMentionEvent
  | SlackUnknownEvent

export interface SlackEventCallback {
  readonly type: 'event_callback'
  readonly team_id?: string
  readonly api_app_id?: string
  readonly event: SlackEvent
  readonly event_id?: string
  readonly event_time?: number
  readonly authorizations?: ReadonlyArray<Record<string, unknown>>
  readonly [key: string]: unknown
}
