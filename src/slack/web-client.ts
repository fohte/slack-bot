import {
  type ChatDeleteArguments,
  type ChatDeleteResponse,
  type ChatPostMessageArguments,
  type ChatPostMessageResponse,
  type ChatUpdateArguments,
  type ChatUpdateResponse,
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
