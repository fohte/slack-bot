import { captureWithFingerprint } from '@fohte/service-kit/observability'
import {
  type AssistantThreadsSetStatusArguments,
  type AssistantThreadsSetStatusResponse,
  type ChatDeleteArguments,
  type ChatDeleteResponse,
  type ChatPostMessageArguments,
  type ChatPostMessageResponse,
  type ChatUpdateArguments,
  type ChatUpdateResponse,
  type ConversationsRepliesResponse,
  type FilesInfoResponse,
  type ViewsOpenArguments,
  type ViewsOpenResponse,
  type ViewsPushArguments,
  type ViewsPushResponse,
  type ViewsUpdateArguments,
  type ViewsUpdateResponse,
  type WebAPICallResult,
  WebClient,
} from '@slack/web-api'

import { SlackApiError } from '#types/errors'
import type { SlackFile } from '#types/slack-payloads'

// Neither type is re-exported from @slack/web-api's public entry point, only
// nested inside ConversationsRepliesResponse, so they're derived here via
// indexed access instead of a deep import into the package's dist layout.
type MessageElement = NonNullable<
  ConversationsRepliesResponse['messages']
>[number]
type FileElement = NonNullable<MessageElement['files']>[number]

export interface ResponseUrlPayload {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  response_type?: 'ephemeral' | 'in_channel'
  replace_original?: boolean
  delete_original?: boolean
  thread_ts?: string
  [key: string]: unknown
}

export interface ResponseUrlResult {
  readonly channelId: string | undefined
  readonly messageTs: string | undefined
  readonly raw: unknown
}

export interface SlackFileDownload {
  readonly bytes: Uint8Array
  readonly contentType: string | undefined
}

export interface SlackThreadReplyMessage {
  readonly ts: string | undefined
  readonly userId: string | undefined
  readonly botId: string | undefined
  readonly text: string | undefined
  readonly files: readonly SlackFile[]
}

export interface GetConversationRepliesArgs {
  readonly channel: string
  readonly ts: string
  // `latest` is exclusive (Slack's `inclusive` param defaults to false), but
  // `oldest` behaves as inclusive in practice; see the cursor exclusion in
  // sync-thread-context.ts's shouldInject for the workaround this requires.
  readonly oldest?: string | undefined
  readonly latest?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

export interface ConversationRepliesPage {
  readonly messages: readonly SlackThreadReplyMessage[]
  readonly hasMore: boolean
  readonly nextCursor: string | undefined
}

export interface SlackWebClient {
  postMessage(arg: ChatPostMessageArguments): Promise<ChatPostMessageResponse>
  updateMessage(arg: ChatUpdateArguments): Promise<ChatUpdateResponse>
  deleteMessage(arg: ChatDeleteArguments): Promise<ChatDeleteResponse>
  openView(arg: ViewsOpenArguments): Promise<ViewsOpenResponse>
  updateView(arg: ViewsUpdateArguments): Promise<ViewsUpdateResponse>
  pushView(arg: ViewsPushArguments): Promise<ViewsPushResponse>
  postToResponseUrl(
    url: string,
    payload: ResponseUrlPayload,
  ): Promise<ResponseUrlResult>
  setAssistantThreadStatus(
    arg: AssistantThreadsSetStatusArguments,
  ): Promise<AssistantThreadsSetStatusResponse>
  // Host is pinned to *.slack.com so a tampered url_private cannot exfiltrate
  // the bot token. maxRetries is not honored; caller owns retry on 429/5xx.
  downloadFile(url: string): Promise<SlackFileDownload>
  // Throws SlackApiError (e.g. file_not_found) like every other method here;
  // callers resolving loosely-parsed ID references decide whether to swallow it.
  getFileInfo(fileId: string): Promise<SlackFile | undefined>
  // Requires channels:history (or groups:history/im:history/mpim:history for
  // private channels/DMs/MPDMs).
  getConversationReplies(
    args: GetConversationRepliesArgs,
  ): Promise<ConversationRepliesPage>
}

export interface SlackWebClientOptions {
  readonly botToken: string
  readonly maxRetries: number
  readonly client?: WebClient | undefined
  readonly fetchImpl?: typeof fetch | undefined
}

export const createSlackWebClient = (
  options: SlackWebClientOptions,
): SlackWebClient => {
  const client =
    options.client ??
    new WebClient(options.botToken, {
      retryConfig: { retries: options.maxRetries },
    })
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    postMessage: (arg) =>
      callMethod('chat.postMessage', () => client.chat.postMessage(arg)),
    updateMessage: (arg) =>
      callMethod('chat.update', () => client.chat.update(arg)),
    deleteMessage: (arg) =>
      callMethod('chat.delete', () => client.chat.delete(arg)),
    openView: (arg) => callMethod('views.open', () => client.views.open(arg)),
    updateView: (arg) =>
      callMethod('views.update', () => client.views.update(arg)),
    pushView: (arg) => callMethod('views.push', () => client.views.push(arg)),
    postToResponseUrl: (url, payload) =>
      postToResponseUrl(fetchImpl, url, payload),
    setAssistantThreadStatus: (arg) =>
      callMethod('assistant.threads.setStatus', () =>
        client.assistant.threads.setStatus(arg),
      ),
    downloadFile: (url) => downloadSlackFile(fetchImpl, options.botToken, url),
    getFileInfo: (fileId) => getSlackFileInfo(client, fileId),
    getConversationReplies: (args) => getConversationReplies(client, args),
  }
}

// Structural shape shared by FilesInfoResponse['file'] and FileElement (two
// independently SDK-generated types for the same underlying Slack file
// object), so both toSlackFile and toThreadReplyFile can map through one
// field list instead of keeping two copies in sync.
interface SlackFileFields {
  readonly id?: string
  readonly name?: string
  readonly title?: string
  readonly mimetype?: string
  readonly filetype?: string
  readonly size?: number
  readonly url_private?: string
  readonly url_private_download?: string
  readonly permalink?: string
  readonly thumb_64?: string
  readonly thumb_80?: string
  readonly thumb_160?: string
  readonly thumb_360?: string
  readonly thumb_480?: string
  readonly thumb_720?: string
  readonly thumb_800?: string
  readonly thumb_960?: string
  readonly thumb_1024?: string
  readonly channels?: readonly string[]
  readonly groups?: readonly string[]
  readonly ims?: readonly string[]
}

const toSlackFileFields = (file: SlackFileFields): SlackFile => ({
  id: file.id,
  name: file.name,
  title: file.title,
  mimetype: file.mimetype,
  filetype: file.filetype,
  size: file.size,
  url_private: file.url_private,
  url_private_download: file.url_private_download,
  permalink: file.permalink,
  thumb_64: file.thumb_64,
  thumb_80: file.thumb_80,
  thumb_160: file.thumb_160,
  thumb_360: file.thumb_360,
  thumb_480: file.thumb_480,
  thumb_720: file.thumb_720,
  thumb_800: file.thumb_800,
  thumb_960: file.thumb_960,
  thumb_1024: file.thumb_1024,
  channels: file.channels,
  groups: file.groups,
  ims: file.ims,
})

const toSlackFile = (
  // The SDK types this as `File | undefined`, but the raw Slack API can
  // return `file: null` in some error conditions, so `null` is handled too.
  file: FilesInfoResponse['file'] | null,
): SlackFile | undefined => (file == null ? undefined : toSlackFileFields(file))

const getSlackFileInfo = async (
  client: WebClient,
  fileId: string,
): Promise<SlackFile | undefined> => {
  const result = await callMethod('files.info', () =>
    client.files.info({ file: fileId }),
  )
  return toSlackFile(result.file)
}

const toThreadReplyFile = (file: FileElement): SlackFile =>
  toSlackFileFields(file)

const toThreadReplyMessage = (
  message: MessageElement,
): SlackThreadReplyMessage => ({
  ts: message.ts,
  userId: message.user,
  botId: message.bot_id,
  text: message.text,
  files: (message.files ?? []).map(toThreadReplyFile),
})

const getConversationReplies = async (
  client: WebClient,
  args: GetConversationRepliesArgs,
): Promise<ConversationRepliesPage> => {
  const result = await callMethod('conversations.replies', () =>
    client.conversations.replies({
      channel: args.channel,
      ts: args.ts,
      ...(args.oldest !== undefined ? { oldest: args.oldest } : {}),
      ...(args.latest !== undefined ? { latest: args.latest } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }),
  )
  return {
    messages: (result.messages ?? []).map(toThreadReplyMessage),
    hasMore: result.has_more ?? false,
    nextCursor: result.response_metadata?.next_cursor,
  }
}

// Groups every Slack Web API / response_url failure under one Sentry issue
// per boundary rather than per call site.
const SLACK_WEB_CLIENT_FINGERPRINT = 'slack.web-client.request-failed'

const reportAndThrow = (
  err: unknown,
  extras: Record<string, unknown>,
): never => {
  captureWithFingerprint(err, SLACK_WEB_CLIENT_FINGERPRINT, { extras })
  // eslint-disable-next-line no-restricted-syntax -- boundary: SlackWebClient methods implement a throw-based Promise<T> contract, not Result; this re-throws after Sentry capture
  throw err
}

const SLACK_FILE_HOST_SUFFIX = '.slack.com'
// Bound the in-memory buffer for a single download to keep a malicious or
// runaway Content-Length from OOM-ing the process. Modern smartphone photos
// commonly run 10-20 MB, so this must clear that range even though callers
// only ever download pre-sized Slack thumb_* variants, never the original.
export const SLACK_FILE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024

const downloadSlackFile = async (
  fetchImpl: typeof fetch,
  botToken: string,
  url: string,
): Promise<SlackFileDownload> => {
  const extras = { method: 'downloadFile', url }
  let parsed: URL
  // eslint-disable-next-line no-restricted-syntax -- boundary: wraps the URL constructor's throw-based validation contract
  try {
    parsed = new URL(url)
  } catch {
    return reportAndThrow(
      new SlackApiError(`invalid slack file URL: ${url}`, {}),
      extras,
    )
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.hostname !== 'slack.com' &&
      !parsed.hostname.endsWith(SLACK_FILE_HOST_SUFFIX))
  ) {
    return reportAndThrow(
      new SlackApiError(
        `refusing to download non-Slack URL: ${parsed.hostname}`,
        {},
      ),
      extras,
    )
  }
  let response: Response
  // eslint-disable-next-line no-restricted-syntax -- boundary: throw-based HTTP interop, catches fetch's network-error throw to wrap and re-throw via reportAndThrow
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${botToken}` },
    })
  } catch (err) {
    return reportAndThrow(
      new SlackApiError(
        `slack file download network error: ${err instanceof Error ? err.message : String(err)}`,
        {},
      ),
      extras,
    )
  }
  if (!response.ok) {
    return reportAndThrow(
      new SlackApiError(
        `slack file download failed with HTTP ${String(response.status)}`,
        { status: response.status },
      ),
      extras,
    )
  }
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (
      Number.isFinite(contentLength) &&
      contentLength > SLACK_FILE_DOWNLOAD_MAX_BYTES
    ) {
      return reportAndThrow(
        new SlackApiError(
          `slack file too large: ${String(contentLength)} bytes (cap ${String(SLACK_FILE_DOWNLOAD_MAX_BYTES)})`,
          { status: response.status },
        ),
        extras,
      )
    }
  }
  let buf: ArrayBuffer
  // eslint-disable-next-line no-restricted-syntax -- boundary: Response.arrayBuffer()'s throw-based contract, catches to wrap and re-throw via reportAndThrow
  try {
    buf = await response.arrayBuffer()
  } catch (err) {
    return reportAndThrow(
      new SlackApiError(
        `slack file body read error: ${err instanceof Error ? err.message : String(err)}`,
        { status: response.status },
      ),
      extras,
    )
  }
  return {
    bytes: new Uint8Array(buf),
    contentType: response.headers.get('content-type') ?? undefined,
  }
}

const callMethod = async <T extends WebAPICallResult>(
  method: string,
  call: () => Promise<T>,
): Promise<T> => {
  // eslint-disable-next-line no-restricted-syntax -- boundary: throw-based interop with @slack/web-api's WebClient, catches its throw to wrap and re-throw via reportAndThrow
  try {
    return await call()
  } catch (err) {
    if (err instanceof Error) {
      return reportAndThrow(
        new SlackApiError(err.message, {
          slackError: extractSlackError(err),
          cause: err,
        }),
        { method },
      )
    }
    return reportAndThrow(err, { method })
  }
}

const extractSlackError = (err: Error): string | undefined => {
  if (!isRecord(err)) return undefined
  const data = err['data']
  if (!isRecord(data)) return undefined
  const errField = data['error']
  return typeof errField === 'string' ? errField : undefined
}

const postToResponseUrl = async (
  fetchImpl: typeof fetch,
  url: string,
  payload: ResponseUrlPayload,
): Promise<ResponseUrlResult> => {
  // response_url embeds a time/use-bounded capability token in its path, so
  // it must not be forwarded to Sentry.
  const extras = { method: 'postToResponseUrl' }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    return reportAndThrow(
      new SlackApiError(
        `response_url POST failed with HTTP ${String(response.status)}`,
        { status: response.status },
      ),
      extras,
    )
  }
  const text = await response.text()
  if (text.length === 0 || text === 'ok') {
    return { channelId: undefined, messageTs: undefined, raw: text }
  }
  let json: unknown
  // eslint-disable-next-line no-restricted-syntax -- boundary: JSON.parse's throw-based contract; a non-JSON response_url body falls back to the raw text
  try {
    json = JSON.parse(text)
  } catch {
    return { channelId: undefined, messageTs: undefined, raw: text }
  }
  if (!isRecord(json)) {
    return { channelId: undefined, messageTs: undefined, raw: json }
  }
  if (json['ok'] === false) {
    const slackError =
      typeof json['error'] === 'string'
        ? json['error']
        : 'response_url returned ok:false'
    return reportAndThrow(
      new SlackApiError(`response_url returned error: ${slackError}`, {
        slackError,
        status: response.status,
      }),
      extras,
    )
  }
  const channelRaw = json['channel'] ?? json['channel_id']
  const tsRaw = json['ts'] ?? json['message_ts']
  return {
    channelId: typeof channelRaw === 'string' ? channelRaw : undefined,
    messageTs: typeof tsRaw === 'string' ? tsRaw : undefined,
    raw: json,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
