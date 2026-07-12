import { describe, expect, it } from 'vitest'

import {
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createScriptedEventLogStore,
  createScriptedImageResizer,
  createStubSlackClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import { resolveDeps } from '@/plugins/llm-agent/dispatcher-deps'
import { resolveImageBlocks } from '@/plugins/llm-agent/steps/resolve-image-blocks'
import type { SlackWebClient } from '@/slack/web-client'
import type { SlackFile } from '@/types/slack-payloads'

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
  bytesByUrl: ReadonlyMap<string, Uint8Array>,
): SlackWebClient =>
  ({
    ...createStubSlackClient(),
    async downloadFile(url: string) {
      const bytes = bytesByUrl.get(url)
      if (bytes === undefined) throw new Error(`unexpected url: ${url}`)
      return { bytes, contentType: 'image/png' }
    },
  }) as SlackWebClient

describe('resolveImageBlocks', () => {
  it('returns an empty array when the envelope has no images', async () => {
    expect(await resolveImageBlocks(baseDeps(), TEST_ENV)).toEqual([])
  })

  it('downloads attached images and returns them as base64 content blocks', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const slackClient = createSlackClientWithDownloads(
      new Map([
        ['https://files.slack.com/img-1.png', pngBytes],
        ['https://files.slack.com/img-2.jpg', jpgBytes],
      ]),
    )
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'screen.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/img-1.png',
      },
      {
        id: 'F2',
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        url_private: 'https://files.slack.com/img-2.jpg',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(blocks).toEqual([
      {
        base64: Buffer.from(pngBytes).toString('base64'),
        mimeType: 'image/png',
      },
      {
        base64: Buffer.from(jpgBytes).toString('base64'),
        mimeType: 'image/jpeg',
      },
    ])
  })

  it('drops images whose download fails and continues with the rest', async () => {
    const okBytes = new Uint8Array([1, 2, 3])
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        if (url === 'https://files.slack.com/bad.png') throw new Error('403')
        return { bytes: okBytes, contentType: 'image/png' }
      },
    } as SlackWebClient
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'bad.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/bad.png',
      },
      {
        id: 'F2',
        name: 'good.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/good.png',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(blocks).toEqual([
      {
        base64: Buffer.from(okBytes).toString('base64'),
        mimeType: 'image/png',
      },
    ])
  })

  it('skips downloading images whose declared Slack size exceeds the download guard', async () => {
    const downloadCalls: string[] = []
    const smallBytes = new Uint8Array([1, 2, 3])
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        downloadCalls.push(url)
        return { bytes: smallBytes, contentType: 'image/png' }
      },
    } as SlackWebClient
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'massive.png',
        mimetype: 'image/png',
        size: 30 * 1024 * 1024,
        url_private: 'https://files.slack.com/massive.png',
      },
      {
        id: 'F2',
        name: 'ok.png',
        mimetype: 'image/png',
        size: 1024,
        url_private: 'https://files.slack.com/ok.png',
      },
    ]

    await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(downloadCalls).toEqual(['https://files.slack.com/ok.png'])
  })

  it('resizes a downloaded image that exceeds the per-image cap and uses the resized bytes', async () => {
    const bigBytes = new Uint8Array(600 * 1024).fill(7)
    const resizedBytes = new Uint8Array([9, 9, 9, 9])
    const slackClient = createSlackClientWithDownloads(
      new Map([['https://files.slack.com/img-1.png', bigBytes]]),
    )
    const imageResizer = createScriptedImageResizer(() => ({
      ok: true,
      bytes: resizedBytes,
      ext: 'jpg',
    }))
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/img-1.png',
      },
    ]

    const blocks = await resolveImageBlocks(
      baseDeps({ slackClient, imageResizer }),
      { ...TEST_ENV, images },
    )

    expect(imageResizer.calls).toEqual([{ maxBytes: 500 * 1024 }])
    expect(blocks).toEqual([
      {
        base64: Buffer.from(resizedBytes).toString('base64'),
        mimeType: 'image/jpeg',
      },
    ])
  })

  it('drops an image when it cannot be resized under the cap', async () => {
    const bigBytes = new Uint8Array(600 * 1024).fill(7)
    const slackClient = createSlackClientWithDownloads(
      new Map([['https://files.slack.com/img-1.png', bigBytes]]),
    )
    const imageResizer = createScriptedImageResizer(() => ({
      ok: false,
      reason: 'still_too_large',
    }))
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'photo.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/img-1.png',
      },
    ]

    const blocks = await resolveImageBlocks(
      baseDeps({ slackClient, imageResizer }),
      { ...TEST_ENV, images },
    )

    expect(blocks).toEqual([])
  })

  it('stops attaching further images once the total byte budget is reached', async () => {
    // First image exactly fills the per-image cap (500 KiB, no resize
    // needed); the second exactly fills what's left of the 700 KiB total
    // budget. The third must never even be downloaded.
    const firstBytes = new Uint8Array(500 * 1024).fill(1)
    const secondBytes = new Uint8Array(200 * 1024).fill(2)
    const downloadCalls: string[] = []
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        downloadCalls.push(url)
        if (url === 'https://files.slack.com/first.png') {
          return { bytes: firstBytes, contentType: 'image/png' }
        }
        if (url === 'https://files.slack.com/second.png') {
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
        url_private: 'https://files.slack.com/first.png',
      },
      {
        id: 'F2',
        name: 'second.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/second.png',
      },
      {
        id: 'F3',
        name: 'third.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/third.png',
      },
    ]

    const blocks = await resolveImageBlocks(baseDeps({ slackClient }), {
      ...TEST_ENV,
      images,
    })

    expect(downloadCalls).toEqual([
      'https://files.slack.com/first.png',
      'https://files.slack.com/second.png',
    ])
    expect(blocks).toEqual([
      {
        base64: Buffer.from(firstBytes).toString('base64'),
        mimeType: 'image/png',
      },
      {
        base64: Buffer.from(secondBytes).toString('base64'),
        mimeType: 'image/png',
      },
    ])
  })
})
