import { vi } from 'vitest'

import type {
  ResponseUrlPayload,
  ResponseUrlResult,
  SlackWebClient,
} from '#slack/web-client'

export interface TestSlack {
  readonly client: SlackWebClient
  readonly postToResponseUrl: ReturnType<
    typeof vi.fn<
      (url: string, payload: ResponseUrlPayload) => Promise<ResponseUrlResult>
    >
  >
}

const makeSlackWithImpl = (
  impl: () => Promise<ResponseUrlResult>,
): TestSlack => {
  const postToResponseUrl =
    vi.fn<
      (url: string, payload: ResponseUrlPayload) => Promise<ResponseUrlResult>
    >(impl)
  const partial: unknown = {
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    openView: vi.fn(),
    updateView: vi.fn(),
    pushView: vi.fn(),
    postToResponseUrl,
  }

  return { client: partial as SlackWebClient, postToResponseUrl }
}

export const makeSlack = (
  response: ResponseUrlResult = {
    channelId: undefined,
    messageTs: undefined,
    raw: 'ok',
  },
): TestSlack => makeSlackWithImpl(() => Promise.resolve(response))

// Simulates postToResponseUrl failing, for tests that verify a followUp()/
// patch() Result error still reaches the caller.
export const makeFailingSlack = (error: Error): TestSlack =>
  makeSlackWithImpl(() => Promise.reject(error))

export const lastBody = (
  postToResponseUrl: TestSlack['postToResponseUrl'],
): ResponseUrlPayload => {
  const calls = postToResponseUrl.mock.calls
  if (calls.length === 0) throw new Error('postToResponseUrl was not called')
  const call = calls[calls.length - 1]
  if (call === undefined) throw new Error('unreachable')
  return call[1]
}

export const nthBody = (
  postToResponseUrl: TestSlack['postToResponseUrl'],
  n: number,
): ResponseUrlPayload => {
  const call = postToResponseUrl.mock.calls[n]
  if (call === undefined) throw new Error(`no call at index ${String(n)}`)
  return call[1]
}
