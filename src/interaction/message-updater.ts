import type { ResponseUrlPayload, SlackWebClient } from '@/slack/web-client'
import { ResponseUrlExhaustedError } from '@/types/errors'

const RESPONSE_URL_TTL_MS = 30 * 60 * 1000
const RESPONSE_URL_MAX_USES = 5

export interface SlackMessageRef {
  readonly channelId: string
  readonly messageTs: string
}

export interface SlackMessagePatch {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  thread_ts?: string
}

export interface MessageUpdater {
  patch(payload: SlackMessagePatch): Promise<void>
  delete(): Promise<void>
}

interface ResponseUrlState {
  readonly url: string
  readonly createdAt: number
  uses: number
}

interface OriginalUpdaterOptions {
  readonly responseUrl?: string | undefined
  readonly initialRef?: SlackMessageRef | undefined
  readonly client: SlackWebClient
  readonly now?: () => number
}

export const createOriginalUpdater = (
  options: OriginalUpdaterOptions,
): MessageUpdater => {
  const now = options.now ?? (() => Date.now())
  const urlState: ResponseUrlState | undefined =
    options.responseUrl !== undefined
      ? { url: options.responseUrl, createdAt: now(), uses: 0 }
      : undefined
  let cachedRef: SlackMessageRef | undefined = options.initialRef

  const isUrlAvailable = (): boolean => {
    if (urlState === undefined) return false
    if (urlState.uses >= RESPONSE_URL_MAX_USES) return false
    if (now() - urlState.createdAt > RESPONSE_URL_TTL_MS) return false
    return true
  }

  return {
    async patch(payload) {
      if (urlState !== undefined && isUrlAvailable()) {
        const result = await options.client.postToResponseUrl(urlState.url, {
          replace_original: true,
          ...payload,
        } satisfies ResponseUrlPayload)
        urlState.uses += 1
        if (
          cachedRef === undefined &&
          result.channelId !== undefined &&
          result.messageTs !== undefined
        ) {
          cachedRef = {
            channelId: result.channelId,
            messageTs: result.messageTs,
          }
        }
        return
      }
      if (cachedRef === undefined) {
        throw new ResponseUrlExhaustedError(
          'response_url is exhausted and no message ref is available for chat.update fallback',
        )
      }
      await options.client.updateMessage({
        channel: cachedRef.channelId,
        ts: cachedRef.messageTs,
        text: payload.text ?? '',
        ...(payload.blocks !== undefined ? { blocks: payload.blocks } : {}),
        ...(payload.attachments !== undefined
          ? { attachments: payload.attachments }
          : {}),
      })
    },
    async delete() {
      if (urlState !== undefined && isUrlAvailable()) {
        await options.client.postToResponseUrl(urlState.url, {
          delete_original: true,
        })
        urlState.uses += 1
        return
      }
      if (cachedRef === undefined) {
        throw new ResponseUrlExhaustedError(
          'response_url is exhausted and no message ref is available for chat.delete fallback',
        )
      }
      await options.client.deleteMessage({
        channel: cachedRef.channelId,
        ts: cachedRef.messageTs,
      })
    },
  }
}

interface RefUpdaterOptions {
  readonly ref: SlackMessageRef
  readonly client: SlackWebClient
}

export const createRefUpdater = (
  options: RefUpdaterOptions,
): MessageUpdater => ({
  async patch(payload) {
    await options.client.updateMessage({
      channel: options.ref.channelId,
      ts: options.ref.messageTs,
      text: payload.text ?? '',
      ...(payload.blocks !== undefined ? { blocks: payload.blocks } : {}),
      ...(payload.attachments !== undefined
        ? { attachments: payload.attachments }
        : {}),
    })
  },
  async delete() {
    await options.client.deleteMessage({
      channel: options.ref.channelId,
      ts: options.ref.messageTs,
    })
  },
})
