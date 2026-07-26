import { errAsync, ResultAsync } from 'neverthrow'

import type { ResponseUrlPayload, SlackWebClient } from '@/slack/web-client'
import { ResponseUrlExhaustedError, SlackApiError } from '@/types/errors'

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
  patch(
    payload: SlackMessagePatch,
  ): ResultAsync<void, ResponseUrlExhaustedError | SlackApiError>
  delete(): ResultAsync<void, ResponseUrlExhaustedError | SlackApiError>
}

const toSlackApiError = (caughtErr: unknown): SlackApiError =>
  caughtErr instanceof SlackApiError
    ? caughtErr
    : new SlackApiError('Slack API call failed', { cause: caughtErr })

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
    patch(payload) {
      if (urlState !== undefined && isUrlAvailable()) {
        return ResultAsync.fromPromise(
          options.client.postToResponseUrl(urlState.url, {
            replace_original: true,
            ...payload,
          } satisfies ResponseUrlPayload),
          toSlackApiError,
        ).map((result) => {
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
          return undefined
        })
      }
      if (cachedRef === undefined) {
        return errAsync(
          new ResponseUrlExhaustedError(
            'response_url is exhausted and no message ref is available for chat.update fallback',
          ),
        )
      }
      return ResultAsync.fromPromise(
        options.client.updateMessage({
          channel: cachedRef.channelId,
          ts: cachedRef.messageTs,
          text: payload.text ?? '',
          ...(payload.blocks !== undefined ? { blocks: payload.blocks } : {}),
          ...(payload.attachments !== undefined
            ? { attachments: payload.attachments }
            : {}),
        }),
        toSlackApiError,
      ).map(() => undefined)
    },
    delete() {
      if (urlState !== undefined && isUrlAvailable()) {
        return ResultAsync.fromPromise(
          options.client.postToResponseUrl(urlState.url, {
            delete_original: true,
          }),
          toSlackApiError,
        ).map(() => {
          urlState.uses += 1
          return undefined
        })
      }
      if (cachedRef === undefined) {
        return errAsync(
          new ResponseUrlExhaustedError(
            'response_url is exhausted and no message ref is available for chat.delete fallback',
          ),
        )
      }
      return ResultAsync.fromPromise(
        options.client.deleteMessage({
          channel: cachedRef.channelId,
          ts: cachedRef.messageTs,
        }),
        toSlackApiError,
      ).map(() => undefined)
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
  patch(payload) {
    return ResultAsync.fromPromise(
      options.client.updateMessage({
        channel: options.ref.channelId,
        ts: options.ref.messageTs,
        text: payload.text ?? '',
        ...(payload.blocks !== undefined ? { blocks: payload.blocks } : {}),
        ...(payload.attachments !== undefined
          ? { attachments: payload.attachments }
          : {}),
      }),
      toSlackApiError,
    ).map(() => undefined)
  },
  delete() {
    return ResultAsync.fromPromise(
      options.client.deleteMessage({
        channel: options.ref.channelId,
        ts: options.ref.messageTs,
      }),
      toSlackApiError,
    ).map(() => undefined)
  },
})
