import { ok } from 'neverthrow'
import { describe, expect, it } from 'vitest'

import {
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createScriptedEventLogStore,
  createStubSlackClient,
  TEST_ENV,
} from '#plugins/llm-agent/_test-utils'
import { resolveDeps } from '#plugins/llm-agent/dispatcher-deps'
import { resolveImageBlocks } from '#plugins/llm-agent/steps/resolve-image-blocks'
import type { SlackFileDownload, SlackWebClient } from '#slack/web-client'
import { SlackImageThumbnailUnavailableError } from '#types/errors'
import type { SlackFile } from '#types/slack-payloads'

const baseDeps = (overrides: Partial<Parameters<typeof resolveDeps>[0]> = {}) =>
  resolveDeps({
    conversationAgent: createFakeConversationAgent(() => {
      throw new Error('not implemented')
    }),
    remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
    a2aTaskTracker: createFakeA2aTaskTracker(),
    eventLogStore: createScriptedEventLogStore(),
    slackClient: createStubSlackClient(),
    ...overrides,
  })

const createSlackClientWithDownloads = (
  responsesByUrl: ReadonlyMap<string, SlackFileDownload>,
): SlackWebClient =>
  ({
    ...createStubSlackClient(),
    async downloadFile(url: string) {
      const response = responsesByUrl.get(url)
      if (response === undefined) throw new Error(`unexpected url: ${url}`)
      return response
    },
  }) as SlackWebClient

describe('resolveImageBlocks', () => {
  it('returns an empty array when the envelope has no images', async () => {
    expect(await resolveImageBlocks(baseDeps(), TEST_ENV)).toEqual(ok([]))
  })

  it('downloads the largest available thumbnail and returns it as a base64 content block', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const slackClient = createSlackClientWithDownloads(
      new Map([
        [
          'https://files.slack.com/thumb-1024.jpg',
          { bytes, contentType: 'image/jpeg' },
        ],
      ]),
    )
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        thumb_1024: 'https://files.slack.com/thumb-1024.jpg',
        thumb_360: 'https://files.slack.com/thumb-360.jpg',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(blocks).toEqual(
      ok([
        {
          base64: Buffer.from(bytes).toString('base64'),
          mimeType: 'image/jpeg',
        },
      ]),
    )
  })

  it('falls back to a smaller thumbnail when the largest one exceeds the per-image cap', async () => {
    const tooBig = new Uint8Array(600 * 1024).fill(7)
    const fits = new Uint8Array([1, 2, 3, 4])
    const downloadCalls: string[] = []
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        downloadCalls.push(url)
        if (url === 'https://files.slack.com/thumb-1024.jpg') {
          return { bytes: tooBig, contentType: 'image/jpeg' }
        }
        if (url === 'https://files.slack.com/thumb-480.jpg') {
          return { bytes: fits, contentType: 'image/jpeg' }
        }
        throw new Error(`unexpected url: ${url}`)
      },
    } as SlackWebClient
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        thumb_1024: 'https://files.slack.com/thumb-1024.jpg',
        thumb_480: 'https://files.slack.com/thumb-480.jpg',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(downloadCalls).toEqual([
      'https://files.slack.com/thumb-1024.jpg',
      'https://files.slack.com/thumb-480.jpg',
    ])
    expect(blocks).toEqual(
      ok([
        {
          base64: Buffer.from(fits).toString('base64'),
          mimeType: 'image/jpeg',
        },
      ]),
    )
  })

  it('falls back to a smaller thumbnail when the largest one fails to download', async () => {
    const fits = new Uint8Array([9, 9, 9])
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        if (url === 'https://files.slack.com/thumb-1024.jpg') {
          throw new Error('403')
        }
        if (url === 'https://files.slack.com/thumb-360.jpg') {
          return { bytes: fits, contentType: 'image/png' }
        }
        throw new Error(`unexpected url: ${url}`)
      },
    } as SlackWebClient
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.png',
        mimetype: 'image/png',
        thumb_1024: 'https://files.slack.com/thumb-1024.jpg',
        thumb_360: 'https://files.slack.com/thumb-360.jpg',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(blocks).toEqual(
      ok([
        { base64: Buffer.from(fits).toString('base64'), mimeType: 'image/png' },
      ]),
    )
  })

  it('returns an error with SlackImageThumbnailUnavailableError when the file has no thumb_* URL', async () => {
    const images: readonly SlackFile[] = [
      { id: 'F1', name: 'photo.jpg', mimetype: 'image/jpeg' },
    ]

    const result = await resolveImageBlocks(baseDeps(), { ...TEST_ENV, images })

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SlackImageThumbnailUnavailableError,
    )
  })

  it('returns an error with SlackImageThumbnailUnavailableError when every available thumbnail exceeds the cap', async () => {
    const tooBig = new Uint8Array(600 * 1024).fill(1)
    const slackClient = createSlackClientWithDownloads(
      new Map([
        [
          'https://files.slack.com/thumb-360.jpg',
          { bytes: tooBig, contentType: 'image/jpeg' },
        ],
      ]),
    )
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        thumb_360: 'https://files.slack.com/thumb-360.jpg',
      },
    ]

    const result = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SlackImageThumbnailUnavailableError,
    )
  })

  it('returns an error for the whole call when one image among several has no usable thumbnail, discarding blocks already resolved for the others', async () => {
    const firstBytes = new Uint8Array([1, 2, 3])
    const slackClient = createSlackClientWithDownloads(
      new Map([
        [
          'https://files.slack.com/first-thumb.jpg',
          { bytes: firstBytes, contentType: 'image/jpeg' },
        ],
      ]),
    )
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'first.jpg',
        mimetype: 'image/jpeg',
        thumb_360: 'https://files.slack.com/first-thumb.jpg',
      },
      { id: 'F2', name: 'second.jpg', mimetype: 'image/jpeg' },
    ]

    const result = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SlackImageThumbnailUnavailableError,
    )
  })

  it("derives the content block's mimeType from the downloaded response, not the original file's declared mimetype", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const slackClient = createSlackClientWithDownloads(
      new Map([
        [
          'https://files.slack.com/thumb-360.jpg',
          { bytes, contentType: 'image/jpeg' },
        ],
      ]),
    )
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.png',
        mimetype: 'image/png',
        thumb_360: 'https://files.slack.com/thumb-360.jpg',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(blocks).toEqual(
      ok([
        {
          base64: Buffer.from(bytes).toString('base64'),
          mimeType: 'image/jpeg',
        },
      ]),
    )
  })

  it('stops attaching further images once the total byte budget is reached', async () => {
    // First image exactly fills the per-image cap (500 KiB); the second
    // exactly fills what's left of the 700 KiB total budget. The third must
    // never even be downloaded.
    const firstBytes = new Uint8Array(500 * 1024).fill(1)
    const secondBytes = new Uint8Array(200 * 1024).fill(2)
    const downloadCalls: string[] = []
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        downloadCalls.push(url)
        if (url === 'https://files.slack.com/first-thumb.png') {
          return { bytes: firstBytes, contentType: 'image/png' }
        }
        if (url === 'https://files.slack.com/second-thumb.png') {
          return { bytes: secondBytes, contentType: 'image/png' }
        }
        throw new Error(`unexpected url: ${url}`)
      },
    } as SlackWebClient
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'first.png',
        mimetype: 'image/png',
        thumb_360: 'https://files.slack.com/first-thumb.png',
      },
      {
        id: 'F2',
        name: 'second.png',
        mimetype: 'image/png',
        thumb_360: 'https://files.slack.com/second-thumb.png',
      },
      {
        id: 'F3',
        name: 'third.png',
        mimetype: 'image/png',
        thumb_360: 'https://files.slack.com/third-thumb.png',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(downloadCalls).toEqual([
      'https://files.slack.com/first-thumb.png',
      'https://files.slack.com/second-thumb.png',
    ])
    expect(blocks).toEqual(
      ok([
        {
          base64: Buffer.from(firstBytes).toString('base64'),
          mimeType: 'image/png',
        },
        {
          base64: Buffer.from(secondBytes).toString('base64'),
          mimeType: 'image/png',
        },
      ]),
    )
  })
})
