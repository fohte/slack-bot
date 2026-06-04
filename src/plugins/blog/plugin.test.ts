import type {
  ApplyResult,
  BlogPrSummary,
  CiStatus,
  Note,
  Plan,
} from '@fohte/blog-publisher-contract'
import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { createPluginRegistry } from '@/plugin/registry'
import { createBlogPlugin } from '@/plugins/blog/plugin'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type { SlackWebClient } from '@/slack/web-client'

const stubClient = (
  overrides: Partial<BlogServiceClient> = {},
): BlogServiceClient => ({
  listNotes: async () => [] as Note[],
  buildPlan: async () =>
    ({
      signature: 'sig',
      items: [],
      warnings: [],
      errors: [],
      imagesToUpload: [],
    }) satisfies Plan,
  apply: async () =>
    ({
      kind: 'success',
      prNumber: 1,
      prUrl: 'https://example.com',
      branch: 'b',
    }) satisfies ApplyResult,
  listPrs: async () => [] as BlogPrSummary[],
  cancelPr: async () => {},
  getCiStatus: async () =>
    ({ state: 'pending', failedChecks: [] }) satisfies CiStatus,
  ...overrides,
})

const stubSlackClient = (): SlackWebClient =>
  ({
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    openView: vi.fn(),
    updateView: vi.fn(),
    pushView: vi.fn(),
    postToResponseUrl: vi.fn(async () => ({
      channelId: undefined,
      messageTs: undefined,
      raw: 'ok',
    })),
  }) as unknown as SlackWebClient

describe('createBlogPlugin', () => {
  it('registers with PluginRegistry under name "blog" with three commands', () => {
    const plugin = createBlogPlugin({
      config: {
        serviceUrl: 'https://svc',
        serviceToken: 't',
        allowedSlackUserIds: [],
      },
      client: stubClient(),
    })
    const registry = createPluginRegistry()
    registry.register(plugin)
    expect(plugin.name).toBe('blog')
    expect(registry.lookupCommand('/blog-post')?.name).toBe('blog')
    expect(registry.lookupCommand('/blog-status')?.name).toBe('blog')
    expect(registry.lookupCommand('/blog-cancel')?.name).toBe('blog')
    expect(registry.lookupByActionOrCallbackId('blog:apply')?.name).toBe('blog')
  })

  it('rejects users not in allowedSlackUserIds', async () => {
    const plugin = createBlogPlugin({
      config: {
        serviceUrl: 'https://svc',
        serviceToken: 't',
        allowedSlackUserIds: ['U_ALLOWED'],
      },
      client: stubClient(),
    })
    const slack = stubSlackClient()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-post',
        body: { command: '/blog-post', user_id: 'U_NOT_ALLOWED' },
      },
      slackClient: slack,
      responseUrl: 'https://hooks.example/abc',
    })
    await plugin.onCommand?.(result.ctx, {
      command: '/blog-post',
      user_id: 'U_NOT_ALLOWED',
    })
    const ack = await result.ackPromise
    expect(ack?.['text']).toContain('権限')
  })

  it('allows users when allowedSlackUserIds is empty', async () => {
    const listNotes = vi.fn(async () => [] as Note[])
    const plugin = createBlogPlugin({
      config: {
        serviceUrl: 'https://svc',
        serviceToken: 't',
        allowedSlackUserIds: [],
      },
      client: stubClient({ listNotes }),
    })
    const slack = stubSlackClient()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-post',
        body: { command: '/blog-post', user_id: 'U_ANY' },
      },
      slackClient: slack,
      responseUrl: 'https://hooks.example/abc',
    })
    await plugin.onCommand?.(result.ctx, {
      command: '/blog-post',
      user_id: 'U_ANY',
    })
    expect(listNotes).toHaveBeenCalled()
  })
})
