import { describe, expect, it } from 'vitest'

import { createRecordingLogger } from '@/plugins/llm-agent/_test-utils'
import {
  CLEAR_STATUS,
  trySetAssistantStatus,
} from '@/plugins/llm-agent/assistant-status'
import type { SlackWebClient } from '@/slack/web-client'

interface CapturedCall {
  readonly channel_id: string
  readonly thread_ts: string
  readonly status: string
  readonly loading_messages: readonly string[] | undefined
}

const createSlackStub = (
  options: { throwError?: Error } = {},
): SlackWebClient & { readonly calls: ReadonlyArray<CapturedCall> } => {
  const calls: CapturedCall[] = []
  return {
    calls,
    async setAssistantThreadStatus(arg: {
      channel_id: string
      thread_ts: string
      status: string
      loading_messages?: string[]
    }) {
      if (options.throwError !== undefined) throw options.throwError
      calls.push({
        channel_id: arg.channel_id,
        thread_ts: arg.thread_ts,
        status: arg.status,
        loading_messages: arg.loading_messages,
      })
      return { ok: true } as never
    },
    async postMessage() {
      throw new Error('not implemented')
    },
    async updateMessage() {
      throw new Error('not implemented')
    },
    async deleteMessage() {
      throw new Error('not implemented')
    },
    async openView() {
      throw new Error('not implemented')
    },
    async updateView() {
      throw new Error('not implemented')
    },
    async pushView() {
      throw new Error('not implemented')
    },
    async postToResponseUrl() {
      throw new Error('not implemented')
    },
    async downloadFile() {
      throw new Error('not implemented')
    },
    async getFileInfo() {
      throw new Error('not implemented')
    },
  } as SlackWebClient & { readonly calls: ReadonlyArray<CapturedCall> }
}

describe('trySetAssistantStatus', () => {
  it('forwards status and loading messages to the Slack client', async () => {
    const slackClient = createSlackStub()
    await trySetAssistantStatus({
      slackClient,
      target: { channelId: 'C1', threadTs: '111.222' },
      status: 'is thinking...',
      loadingMessages: ['Preparing your task…'],
    })
    expect(slackClient.calls).toEqual([
      {
        channel_id: 'C1',
        thread_ts: '111.222',
        status: 'is thinking...',
        loading_messages: ['Preparing your task…'],
      },
    ])
  })

  it('omits loading_messages from the Slack payload when none are supplied', async () => {
    const slackClient = createSlackStub()
    await trySetAssistantStatus({
      slackClient,
      target: { channelId: 'C1', threadTs: '111.222' },
      status: CLEAR_STATUS,
    })
    expect(slackClient.calls).toEqual([
      {
        channel_id: 'C1',
        thread_ts: '111.222',
        status: '',
        loading_messages: undefined,
      },
    ])
  })

  it('swallows a set failure at warn level so the calling flow is not interrupted', async () => {
    const logger = createRecordingLogger()
    const failure = new Error('channel_not_supported')
    await trySetAssistantStatus({
      slackClient: createSlackStub({ throwError: failure }),
      target: { channelId: 'C1', threadTs: '111.222' },
      status: 'is thinking...',
      logger,
    })
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        payload: {
          event: 'llm_agent_assistant_status_set_failed',
          channel_id: 'C1',
          thread_ts: '111.222',
          status_length: 'is thinking...'.length,
          err: failure,
        },
        message:
          'failed to set assistant thread status; continuing without status indicator',
      },
    ])
  })

  it('logs a clear failure at error level so a stale indicator is surfaced to operators', async () => {
    const logger = createRecordingLogger()
    const failure = new Error('upstream timeout')
    await trySetAssistantStatus({
      slackClient: createSlackStub({ throwError: failure }),
      target: { channelId: 'C1', threadTs: '111.222' },
      status: CLEAR_STATUS,
      logger,
    })
    expect(logger.entries).toEqual([
      {
        level: 'error',
        payload: {
          event: 'llm_agent_assistant_status_clear_failed',
          channel_id: 'C1',
          thread_ts: '111.222',
          status_length: 0,
          err: failure,
        },
        message:
          'failed to clear assistant thread status; stale indicator may remain in the thread',
      },
    ])
  })
})
