import { describe, expect, it } from 'vitest'

import {
  createScriptedEventLogStore,
  createScriptedTaskCrClient,
  createScriptedThreadSessionStore,
  createStubSlackClient,
  fixedOpencodeClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import type { ProcessMentionDeps } from '@/plugins/llm-agent/process-mention'
import { submitTask } from '@/plugins/llm-agent/process-mention'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'

describe('submitTask', () => {
  it('creates a Task CR with the Slack envelope contexts and records the task_name', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
    }

    const result = await submitTask(TEST_ENV, deps)

    const expectedName = taskCrNameForSlackEvent(TEST_ENV.eventId)
    expect({
      result,
      creates: taskCrClient.creates,
      marked: eventLogStore.markedTaskNames,
    }).toEqual({
      result: { taskName: expectedName },
      creates: [
        {
          name: expectedName,
          namespace: 'kubeopencode',
          agentName: 'slack-bot',
          description: 'hello bot',
          contexts: [
            {
              name: 'slack-channel',
              mountPath: 'slack-context/channel',
              text: 'C1',
            },
            {
              name: 'slack-thread-ts',
              mountPath: 'slack-context/thread-ts',
              text: '111.222',
            },
          ],
        },
      ],
      marked: [{ id: 'Ev1', name: expectedName }],
    })
  })

  it('attaches the opencode session id when a thread is already mapped', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore: createScriptedThreadSessionStore({
        lookup: () => 'ses_abc',
      }),
      slackClient: createStubSlackClient(),
    }

    const result = await submitTask(TEST_ENV, deps)

    const expectedName = taskCrNameForSlackEvent(TEST_ENV.eventId)
    expect({
      result,
      creates: taskCrClient.creates,
      marked: eventLogStore.markedTaskNames,
    }).toEqual({
      result: { taskName: expectedName },
      creates: [
        {
          name: expectedName,
          namespace: 'kubeopencode',
          agentName: 'slack-bot',
          description: 'hello bot',
          contexts: [
            {
              name: 'slack-channel',
              mountPath: 'slack-context/channel',
              text: 'C1',
            },
            {
              name: 'slack-thread-ts',
              mountPath: 'slack-context/thread-ts',
              text: '111.222',
            },
            {
              name: 'opencode-session-id',
              mountPath: 'slack-context/session-id',
              text: 'ses_abc',
            },
          ],
        },
      ],
      marked: [{ id: 'Ev1', name: expectedName }],
    })
  })
})
