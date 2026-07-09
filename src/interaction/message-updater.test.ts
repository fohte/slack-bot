import { describe, expect, it, vi } from 'vitest'

import {
  createOriginalUpdater,
  createRefUpdater,
} from '@/interaction/message-updater'
import { ResponseUrlExhaustedError } from '@/types/errors'

const buildMockClient = () => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn().mockResolvedValue({ ok: true }),
  deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
  openView: vi.fn(),
  updateView: vi.fn(),
  pushView: vi.fn(),
  postToResponseUrl: vi
    .fn()
    .mockResolvedValue({ channelId: 'C1', messageTs: '1.2', raw: {} }),
  setAssistantThreadStatus: vi.fn(),
  downloadFile: vi.fn(),
  getFileInfo: vi.fn(),
})

describe('MessageUpdater (originalUpdater)', () => {
  it('uses response_url while within ttl and use limit', async () => {
    const client = buildMockClient()
    const updater = createOriginalUpdater({
      responseUrl: 'https://hooks.slack.com/actions/x',
      client: client,
      now: () => 1_000_000,
    })
    await updater.patch({ text: 'first' })
    await updater.patch({ text: 'second' })
    expect(client.postToResponseUrl).toHaveBeenCalledTimes(2)
    expect(client.updateMessage).not.toHaveBeenCalled()
    const [, payload] = client.postToResponseUrl.mock.calls[0]!
    expect(payload).toMatchObject({ text: 'first', replace_original: true })
  })

  it('switches to chat.update once 30 minutes pass', async () => {
    const client = buildMockClient()
    let nowVal = 1_000_000
    const updater = createOriginalUpdater({
      responseUrl: 'https://hooks.slack.com/actions/x',
      client: client,
      now: () => nowVal,
    })
    await updater.patch({ text: 'first' })
    nowVal += 31 * 60 * 1000
    await updater.patch({ text: 'after expiry' })
    expect(client.postToResponseUrl).toHaveBeenCalledTimes(1)
    expect(client.updateMessage).toHaveBeenCalledTimes(1)
    const [, args] = [
      undefined,
      client.updateMessage.mock.calls[0]![0] as { channel: string; ts: string },
    ]
    expect(args.channel).toBe('C1')
    expect(args.ts).toBe('1.2')
  })

  it('switches to chat.update after 5 uses', async () => {
    const client = buildMockClient()
    const updater = createOriginalUpdater({
      responseUrl: 'https://hooks.slack.com/actions/x',
      client: client,
      now: () => 1_000_000,
    })
    for (let i = 0; i < 5; i += 1) {
      await updater.patch({ text: `n=${i}` })
    }
    await updater.patch({ text: 'sixth' })
    expect(client.postToResponseUrl).toHaveBeenCalledTimes(5)
    expect(client.updateMessage).toHaveBeenCalledTimes(1)
  })

  it('throws when response_url expired and no ref was cached', async () => {
    const client = buildMockClient()
    const updater = createOriginalUpdater({
      responseUrl: 'https://hooks.slack.com/actions/x',
      client: client,
      now: () => 1_000_000,
    })
    // override response_url POST so it does not produce a ref
    client.postToResponseUrl.mockResolvedValue({
      channelId: undefined,
      messageTs: undefined,
      raw: 'ok',
    })
    let nowVal = 1_000_000
    const updater2 = createOriginalUpdater({
      responseUrl: 'https://hooks.slack.com/actions/x',
      client: client,
      now: () => nowVal,
    })
    nowVal += 31 * 60 * 1000
    await expect(updater2.patch({ text: 'late' })).rejects.toBeInstanceOf(
      ResponseUrlExhaustedError,
    )
    void updater
  })

  it('delete uses response_url when available', async () => {
    const client = buildMockClient()
    const updater = createOriginalUpdater({
      responseUrl: 'https://hooks.slack.com/actions/x',
      client: client,
      now: () => 1_000_000,
    })
    await updater.delete()
    const [, payload] = client.postToResponseUrl.mock.calls[0]!
    expect(payload).toEqual({ delete_original: true })
  })
})

describe('MessageUpdater (refUpdater)', () => {
  it('always uses chat.update', async () => {
    const client = buildMockClient()
    const updater = createRefUpdater({
      ref: { channelId: 'C2', messageTs: '9.9' },
      client: client,
    })
    await updater.patch({ text: 'edit' })
    expect(client.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C2', ts: '9.9', text: 'edit' }),
    )
    await updater.delete()
    expect(client.deleteMessage).toHaveBeenCalledWith({
      channel: 'C2',
      ts: '9.9',
    })
  })
})
