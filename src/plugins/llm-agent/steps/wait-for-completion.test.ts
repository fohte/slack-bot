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
  bubbleForK8sPhase,
  PREPARING_BUBBLE,
  QUEUED_BUBBLE,
  RUNNING_BUBBLE,
  waitForCompletion,
} from '@/plugins/llm-agent/process-mention'

describe('bubbleForK8sPhase', () => {
  it('maps each non-terminal k8s phase to its bubble and everything else to undefined', () => {
    expect({
      Pending: bubbleForK8sPhase('Pending'),
      Queued: bubbleForK8sPhase('Queued'),
      Running: bubbleForK8sPhase('Running'),
      Completed: bubbleForK8sPhase('Completed'),
      Failed: bubbleForK8sPhase('Failed'),
      Unknown: bubbleForK8sPhase('Cancelled'),
      Undefined: bubbleForK8sPhase(undefined),
    }).toEqual({
      Pending: PREPARING_BUBBLE,
      Queued: QUEUED_BUBBLE,
      Running: RUNNING_BUBBLE,
      Completed: undefined,
      Failed: undefined,
      Unknown: undefined,
      Undefined: undefined,
    })
  })
})

describe('waitForCompletion', () => {
  it('polls until the Task CR reaches Completed and emits a bubble whenever the displayed status changes', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
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
    ])
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }

    const outcome = await waitForCompletion(TEST_ENV, taskName, deps, {
      initialBubble: PREPARING_BUBBLE,
    })

    expect({
      outcome,
      listCount: taskCrClient.listCount(),
      slackCalls: slackClient.calls,
    }).toEqual({
      outcome: { kind: 'completed' },
      listCount: 3,
      slackCalls: [
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: QUEUED_BUBBLE.status,
          loadingMessages: QUEUED_BUBBLE.loadingMessages,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: RUNNING_BUBBLE.status,
          loadingMessages: RUNNING_BUBBLE.loadingMessages,
        },
      ],
    })
  })

  it('returns Failed with the cluster message and does not emit a bubble when the Task CR transitions straight to Failed', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Failed',
        message: 'boom',
      },
    ])
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    const outcome = await waitForCompletion(TEST_ENV, taskName, deps)
    expect({
      outcome,
      slackCalls: slackClient.calls,
      listCount: taskCrClient.listCount(),
    }).toEqual({
      outcome: { kind: 'failed', message: 'boom' },
      slackCalls: [],
      listCount: 1,
    })
  })

  it('keeps sleeping past unknown / undefined phases without busy-looping', async () => {
    const taskName = 'task-1'
    let sleepCount = 0
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: createScriptedTaskCrClient([
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: undefined,
          message: undefined,
        },
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: 'Cancelled',
          message: undefined,
        },
        {
          name: taskName,
          namespace: 'kubeopencode',
          phase: 'Completed',
          message: undefined,
        },
      ]),
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
      pollIntervalMs: 0,
      sleep: async () => {
        sleepCount += 1
      },
    }
    const outcome = await waitForCompletion(TEST_ENV, taskName, deps)
    expect({ outcome, sleepCount }).toEqual({
      outcome: { kind: 'completed' },
      sleepCount: 2,
    })
  })

  it('throws when the Task CR is absent from the list result so the background poll loop terminates', async () => {
    const taskName = 'task-1'
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient: {
        async create() {
          return 'created'
        },
        async list() {
          return []
        },
      },
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    await expect(waitForCompletion(TEST_ENV, taskName, deps)).rejects.toThrow(
      `Task CR ${taskName} not found in namespace kubeopencode`,
    )
  })

  it('does not re-emit the Preparing bubble when the first observed phase is Pending', async () => {
    const taskName = 'task-1'
    const taskCrClient = createScriptedTaskCrClient([
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Pending',
        message: undefined,
      },
      {
        name: taskName,
        namespace: 'kubeopencode',
        phase: 'Completed',
        message: undefined,
      },
    ])
    const slackClient = createStubSlackClient()
    const deps: ProcessMentionDeps = {
      configMapClient: noopConfigMapClient,
      taskCrClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
      pollIntervalMs: 0,
      sleep: async () => {},
    }
    const outcome = await waitForCompletion(TEST_ENV, taskName, deps, {
      initialBubble: PREPARING_BUBBLE,
    })
    expect({
      outcome,
      slackCalls: slackClient.calls,
      listCount: taskCrClient.listCount(),
    }).toEqual({
      outcome: { kind: 'completed' },
      slackCalls: [],
      listCount: 2,
    })
  })
})
