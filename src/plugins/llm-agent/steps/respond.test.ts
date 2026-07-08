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
import type {
  ProcessMentionDeps,
  TerminalOutcome,
} from '@/plugins/llm-agent/process-mention'
import { respond } from '@/plugins/llm-agent/process-mention'

describe('respond', () => {
  it('posts the raw assistant text as a markdown block and upserts the opencode session id on completed', async () => {
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: '**bold** answer',
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
    }
    const outcome: TerminalOutcome = { kind: 'completed' }
    await respond(TEST_ENV, 'task-1', outcome, deps)
    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
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

  it('posts a Markdown table as a markdown block so Slack renders it natively', async () => {
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const tableText = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: tableText,
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
    }
    const outcome: TerminalOutcome = { kind: 'completed' }
    await respond(TEST_ENV, 'task-1', outcome, deps)
    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: tableText,
          blocks: [{ type: 'markdown', text: tableText }],
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

  it('posts an escaped failure message and does not upsert thread session on failed', async () => {
    const slackClient = createStubSlackClient()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore,
      slackClient,
    }
    const outcome: TerminalOutcome = {
      kind: 'failed',
      message: '<oops> & died',
    }
    await respond(TEST_ENV, 'task-1', outcome, deps)
    expect({
      slackCalls: slackClient.calls,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'Task failed: &lt;oops&gt; &amp; died',
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
      ],
      upserts: [],
    })
  })

  it('falls back to the placeholder text when the opencode session yields no assistant message', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore()
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: undefined,
      }),
      eventLogStore,
      threadSessionStore,
      slackClient,
    }
    await respond(TEST_ENV, 'task-1', { kind: 'completed' }, deps)
    expect({
      slackCalls: slackClient.calls,
      markedResponded: eventLogStore.markedResponded,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: '(opencode did not produce an assistant message)',
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
      ],
      markedResponded: ['Ev1'],
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

  it('deletes the image ConfigMap after responding so the namespace stays clean', async () => {
    const deletes: Array<{ name: string; namespace: string }> = []
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      configMapClient: {
        async create() {
          throw new Error('unused in respond test')
        },
        async delete(spec) {
          deletes.push({ name: spec.name, namespace: spec.namespace })
          return 'deleted'
        },
      },
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: 'answer',
      }),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
    }
    await respond(TEST_ENV, 'slack-task-1', { kind: 'completed' }, deps)
    expect(deletes).toEqual([
      { name: 'slack-task-1-images', namespace: 'kubeopencode' },
    ])
  })

  it('skips the Slack post and per-task teardown when event_log markResponded reports already-responded', async () => {
    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore({
      alreadyResponded: true,
    })
    const threadSessionStore = createScriptedThreadSessionStore()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([]),
      opencodeClient: fixedOpencodeClient({
        sessionId: 'ses_xyz',
        assistantText: 'answer',
      }),
      eventLogStore,
      threadSessionStore,
      slackClient,
    }
    await respond(TEST_ENV, 'task-1', { kind: 'completed' }, deps)
    expect({
      slackCalls: slackClient.calls,
      markedResponded: eventLogStore.markedResponded,
      upserts: threadSessionStore.upserts,
    }).toEqual({
      slackCalls: [],
      markedResponded: [],
      upserts: [],
    })
  })
})
