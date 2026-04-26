import { createHmac } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { noopLogger } from '@/logger/logger'
import type { Plugin } from '@/plugin/plugin'
import { createPluginRegistry } from '@/plugin/registry'
import { createInteractionRouter } from '@/router/router'
import { createSignatureVerifier } from '@/security/signature-verifier'
import { createHttpServer } from '@/server/http-server'
import type { SlackWebClient } from '@/slack/web-client'

const SIGNING_SECRET = 'test-secret'
const FIXED_NOW = 1_700_000_000

interface SlackClientMock {
  postMessage: ReturnType<typeof vi.fn>
  updateMessage: ReturnType<typeof vi.fn>
  deleteMessage: ReturnType<typeof vi.fn>
  openView: ReturnType<typeof vi.fn>
  updateView: ReturnType<typeof vi.fn>
  pushView: ReturnType<typeof vi.fn>
  postToResponseUrl: ReturnType<typeof vi.fn>
}

const buildSlackClientMock = (): SlackClientMock => ({
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  openView: vi.fn(),
  updateView: vi.fn(),
  pushView: vi.fn(),
  postToResponseUrl: vi.fn().mockResolvedValue({
    channelId: 'C1',
    messageTs: '1.0',
    raw: { ok: true },
  }),
})

const asSlackClient = (m: SlackClientMock): SlackWebClient =>
  m as unknown as SlackWebClient

const sign = (timestamp: string, body: string): string => {
  const digest = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')
  return `v0=${digest}`
}

interface FetchableApp {
  fetch: (req: Request) => Response | Promise<Response>
}

const post = async (
  app: FetchableApp,
  path: string,
  body: string,
  contentType: string,
  options: {
    timestamp?: string
    signatureBody?: string
  } = {},
): Promise<Response> => {
  const timestamp = options.timestamp ?? String(FIXED_NOW)
  const signature = sign(timestamp, options.signatureBody ?? body)
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': contentType,
          'x-slack-signature': signature,
          'x-slack-request-timestamp': timestamp,
        },
        body,
      }),
    ),
  )
}

const buildServer = (plugins: readonly Plugin[]) => {
  const registry = createPluginRegistry()
  for (const plugin of plugins) registry.register(plugin)
  const slackClient = buildSlackClientMock()
  const verifier = createSignatureVerifier({
    signingSecret: SIGNING_SECRET,
    now: () => FIXED_NOW,
  })
  const router = createInteractionRouter({
    registry,
    slackClient: asSlackClient(slackClient),
    logger: noopLogger,
    now: () => FIXED_NOW,
  })
  const server = createHttpServer({ verifier, router, logger: noopLogger })
  server.health.setReady()
  return { server, slackClient }
}

describe('end-to-end (HttpServer + Router + Registry)', () => {
  it('dispatches /ping slash command and returns ack body', async () => {
    const handler = vi.fn<NonNullable<Plugin['onCommand']>>(async (ctx) => {
      ctx.ack({ text: 'pong' })
    })
    const ping: Plugin = {
      name: 'ping',
      commands: [{ command: '/ping', description: 'Ping' }],
      onCommand: handler,
    }
    const { server } = buildServer([ping])
    const body = new URLSearchParams({
      command: '/ping',
      text: '',
      response_url: 'https://hooks.slack.com/actions/x',
      user_id: 'U1',
    }).toString()
    const res = await post(
      server.app,
      '/api/slack/commands',
      body,
      'application/x-www-form-urlencoded',
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json).toEqual({ text: 'pong', response_type: 'ephemeral' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('rejects requests with invalid signature', async () => {
    const { server } = buildServer([])
    const body = 'command=/ping'
    const timestamp = String(FIXED_NOW)
    const res = await Promise.resolve(
      server.app.fetch(
        new Request('http://localhost/api/slack/commands', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-slack-signature': 'v0=deadbeef',
            'x-slack-request-timestamp': timestamp,
          },
          body,
        }),
      ),
    )
    expect(res.status).toBe(401)
  })

  it('rejects requests with stale timestamp', async () => {
    const { server } = buildServer([])
    const stale = String(FIXED_NOW - 5 * 60 - 10)
    const body = 'command=/ping'
    const res = await post(
      server.app,
      '/api/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      { timestamp: stale },
    )
    expect(res.status).toBe(401)
  })

  it('returns ephemeral error for unknown slash command', async () => {
    const { server } = buildServer([])
    const body = new URLSearchParams({ command: '/unknown' }).toString()
    const res = await post(
      server.app,
      '/api/slack/commands',
      body,
      'application/x-www-form-urlencoded',
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { response_type: string; text: string }
    expect(json.response_type).toBe('ephemeral')
    expect(json.text).toMatch(/not registered/i)
  })

  it('returns ephemeral error when plugin handler throws', async () => {
    const ping: Plugin = {
      name: 'ping',
      commands: [{ command: '/ping', description: 'Ping' }],
      onCommand: async () => {
        throw new Error('handler boom')
      },
    }
    const { server } = buildServer([ping])
    const body = new URLSearchParams({
      command: '/ping',
      response_url: 'https://hooks.slack.com/actions/x',
    }).toString()
    const res = await post(
      server.app,
      '/api/slack/commands',
      body,
      'application/x-www-form-urlencoded',
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { response_type: string; text: string }
    expect(json.response_type).toBe('ephemeral')
    expect(json.text).toMatch(/error occurred/i)
  })

  it('routes block_actions by action_id prefix', async () => {
    const handler = vi.fn<NonNullable<Plugin['onBlockAction']>>(async (ctx) => {
      ctx.ack()
    })
    const plugin: Plugin = {
      name: 'crawl',
      commands: [],
      onBlockAction: handler,
    }
    const { server } = buildServer([plugin])
    const payload = {
      type: 'block_actions',
      actions: [{ action_id: 'crawl:start:42' }],
      response_url: 'https://hooks.slack.com/actions/x',
    }
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString()
    const res = await post(
      server.app,
      '/api/slack/interactivity',
      body,
      'application/x-www-form-urlencoded',
    )
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    const call = handler.mock.calls[0]
    expect(call).toBeDefined()
    const ctxArg = call?.[0]
    const payloadArg = call?.[1]
    expect(ctxArg?.source.kind).toBe('block_actions')
    expect(payloadArg?.actions[0]?.action_id).toBe('crawl:start:42')
  })

  it('routes view_submission by callback_id prefix', async () => {
    const handler = vi.fn<NonNullable<Plugin['onViewSubmission']>>(
      async (ctx) => {
        ctx.ack()
      },
    )
    const plugin: Plugin = {
      name: 'blog',
      commands: [],
      onViewSubmission: handler,
    }
    const { server } = buildServer([plugin])
    const payload = {
      type: 'view_submission',
      view: { callback_id: 'blog:modal' },
    }
    const body = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString()
    const res = await post(
      server.app,
      '/api/slack/interactivity',
      body,
      'application/x-www-form-urlencoded',
    )
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('responds to events url_verification with the challenge', async () => {
    const { server } = buildServer([])
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'abcdef',
    })
    const res = await post(
      server.app,
      '/api/slack/events',
      body,
      'application/json',
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { challenge: string }
    expect(json.challenge).toBe('abcdef')
  })

  it('returns 200 for non-url_verification events without dispatching', async () => {
    const { server } = buildServer([])
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention' },
    })
    const res = await post(
      server.app,
      '/api/slack/events',
      body,
      'application/json',
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('returns 200 for events with non-string type field', async () => {
    const { server } = buildServer([])
    const body = JSON.stringify({ type: 42, event: { type: 'app_mention' } })
    const res = await post(
      server.app,
      '/api/slack/events',
      body,
      'application/json',
    )
    expect(res.status).toBe(200)
  })

  it('serves health probes', async () => {
    const { server } = buildServer([])
    const live = await Promise.resolve(
      server.app.fetch(new Request('http://localhost/health/live')),
    )
    expect(live.status).toBe(200)
    const ready = await Promise.resolve(
      server.app.fetch(new Request('http://localhost/health/ready')),
    )
    expect(ready.status).toBe(200)
  })

  it('readiness returns 503 before setReady', async () => {
    const registry = createPluginRegistry()
    const slackClient = buildSlackClientMock()
    const verifier = createSignatureVerifier({
      signingSecret: SIGNING_SECRET,
      now: () => FIXED_NOW,
    })
    const router = createInteractionRouter({
      registry,
      slackClient: asSlackClient(slackClient),
      logger: noopLogger,
      now: () => FIXED_NOW,
    })
    const server = createHttpServer({ verifier, router, logger: noopLogger })
    const ready = await Promise.resolve(
      server.app.fetch(new Request('http://localhost/health/ready')),
    )
    expect(ready.status).toBe(503)
  })

  it('supports ack -> followUp flow with sleep in between', async () => {
    let resolveSleep: (() => void) | undefined
    const sleep = new Promise<void>((r) => {
      resolveSleep = r
    })
    const handler = vi.fn<NonNullable<Plugin['onCommand']>>(async (ctx) => {
      ctx.ack({ text: 'starting' })
      await sleep
      await ctx.followUp({ text: 'finished', replace_original: true })
    })
    const plugin: Plugin = {
      name: 'long',
      commands: [{ command: '/long', description: 'Long task' }],
      onCommand: handler,
    }
    const { server, slackClient } = buildServer([plugin])
    const body = new URLSearchParams({
      command: '/long',
      response_url: 'https://hooks.slack.com/actions/x',
    }).toString()
    const responsePromise = post(
      server.app,
      '/api/slack/commands',
      body,
      'application/x-www-form-urlencoded',
    )
    // Allow handler to start and reach its ack point
    await Promise.resolve()
    resolveSleep?.()
    const res = await responsePromise
    expect(res.status).toBe(200)
    const json = (await res.json()) as { text: string }
    expect(json.text).toBe('starting')
    expect(slackClient.postToResponseUrl).toHaveBeenCalledWith(
      'https://hooks.slack.com/actions/x',
      expect.objectContaining({ text: 'finished' }),
    )
  })
})
