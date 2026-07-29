import { describe, expect, it } from 'vitest'

import type { LogFields, Logger } from '#logger/logger'
import {
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createScriptedEventLogStore,
  createStubSlackClient,
  TEST_ENV,
} from '#plugins/llm-agent/_test-utils'
import { resolveDeps } from '#plugins/llm-agent/dispatcher-deps'
import {
  EMPTY_THREAD_CONTEXT,
  syncThreadContext,
} from '#plugins/llm-agent/steps/sync-thread-context'
import type {
  ConversationRepliesPage,
  GetConversationRepliesArgs,
  SlackFileDownload,
  SlackThreadReplyMessage,
  SlackWebClient,
} from '#slack/web-client'
import { SlackImageThumbnailUnavailableError } from '#types/errors'

interface LogEntry {
  readonly level: 'info' | 'warn'
  readonly payload: Record<string, unknown>
}

const createRecordingLogger = (): Logger & { readonly entries: LogEntry[] } => {
  const entries: LogEntry[] = []
  const logger: Logger & { readonly entries: LogEntry[] } = {
    entries,
    debug: () => undefined,
    info: (fields: LogFields) => {
      entries.push({ level: 'info', payload: fields })
    },
    warn: (fields: LogFields) => {
      entries.push({ level: 'warn', payload: fields })
    },
    error: () => undefined,
    child: () => logger,
  }
  return logger
}

const BOT_USER_ID = 'U_BOT'

const baseDeps = (overrides: Partial<Parameters<typeof resolveDeps>[0]> = {}) =>
  resolveDeps({
    conversationAgent: createFakeConversationAgent(() => {
      throw new Error('not implemented')
    }),
    remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
    a2aTaskTracker: createFakeA2aTaskTracker(),
    eventLogStore: createScriptedEventLogStore(),
    slackClient: createStubSlackClient(),
    botUserId: BOT_USER_ID,
    ...overrides,
  })

const message = (
  overrides: Partial<SlackThreadReplyMessage>,
): SlackThreadReplyMessage => ({
  ts: undefined,
  userId: undefined,
  botId: undefined,
  text: undefined,
  files: [],
  ...overrides,
})

const scriptedSlackClient = (
  pages: readonly ConversationRepliesPage[],
  downloads: ReadonlyMap<string, SlackFileDownload> = new Map(),
): {
  readonly client: SlackWebClient
  readonly calls: GetConversationRepliesArgs[]
} => {
  const calls: GetConversationRepliesArgs[] = []
  let callIndex = 0
  const client: SlackWebClient = {
    ...createStubSlackClient(),
    async getConversationReplies(args) {
      calls.push(args)
      const page = pages[callIndex]
      callIndex += 1
      if (page === undefined) throw new Error('no more scripted pages')
      return page
    },
    async downloadFile(url: string) {
      const download = downloads.get(url)
      if (download === undefined) throw new Error(`unexpected url: ${url}`)
      return download
    },
  } as SlackWebClient
  return { client, calls }
}

const NEVER_IN_FLIGHT = () => false

const ENV = { ...TEST_ENV, threadRootTs: '100.000', triggerTs: '500.000' }

const iso = (ts: string): string => new Date(Number(ts) * 1000).toISOString()

describe('syncThreadContext', () => {
  it('returns an empty context and warns when the Slack fetch fails', async () => {
    const logger = createRecordingLogger()
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async getConversationReplies() {
        throw new Error('rate limited')
      },
    } as SlackWebClient
    const deps = baseDeps({ slackClient, logger })

    const result = await syncThreadContext(
      deps,
      ENV,
      undefined,
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual(EMPTY_THREAD_CONTEXT)
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        payload: {
          event: 'llm_agent_thread_context_fetch_failed',
          event_id: ENV.eventId,
          err: new Error('rate limited'),
        },
      },
    ])
  })

  it('returns an empty context when there are no messages in range', async () => {
    const { client } = scriptedSlackClient([
      { messages: [], hasMore: false, nextCursor: undefined },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      undefined,
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual(EMPTY_THREAD_CONTEXT)
  })

  it('passes channel/ts/oldest/latest/limit through to getConversationReplies', async () => {
    const { client, calls } = scriptedSlackClient([
      { messages: [], hasMore: false, nextCursor: undefined },
    ])
    const deps = baseDeps({ slackClient: client })

    await syncThreadContext(deps, ENV, '200.000', NEVER_IN_FLIGHT)

    expect(calls).toEqual([
      {
        channel: 'C1',
        ts: '100.000',
        oldest: '200.000',
        latest: '500.000',
        cursor: undefined,
        limit: 200,
      },
    ])
  })

  it('injects a human message formatted as an ISO-timestamped mention line', async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [message({ ts: '300.000', userId: 'U2', text: 'retry' })],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: `<thread_context>\n[${iso('300.000')}] <@U2>: retry\n</thread_context>`,
      images: [],
      contextMaxTs: '300.000',
    })
  })

  it("excludes the bot's own prior message once a checkpoint exists", async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({
            ts: '300.000',
            userId: BOT_USER_ID,
            botId: 'B_SELF',
            text: 'earlier reply',
          }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: undefined,
      images: [],
      contextMaxTs: '300.000',
    })
  })

  it("includes and labels the bot's own prior message on cold start", async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({
            ts: '300.000',
            userId: BOT_USER_ID,
            botId: 'B_SELF',
            text: 'earlier reply',
          }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      undefined,
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: `<thread_context>\n[${iso('300.000')}] <@${BOT_USER_ID}> (you): earlier reply\n</thread_context>`,
      images: [],
      contextMaxTs: '300.000',
    })
  })

  it("always injects another bot's message, even with a checkpoint present", async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({
            ts: '300.000',
            botId: 'B_OTHER',
            text: 'crawler finished',
          }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: `<thread_context>\n[${iso('300.000')}] <bot:B_OTHER>: crawler finished\n</thread_context>`,
      images: [],
      contextMaxTs: '300.000',
    })
  })

  it('excludes a human message whose turn is currently in flight', async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [message({ ts: '300.000', userId: 'U2', text: 'retry' })],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })
    const isTurnInFlight = (key: { channelId: string; ts: string }) =>
      key.channelId === 'C1' && key.ts === '300.000'

    const result = await syncThreadContext(deps, ENV, '200.000', isTurnInFlight)

    expect(result).toEqual({
      text: undefined,
      images: [],
      contextMaxTs: '300.000',
    })
  })

  it("excludes a message whose ts exactly matches the cursor (Slack's `oldest` is inclusive)", async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({ ts: '200.000', userId: 'U2', text: 'already seen' }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: undefined,
      images: [],
      contextMaxTs: '200.000',
    })
  })

  it("excludes another bot's message whose ts is at or before the cursor", async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({
            ts: '200.000',
            botId: 'B_OTHER',
            text: 'crawler finished',
          }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: undefined,
      images: [],
      contextMaxTs: '200.000',
    })
  })

  it('formats a non-image attachment as a placeholder', async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({
            ts: '300.000',
            userId: 'U2',
            text: 'here is the doc',
            files: [
              { id: 'F1', name: 'notes.pdf', mimetype: 'application/pdf' },
            ],
          }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: `<thread_context>\n[${iso('300.000')}] <@U2>: here is the doc [添付ファイル: notes.pdf]\n</thread_context>`,
      images: [],
      contextMaxTs: '300.000',
    })
  })

  it('attaches only the newest 4 images with numbered markers, marking older ones as omitted', async () => {
    const files = [1, 2, 3, 4, 5].map((n) => ({
      id: `F${String(n)}`,
      name: `photo${String(n)}.png`,
      mimetype: 'image/png',
      thumb_360: `https://files.slack.com/${String(n)}.png`,
    }))
    const downloads = new Map(
      files.map((f, i) => [
        f.thumb_360,
        { bytes: new Uint8Array([i]), contentType: 'image/png' },
      ]),
    )
    const { client } = scriptedSlackClient(
      [
        {
          messages: files.map((f, i) =>
            message({
              ts: `${String(300 + i)}.000`,
              userId: 'U2',
              text: `photo ${String(i + 1)}`,
              files: [f],
            }),
          ),
          hasMore: false,
          nextCursor: undefined,
        },
      ],
      downloads,
    )
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: [
        '<thread_context>',
        `[${iso('300.000')}] <@U2>: photo 1 [画像省略: photo1.png]`,
        `[${iso('301.000')}] <@U2>: photo 2 [画像 1]`,
        `[${iso('302.000')}] <@U2>: photo 3 [画像 2]`,
        `[${iso('303.000')}] <@U2>: photo 4 [画像 3]`,
        `[${iso('304.000')}] <@U2>: photo 5 [画像 4]`,
        '</thread_context>',
      ].join('\n'),
      images: [
        { base64: Buffer.from([1]).toString('base64'), mimeType: 'image/png' },
        { base64: Buffer.from([2]).toString('base64'), mimeType: 'image/png' },
        { base64: Buffer.from([3]).toString('base64'), mimeType: 'image/png' },
        { base64: Buffer.from([4]).toString('base64'), mimeType: 'image/png' },
      ],
      contextMaxTs: '304.000',
    })
  })

  it("falls back to a placeholder when a selected image's thumbnail can't be resolved", async () => {
    const { client } = scriptedSlackClient([
      {
        messages: [
          message({
            ts: '300.000',
            userId: 'U2',
            text: 'no thumbnail here',
            files: [{ id: 'F1', name: 'raw.png', mimetype: 'image/png' }],
          }),
        ],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const logger = createRecordingLogger()
    const deps = baseDeps({ slackClient: client, logger })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: `<thread_context>\n[${iso('300.000')}] <@U2>: no thumbnail here [画像省略: raw.png]\n</thread_context>`,
      images: [],
      contextMaxTs: '300.000',
    })
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        payload: {
          event: 'llm_agent_thread_context_image_unavailable',
          event_id: ENV.eventId,
          slack_file_id: 'F1',
          err: new SlackImageThumbnailUnavailableError(
            'slack file F1 has no thumb_* variant that fits the 512000-byte cap (checked 0 candidate size(s))',
          ),
        },
      },
      {
        level: 'info',
        payload: {
          event: 'llm_agent_thread_context_synced',
          event_id: ENV.eventId,
          injected_message_count: 1,
          injected_image_count: 0,
          truncated: false,
        },
      },
    ])
  })

  it('paginates until has_more is false, combining every page', async () => {
    const { client, calls } = scriptedSlackClient([
      {
        messages: [message({ ts: '300.000', userId: 'U2', text: 'first' })],
        hasMore: true,
        nextCursor: 'CURSOR_1',
      },
      {
        messages: [message({ ts: '301.000', userId: 'U2', text: 'second' })],
        hasMore: false,
        nextCursor: undefined,
      },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(calls.map((c) => c.cursor)).toEqual([undefined, 'CURSOR_1'])
    expect(result).toEqual({
      text: `<thread_context>\n[${iso('300.000')}] <@U2>: first\n[${iso('301.000')}] <@U2>: second\n</thread_context>`,
      images: [],
      contextMaxTs: '301.000',
    })
  })

  it('notes truncation and keeps only the newest 100 messages when more are eligible', async () => {
    const messages = Array.from({ length: 101 }, (_, i) =>
      message({
        ts: `${String(300 + i)}.000`,
        userId: 'U2',
        text: `msg ${String(i)}`,
      }),
    )
    const { client } = scriptedSlackClient([
      { messages, hasMore: false, nextCursor: undefined },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    const expectedLines = messages
      .slice(1)
      .map((m) => `[${iso(m.ts as string)}] <@U2>: ${m.text ?? ''}`)
    expect(result).toEqual({
      text: [
        '<thread_context>',
        '[note: some earlier thread messages were omitted from this context]',
        ...expectedLines,
        '</thread_context>',
      ].join('\n'),
      images: [],
      contextMaxTs: '400.000',
    })
  })

  it('notes truncation and drops the oldest messages when the char budget is exceeded', async () => {
    const longText = 'x'.repeat(9000)
    const messages = [
      message({ ts: '300.000', userId: 'U2', text: longText }),
      message({ ts: '301.000', userId: 'U2', text: longText }),
      message({ ts: '302.000', userId: 'U2', text: 'newest' }),
    ]
    const { client } = scriptedSlackClient([
      { messages, hasMore: false, nextCursor: undefined },
    ])
    const deps = baseDeps({ slackClient: client })

    const result = await syncThreadContext(
      deps,
      ENV,
      '200.000',
      NEVER_IN_FLIGHT,
    )

    expect(result).toEqual({
      text: [
        '<thread_context>',
        '[note: some earlier thread messages were omitted from this context]',
        `[${iso('301.000')}] <@U2>: ${longText}`,
        `[${iso('302.000')}] <@U2>: newest`,
        '</thread_context>',
      ].join('\n'),
      images: [],
      contextMaxTs: '302.000',
    })
  })
})
