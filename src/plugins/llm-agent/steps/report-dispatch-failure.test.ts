import { describe, expect, it } from 'vitest'

import type { RecordingLogger } from '@/plugins/llm-agent/_test-utils'
import {
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createRecordingLogger,
  createScriptedEventLogStore,
  createStubSlackClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import type { ResolvedDispatcherDeps } from '@/plugins/llm-agent/dispatcher-deps'
import { resolveDeps } from '@/plugins/llm-agent/dispatcher-deps'
import {
  DISPATCH_FAILURE_TEXT,
  reportDispatchFailure,
} from '@/plugins/llm-agent/steps/report-dispatch-failure'
import type { SlackWebClient } from '@/slack/web-client'

const baseDeps = (
  slackClient: SlackWebClient,
  logger?: RecordingLogger,
): ResolvedDispatcherDeps =>
  resolveDeps({
    conversationAgent: createFakeConversationAgent(() => {
      throw new Error('not implemented')
    }),
    remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
    a2aTaskTracker: createFakeA2aTaskTracker(),
    eventLogStore: createScriptedEventLogStore(),
    slackClient,
    ...(logger !== undefined && { logger }),
  })

describe('reportDispatchFailure', () => {
  it('posts the generic failure text and clears the assistant status', async () => {
    const slackClient = createStubSlackClient()
    await reportDispatchFailure(TEST_ENV, baseDeps(slackClient))
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: DISPATCH_FAILURE_TEXT,
        blocks: undefined,
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

  it('logs and still clears the assistant status when the Slack post fails', async () => {
    const postError = new Error('rate_limited')
    const stub = createStubSlackClient()
    const slackClient: SlackWebClient = {
      ...stub,
      async postMessage() {
        throw postError
      },
    }
    const logger = createRecordingLogger()
    await reportDispatchFailure(TEST_ENV, baseDeps(slackClient, logger))
    expect(stub.calls).toEqual([
      {
        kind: 'status',
        channel: 'C1',
        thread: '111.222',
        text: '',
        blocks: undefined,
        loadingMessages: undefined,
      },
    ])
    expect(logger.entries).toEqual([
      {
        level: 'error',
        payload: {
          event: 'llm_agent_dispatch_failure_notify_failed',
          event_id: 'Ev1',
          err: postError,
        },
        message: 'failed to notify Slack thread about a dispatch failure',
      },
    ])
  })
})
