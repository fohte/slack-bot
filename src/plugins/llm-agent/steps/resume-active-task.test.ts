import type { MessageSendParams } from '@a2a-js/sdk'
import { TaskNotFoundError } from '@a2a-js/sdk/client'
import { describe, expect, it } from 'vitest'

import {
  cardFor,
  createFakeA2aTaskTracker,
  createFakeConversationAgent,
  createFakeRemoteAgentRegistry,
  createScriptedEventLogStore,
  createStubSlackClient,
  recordingHandleFor,
  taskResult,
  TEST_ENV,
  TEST_THREAD_KEY,
} from '@/plugins/llm-agent/_test-utils'
import type { A2aTaskRow } from '@/plugins/llm-agent/a2a-task-tracker'
import { resolveDeps } from '@/plugins/llm-agent/dispatcher-deps'
import {
  RESUME_SEND_FAILURE_TEXT,
  resumeActiveTask,
} from '@/plugins/llm-agent/steps/resume-active-task'

const ACTIVE_TASK: A2aTaskRow = {
  ...TEST_THREAD_KEY,
  taskId: 'task-1',
  contextId: 'ctx-1',
  agentName: 'meshi',
  slackEventId: 'Ev0',
  state: 'input-required',
  settled: false,
  deadlineAt: new Date('2026-01-01T00:15:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

const baseDeps = (overrides: Partial<Parameters<typeof resolveDeps>[0]> = {}) =>
  resolveDeps({
    conversationAgent: createFakeConversationAgent(() => {
      throw new Error('not implemented')
    }),
    remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
    a2aTaskTracker: createFakeA2aTaskTracker(),
    eventLogStore: createScriptedEventLogStore(),
    slackClient: createStubSlackClient(),
    now: () => new Date('2026-01-01T00:05:00Z'),
    randomUUID: () => 'generated-id',
    ...overrides,
  })

describe('resumeActiveTask', () => {
  it('sends the reply as an additional message/send to the same taskId + contextId', async () => {
    const { handle, calls } = recordingHandleFor(
      async () => taskResult({ status: { state: 'working' } }),
      cardFor({ name: 'meshi' }),
    )
    const tracker = createFakeA2aTaskTracker()
    const deps = baseDeps({
      remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
      a2aTaskTracker: tracker,
    })

    const result = await resumeActiveTask(
      { ...TEST_ENV, text: 'here is more info' },
      ACTIVE_TASK,
      deps,
      [],
    )

    expect(calls).toEqual<MessageSendParams[]>([
      {
        message: {
          kind: 'message',
          messageId: 'generated-id',
          role: 'user',
          contextId: 'ctx-1',
          taskId: 'task-1',
          parts: [{ kind: 'text', text: 'here is more info' }],
        },
        configuration: { blocking: false },
      },
    ])
    expect(result.text).toBe(
      "Sent your reply to meshi. I'll follow up here once it's ready.",
    )
  })

  it('re-arms the deadline and records the observed state when the resume succeeds', async () => {
    const { handle } = recordingHandleFor(async () =>
      taskResult({ status: { state: 'working' } }),
    )
    const tracker = createFakeA2aTaskTracker()
    const deps = baseDeps({
      remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
      a2aTaskTracker: tracker,
      taskDeadlineMs: 60_000,
    })

    await resumeActiveTask(TEST_ENV, ACTIVE_TASK, deps, [])

    expect(tracker.transitions).toEqual([
      {
        taskId: 'task-1',
        to: {
          state: 'working',
          deadlineAt: new Date('2026-01-01T00:06:00Z'),
          requireCurrentStates: ['input-required'],
        },
      },
    ])
  })

  it('forwards attached images as A2A FileParts', async () => {
    const { handle, calls } = recordingHandleFor(async () => taskResult())

    await resumeActiveTask(
      TEST_ENV,
      ACTIVE_TASK,
      baseDeps({
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
      }),
      [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
    )

    expect(calls[0]?.message.parts).toEqual([
      { kind: 'text', text: TEST_ENV.text },
      { kind: 'file', file: { bytes: 'AAAA', mimeType: 'image/jpeg' } },
    ])
  })

  it('responds with a failure message and leaves the task untouched when the resume send fails', async () => {
    const { handle } = recordingHandleFor(async () => {
      throw new Error('connection refused')
    })
    const tracker = createFakeA2aTaskTracker()

    const result = await resumeActiveTask(
      TEST_ENV,
      ACTIVE_TASK,
      baseDeps({
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        a2aTaskTracker: tracker,
      }),
      [],
    )

    expect(result.text).toBe(RESUME_SEND_FAILURE_TEXT)
    expect(tracker.transitions).toEqual([])
    expect(tracker.recorded).toEqual([])
  })

  it('settles the task and redelegates as a new task when the remote task is TaskNotFound', async () => {
    let call = 0
    const { handle, calls } = recordingHandleFor(async () => {
      call += 1
      if (call === 1) throw new TaskNotFoundError('task not found')
      return taskResult({
        id: 'task-2',
        contextId: 'ctx-1',
        status: { state: 'submitted' },
      })
    })
    const tracker = createFakeA2aTaskTracker()
    const deps = baseDeps({
      remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
      a2aTaskTracker: tracker,
      taskDeadlineMs: 60_000,
    })

    const result = await resumeActiveTask(
      { ...TEST_ENV, text: 'still there?' },
      ACTIVE_TASK,
      deps,
      [],
    )

    expect(tracker.transitions).toEqual([
      {
        taskId: 'task-1',
        to: { state: 'failed', requireCurrentStates: ['input-required'] },
      },
    ])
    expect(calls).toEqual<MessageSendParams[]>([
      {
        message: {
          kind: 'message',
          messageId: 'generated-id',
          role: 'user',
          contextId: 'ctx-1',
          taskId: 'task-1',
          parts: [{ kind: 'text', text: 'still there?' }],
        },
        configuration: { blocking: false },
      },
      {
        message: {
          kind: 'message',
          messageId: 'generated-id',
          role: 'user',
          contextId: 'ctx-1',
          parts: [{ kind: 'text', text: 'still there?' }],
        },
        configuration: { blocking: false },
      },
    ])
    expect(tracker.recorded).toEqual([
      {
        taskId: 'task-2',
        contextId: 'ctx-1',
        agentName: 'meshi',
        ...TEST_THREAD_KEY,
        slackEventId: TEST_ENV.eventId,
        state: 'submitted',
        deadlineAt: new Date('2026-01-01T00:06:00Z'),
      },
    ])
    expect(result.text).toBe(
      'Delegated to meshi (taskId=task-2). The task runs asynchronously; ' +
        "I'll follow up here once it's ready.",
    )
  })

  it('settles the task and redelegates when the remote task is already terminal', async () => {
    let call = 0
    const { handle } = recordingHandleFor(async () => {
      call += 1
      if (call === 1) {
        throw new Error(
          'JSON-RPC error: Task task-1 is in a terminal state (completed) and cannot be modified. (Code: -32600) Data: {}',
        )
      }
      return taskResult({ id: 'task-2', contextId: 'ctx-1' })
    })
    const tracker = createFakeA2aTaskTracker()

    const result = await resumeActiveTask(
      TEST_ENV,
      ACTIVE_TASK,
      baseDeps({
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        a2aTaskTracker: tracker,
      }),
      [],
    )

    expect(tracker.transitions).toEqual([
      {
        taskId: 'task-1',
        to: { state: 'failed', requireCurrentStates: ['input-required'] },
      },
    ])
    expect(tracker.recorded).toEqual([
      {
        taskId: 'task-2',
        contextId: 'ctx-1',
        agentName: 'meshi',
        ...TEST_THREAD_KEY,
        slackEventId: TEST_ENV.eventId,
        state: 'submitted',
        deadlineAt: new Date('2026-01-01T00:20:00Z'),
      },
    ])
    expect(result.text).toBe(
      'Delegated to meshi (taskId=task-2). The task runs asynchronously; ' +
        "I'll follow up here once it's ready.",
    )
  })

  it('reports a failure when the redelegation send itself fails', async () => {
    let call = 0
    const { handle } = recordingHandleFor(async () => {
      call += 1
      if (call === 1) throw new TaskNotFoundError('task not found')
      throw new Error('connection refused')
    })
    const tracker = createFakeA2aTaskTracker()

    const result = await resumeActiveTask(
      TEST_ENV,
      ACTIVE_TASK,
      baseDeps({
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        a2aTaskTracker: tracker,
      }),
      [],
    )

    expect(tracker.transitions).toEqual([
      {
        taskId: 'task-1',
        to: { state: 'failed', requireCurrentStates: ['input-required'] },
      },
    ])
    expect(tracker.recorded).toEqual([])
    expect(result.text).toBe(RESUME_SEND_FAILURE_TEXT)
  })

  it('reports a failure when the previously delegated agent is no longer registered', async () => {
    const result = await resumeActiveTask(
      TEST_ENV,
      ACTIVE_TASK,
      baseDeps({ remoteAgentRegistry: createFakeRemoteAgentRegistry([]) }),
      [],
    )

    expect(result.text).toBe(RESUME_SEND_FAILURE_TEXT)
  })
})
