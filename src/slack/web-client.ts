import {
  type AssistantThreadsSetStatusArguments,
  type AssistantThreadsSetStatusResponse,
  type ChatDeleteArguments,
  type ChatDeleteResponse,
  type ChatPostMessageArguments,
  type ChatPostMessageResponse,
  type ChatUpdateArguments,
  type ChatUpdateResponse,
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

import { SlackApiError } from '@/types/errors'
import type { SlackFile } from '@/types/slack-payloads'

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
    postMessage: (arg) => callMethod(() => client.chat.postMessage(arg)),
    updateMessage: (arg) => callMethod(() => client.chat.update(arg)),
    deleteMessage: (arg) => callMethod(() => client.chat.delete(arg)),
    openView: (arg) => callMethod(() => client.views.open(arg)),
    updateView: (arg) => callMethod(() => client.views.update(arg)),
    pushView: (arg) => callMethod(() => client.views.push(arg)),
    postToResponseUrl: (url, payload) =>
      postToResponseUrl(fetchImpl, url, payload),
    setAssistantThreadStatus: (arg) =>
      callMethod(() => client.assistant.threads.setStatus(arg)),
    downloadFile: (url) => downloadSlackFile(fetchImpl, options.botToken, url),
    getFileInfo: (fileId) => getSlackFileInfo(client, fileId),
  }
}

const toSlackFile = (
  // The SDK types this as `File | undefined`, but the raw Slack API can
  // return `file: null` in some error conditions, so `null` is handled too.
  file: FilesInfoResponse['file'] | null,
): SlackFile | undefined => {
  if (file == null) return undefined
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    size: file.size,
    url_private: file.url_private,
    url_private_download: file.url_private_download,
    permalink: file.permalink,
    channels: file.channels,
    groups: file.groups,
    ims: file.ims,
  }
}

const getSlackFileInfo = async (
  client: WebClient,
  fileId: string,
): Promise<SlackFile | undefined> => {
  const result = await callMethod(() => client.files.info({ file: fileId }))
  return toSlackFile(result.file)
}

const SLACK_FILE_HOST_SUFFIX = '.slack.com'
// Bound the in-memory buffer for a single download to keep a malicious or
// runaway Content-Length from OOM-ing the process. Generous enough not to
// reject ordinary Slack attachments.
const SLACK_FILE_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024

const downloadSlackFile = async (
  fetchImpl: typeof fetch,
  botToken: string,
  url: string,
): Promise<SlackFileDownload> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SlackApiError(`invalid slack file URL: ${url}`, {})
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.hostname !== 'slack.com' &&
      !parsed.hostname.endsWith(SLACK_FILE_HOST_SUFFIX))
  ) {
    throw new SlackApiError(
      `refusing to download non-Slack URL: ${parsed.hostname}`,
      {},
    )
  }
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${botToken}` },
    })
  } catch (err) {
    throw new SlackApiError(
      `slack file download network error: ${err instanceof Error ? err.message : String(err)}`,
      {},
    )
  }
  if (!response.ok) {
    throw new SlackApiError(
      `slack file download failed with HTTP ${String(response.status)}`,
      { status: response.status },
    )
  }
  const contentLengthHeader = response.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (
      Number.isFinite(contentLength) &&
      contentLength > SLACK_FILE_DOWNLOAD_MAX_BYTES
    ) {
      throw new SlackApiError(
        `slack file too large: ${String(contentLength)} bytes (cap ${String(SLACK_FILE_DOWNLOAD_MAX_BYTES)})`,
        { status: response.status },
      )
    }
  }
  let buf: ArrayBuffer
  try {
    buf = await response.arrayBuffer()
  } catch (err) {
    throw new SlackApiError(
      `slack file body read error: ${err instanceof Error ? err.message : String(err)}`,
      { status: response.status },
    )
  }
  return {
    bytes: new Uint8Array(buf),
    contentType: response.headers.get('content-type') ?? undefined,
  }
}

const callMethod = async <T extends WebAPICallResult>(
  call: () => Promise<T>,
): Promise<T> => {
  try {
    return await call()
  } catch (err) {
    if (err instanceof Error) {
      throw new SlackApiError(err.message, {
        slackError: extractSlackError(err),
        cause: err,
      })
    }
    throw err
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
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new SlackApiError(
      `response_url POST failed with HTTP ${String(response.status)}`,
      { status: response.status },
    )
  }
  const text = await response.text()
  if (text.length === 0 || text === 'ok') {
    return { channelId: undefined, messageTs: undefined, raw: text }
  }
  let json: unknown
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
    throw new SlackApiError(`response_url returned error: ${slackError}`, {
      slackError,
      status: response.status,
    })
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
