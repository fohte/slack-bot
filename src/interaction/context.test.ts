import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'

const buildMockClient = () => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  openView: vi.fn(),
  updateView: vi.fn(),
  pushView: vi.fn(),
  postToResponseUrl: vi
    .fn()
    .mockResolvedValue({ channelId: undefined, messageTs: undefined, raw: '' }),
  setAssistantThreadStatus: vi.fn(),
  downloadFile: vi.fn(),
})

describe('InteractionContext', () => {
  it('captures the first ack payload and ignores subsequent calls', () => {
    const client = buildMockClient()
    const { ctx, ack } = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/ping',
        body: { command: '/ping' },
      },
      slackClient: client,
      responseUrl: 'https://hooks.slack.com/actions/x',
    })
    ctx.ack({ text: 'pong' })
    ctx.ack({ text: 'ignored' })
    expect(ack.called).toBe(true)
    expect(ack.payload).toEqual({ text: 'pong', response_type: 'ephemeral' })
  })

  it('records empty ack when called without payload', () => {
    const client = buildMockClient()
    const { ctx, ack } = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/ping',
        body: { command: '/ping' },
      },
      slackClient: client,
      responseUrl: undefined,
    })
    ctx.ack()
    expect(ack.called).toBe(true)
    expect(ack.payload).toBeUndefined()
  })

  it('respects explicit response_type without forcing ephemeral', () => {
    const client = buildMockClient()
    const { ctx, ack } = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/ping',
        body: { command: '/ping' },
      },
      slackClient: client,
      responseUrl: undefined,
    })
    ctx.ack({ text: 'announce', response_type: 'in_channel' })
    expect(ack.payload).toEqual({
      text: 'announce',
      response_type: 'in_channel',
    })
  })

  it('followUp posts via response_url with default ephemeral', async () => {
    const client = buildMockClient()
    const { ctx } = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/ping',
        body: { command: '/ping' },
      },
      slackClient: client,
      responseUrl: 'https://hooks.slack.com/actions/x',
    })
    await ctx.followUp({ text: 'later' })
    expect(client.postToResponseUrl).toHaveBeenCalledWith(
      'https://hooks.slack.com/actions/x',
      expect.objectContaining({ text: 'later', response_type: 'ephemeral' }),
    )
  })

  it('followUp throws when response_url missing', async () => {
    const client = buildMockClient()
    const { ctx } = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/ping',
        body: { command: '/ping' },
      },
      slackClient: client,
      responseUrl: undefined,
    })
    await expect(ctx.followUp({ text: 'x' })).rejects.toThrow(/response_url/)
  })

  it('originalUpdater returns the same instance on repeated calls', () => {
    const client = buildMockClient()
    const { ctx } = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/ping',
        body: { command: '/ping' },
      },
      slackClient: client,
      responseUrl: 'https://hooks.slack.com/actions/x',
    })
    expect(ctx.originalUpdater()).toBe(ctx.originalUpdater())
  })
})
