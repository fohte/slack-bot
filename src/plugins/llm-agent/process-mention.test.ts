import { describe, expect, it } from 'vitest'

import {
  createScriptedEventLogStore,
  createScriptedTaskCrClient,
  createScriptedThreadSessionStore,
  createStubSlackClient,
  fixedOpencodeClient,
  noopConfigMapClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import type { ProcessMentionDeps } from '@/plugins/llm-agent/process-mention'
import {
  PREPARING_BUBBLE,
  processMention,
  QUEUED_BUBBLE,
  RUNNING_BUBBLE,
} from '@/plugins/llm-agent/process-mention'

describe('processMention', () => {
  it('drives a submitted task through Queued → Running → Completed and posts the reply as a markdown block', async () => {
    const taskName = 'task-1'
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: 'Queued',
          message: undefined,
        },
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: 'Running',
          message: undefined,
        },
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: 'Completed',
          message: undefined,
        },
      ]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: '**bold** answer',
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    await processMention(TEST_ENV, taskName, deps, {
      initialBubble: PREPARING_BUBBLE,
    })

    const actual = {
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }
    expect(actual).toEqual({
      slackCalls: [
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: QUEUED_BUBBLE.status,
          blocks: undefined,
          loadingMessages: QUEUED_BUBBLE.loadingMessages,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: RUNNING_BUBBLE.status,
          blocks: undefined,
          loadingMessages: RUNNING_BUBBLE.loadingMessages,
        },
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
      ],
      upserts: [
        {
          slackTeamId: 'T1',
          slackChannelId: 'C1',
          threadRootTs: '111.222',
          opencodeSessionId: 'ses_xyz',
        },
      ],
    })
  })
})
