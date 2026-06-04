import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { lastBody, makeSlack } from '@/plugins/blog/_test-utils'
import { handleCancelCommand } from '@/plugins/blog/handlers/cancel-command'
import type { BlogServiceClient } from '@/plugins/blog/service-client'

describe('CancelCommand /blog-cancel', () => {
  it('calls cancelPr with parsed number', async () => {
    const cancelPr = vi.fn(async () => {})
    const client = { cancelPr } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-cancel',
        body: { command: '/blog-cancel', text: '42' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleCancelCommand({
      ctx: result.ctx,
      body: { command: '/blog-cancel', text: '42' },
      client,
    })
    expect(cancelPr).toHaveBeenCalledWith(42)
    expect(lastBody(slack.postToResponseUrl).text).toContain('42')
  })

  it('accepts #42 form', async () => {
    const cancelPr = vi.fn(async () => {})
    const client = { cancelPr } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-cancel',
        body: { command: '/blog-cancel', text: '#7' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleCancelCommand({
      ctx: result.ctx,
      body: { command: '/blog-cancel', text: '#7' },
      client,
    })
    expect(cancelPr).toHaveBeenCalledWith(7)
  })

  it('shows usage when arg is missing or non-numeric', async () => {
    const cancelPr = vi.fn()
    const client = { cancelPr } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-cancel',
        body: { command: '/blog-cancel' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleCancelCommand({
      ctx: result.ctx,
      body: { command: '/blog-cancel' },
      client,
    })
    expect(cancelPr).not.toHaveBeenCalled()
    expect(lastBody(slack.postToResponseUrl).text).toContain('使用法')
  })
})
