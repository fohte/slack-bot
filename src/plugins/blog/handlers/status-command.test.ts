import type { BlogPrSummary } from '@fohte/blog-publisher-contract'
import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { lastBody, makeSlack } from '@/plugins/blog/_test-utils'
import { handleStatusCommand } from '@/plugins/blog/handlers/status-command'
import type { BlogServiceClient } from '@/plugins/blog/service-client'

const pr = (overrides: Partial<BlogPrSummary> = {}): BlogPrSummary => ({
  number: 1,
  url: 'https://github.com/x/y/pull/1',
  branch: 'b',
  state: 'open',
  title: 'T',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('StatusCommand /blog-status', () => {
  it('shows empty-state when zero PRs', async () => {
    const listPrs = vi.fn(async () => [])
    const client = { listPrs } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-status',
        body: { command: '/blog-status' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleStatusCommand({
      ctx: result.ctx,
      body: { command: '/blog-status' },
      client,
    })
    expect(listPrs).toHaveBeenCalledWith('open')
    expect(lastBody(slack.postToResponseUrl).text).toContain('ありません')
  })

  it('lists multiple PRs', async () => {
    const listPrs = vi.fn(async () => [
      pr({ number: 1, title: 'A' }),
      pr({ number: 2, title: 'B', url: 'https://github.com/x/y/pull/2' }),
    ])
    const client = { listPrs } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-status',
        body: { command: '/blog-status' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleStatusCommand({
      ctx: result.ctx,
      body: { command: '/blog-status' },
      client,
    })
    const serialized = JSON.stringify(lastBody(slack.postToResponseUrl))
    expect(serialized).toContain('pull/1')
    expect(serialized).toContain('pull/2')
  })
})
