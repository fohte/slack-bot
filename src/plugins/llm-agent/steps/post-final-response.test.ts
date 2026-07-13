import { describe, expect, it } from 'vitest'

import {
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createScriptedEventLogStore,
  createStubSlackClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import { resolveDeps } from '@/plugins/llm-agent/dispatcher-deps'
import { postFinalResponse } from '@/plugins/llm-agent/steps/post-final-response'
import type { SlackWebClient } from '@/slack/web-client'

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

describe('postFinalResponse', () => {
  it('posts the response as a markdown block and clears the assistant status', async () => {
    const slackClient = createStubSlackClient()
    const result = await postFinalResponse(
      TEST_ENV,
      '**bold** answer',
      baseDeps({ slackClient }),
    )

    expect(result).toEqual({ posted: true })
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: '**bold** answer',
        blocks: [{ type: 'markdown', text: '**bold** answer' }],
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
  })

  it('escapes mrkdwn-significant characters in the top-level text but not in the markdown block', async () => {
    const slackClient = createStubSlackClient()
    await postFinalResponse(
      TEST_ENV,
      'a < b & c > d',
      baseDeps({ slackClient }),
    )

    expect(slackClient.calls[0]).toEqual({
      kind: 'post',
      channel: 'C1',
      thread: '111.222',
      text: 'a &lt; b &amp; c &gt; d',
      blocks: [{ type: 'markdown', text: 'a < b & c > d' }],
      loadingMessages: undefined,
    })
  })

  it('truncates the markdown block text to the Slack 12,000-character limit', async () => {
    const slackClient = createStubSlackClient()
    const longText = 'a'.repeat(12_005)

    await postFinalResponse(TEST_ENV, longText, baseDeps({ slackClient }))

    const truncatedBlockText = `${'a'.repeat(11_999)}…`
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: longText,
        blocks: [{ type: 'markdown', text: truncatedBlockText }],
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
  })

  it('drops a surrogate pair straddling the cut point instead of splitting it', async () => {
    const slackClient = createStubSlackClient()
    const longText = `${'a'.repeat(11_998)}😀${'a'.repeat(10)}`

    await postFinalResponse(TEST_ENV, longText, baseDeps({ slackClient }))

    const truncatedBlockText = `${'a'.repeat(11_998)}…`
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: longText,
        blocks: [{ type: 'markdown', text: truncatedBlockText }],
        loadingMessages: undefined,
      },
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
  })

  it('does not post a second time when event_log already marked this event responded (duplicate delivery)', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore()
    const deps = baseDeps({ slackClient, eventLogStore })

    const first = await postFinalResponse(TEST_ENV, 'first reply', deps)
    const second = await postFinalResponse(TEST_ENV, 'second reply', deps)

    expect(first).toEqual({ posted: true })
    expect(second).toEqual({ posted: false })
    expect(slackClient.calls.filter((c) => c.kind === 'post')).toHaveLength(1)
  })

  it('rolls back event_log and rethrows when the Slack post fails', async () => {
    const postError = new Error('rate_limited')
    const stub = createStubSlackClient()
    const slackClient: SlackWebClient = {
      ...stub,
      async postMessage() {
        throw postError
      },
    }
    const eventLogStore = createScriptedEventLogStore()
    const deps = baseDeps({ slackClient, eventLogStore })

    await expect(postFinalResponse(TEST_ENV, 'reply', deps)).rejects.toBe(
      postError,
    )
    // The rollback must let a retry mark and post again rather than being
    // stuck thinking this event was already responded to.
    const retry = await postFinalResponse(TEST_ENV, 'reply', {
      ...deps,
      slackClient: stub,
    })
    expect(retry).toEqual({ posted: true })
    expect(stub.calls.filter((c) => c.kind === 'post')).toHaveLength(1)
  })
})
