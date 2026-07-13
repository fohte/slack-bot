import type { Message, Task } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'

import {
  createFakeRemoteAgentRegistry,
  createInMemoryA2aTaskTracker,
  createRecordingLogger,
  createScriptedEventLogStore,
  createStubSlackClient,
  recordingHandleForGetTask,
} from '@/plugins/llm-agent/_test-utils'
import type { NewA2aTask } from '@/plugins/llm-agent/a2a-task-tracker'
import {
  createResponseFinalizer,
  USAGE_LIMIT_TEXT,
} from '@/plugins/llm-agent/response-finalizer'
import type { SlackWebClient } from '@/slack/web-client'

const NOW = new Date('2026-01-01T00:00:00Z')

const baseTask = (override: Partial<NewA2aTask> = {}): NewA2aTask => ({
  taskId: 'task-1',
  contextId: 'ctx-1',
  agentName: 'meshi',
  slackTeamId: 'T1',
  slackChannelId: 'C1',
  threadRootTs: '111.222',
  slackEventId: 'Ev1',
  state: 'working',
  deadlineAt: new Date('2026-01-01T00:15:00Z'),
  ...override,
})

const textMessage = (
  text: string,
  metadata?: Record<string, unknown>,
): Message => ({
  kind: 'message',
  messageId: 'm1',
  role: 'agent',
  parts: [{ kind: 'text', text }],
  ...(metadata !== undefined ? { metadata } : {}),
})

const taskWith = (
  state: Task['status']['state'],
  message: Message,
  taskId = 'task-1',
): Task => ({
  kind: 'task',
  id: taskId,
  contextId: 'ctx-1',
  status: { state, message },
})

describe('createResponseFinalizer', () => {
  describe('finalize - terminal settle', () => {
    it('posts the task message and marks the originating event responded', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask())
      const { handle, calls } = recordingHandleForGetTask(async () =>
        taskWith('completed', textMessage('Recorded your meal.')),
      )
      const slackClient = createStubSlackClient()
      const eventLogStore = createScriptedEventLogStore()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore,
        slackClient,
      })

      await finalizer.finalize('task-1')

      expect(calls).toEqual(['task-1'])
      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'Recorded your meal.',
          blocks: [{ type: 'markdown', text: 'Recorded your meal.' }],
          loadingMessages: undefined,
        },
      ])
      expect(eventLogStore.markedResponded).toEqual(['Ev1'])
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask(),
        state: 'completed',
        settled: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })

    it('posts a dedicated message instead of the task text when error_kind is usage_limit', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask())
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith(
          'failed',
          textMessage('internal opencode-go 429 detail', {
            error_kind: 'usage_limit',
          }),
        ),
      )
      const slackClient = createStubSlackClient()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
      })

      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: USAGE_LIMIT_TEXT,
          blocks: [{ type: 'markdown', text: USAGE_LIMIT_TEXT }],
          loadingMessages: undefined,
        },
      ])
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask(),
        state: 'failed',
        settled: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })

    it('posts only once when the same completed task is observed twice (duplicate push)', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask())
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith('completed', textMessage('done')),
      )
      const slackClient = createStubSlackClient()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
      })

      await finalizer.finalize('task-1')
      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'done',
          blocks: [{ type: 'markdown', text: 'done' }],
          loadingMessages: undefined,
        },
      ])
    })

    it('settles two tasks delegated under the same Slack event independently', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(
        baseTask({ taskId: 'task-a', slackEventId: 'Ev1' }),
      )
      await tracker.recordDelegated(
        baseTask({ taskId: 'task-b', slackEventId: 'Ev1' }),
      )
      const responses: Record<string, Task> = {
        'task-a': taskWith('completed', textMessage('A done'), 'task-a'),
        'task-b': taskWith('completed', textMessage('B done'), 'task-b'),
      }
      const { handle } = recordingHandleForGetTask(async (taskId) => {
        const task = responses[taskId]
        if (task === undefined) throw new Error(`unexpected taskId ${taskId}`)
        return task
      })
      const slackClient = createStubSlackClient()
      const eventLogStore = createScriptedEventLogStore()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore,
        slackClient,
      })

      await finalizer.finalize('task-a')
      await finalizer.finalize('task-b')

      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'A done',
          blocks: [{ type: 'markdown', text: 'A done' }],
          loadingMessages: undefined,
        },
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'B done',
          blocks: [{ type: 'markdown', text: 'B done' }],
          loadingMessages: undefined,
        },
      ])
      // markResponded only actually flips once (the second call races an
      // already-responded event_log row), yet both tasks still posted.
      expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    })

    it('rolls back the settled flag when the Slack post fails, so a retry can settle it', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask())
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith('completed', textMessage('done')),
      )
      const failingSlackClient: SlackWebClient = {
        ...createStubSlackClient(),
        async postMessage() {
          throw new Error('rate_limited')
        },
      }
      const eventLogStore = createScriptedEventLogStore()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore,
        slackClient: failingSlackClient,
      })

      await finalizer.finalize('task-1')

      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask(),
        state: 'completed',
        settled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(eventLogStore.markedResponded).toEqual([])

      const retryingSlackClient = createStubSlackClient()
      const retryFinalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore,
        slackClient: retryingSlackClient,
      })
      await retryFinalizer.finalize('task-1')

      expect(retryingSlackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'done',
          blocks: [{ type: 'markdown', text: 'done' }],
          loadingMessages: undefined,
        },
      ])
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask(),
        state: 'completed',
        settled: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })
  })

  describe('finalize - input-required', () => {
    it('posts the question but leaves the task and event unsettled', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask({ state: 'working' }))
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith('input-required', textMessage('What did you eat?')),
      )
      const slackClient = createStubSlackClient()
      const eventLogStore = createScriptedEventLogStore()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore,
        slackClient,
      })

      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'What did you eat?',
          blocks: [{ type: 'markdown', text: 'What did you eat?' }],
          loadingMessages: undefined,
        },
      ])
      expect(eventLogStore.markedResponded).toEqual([])
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask({ state: 'input-required' }),
        settled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })

    it('reverts to the pre-transition state when the Slack post fails, so a retry can post the question', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask({ state: 'working' }))
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith('input-required', textMessage('What did you eat?')),
      )
      const failingSlackClient: SlackWebClient = {
        ...createStubSlackClient(),
        async postMessage() {
          throw new Error('rate_limited')
        },
      }
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient: failingSlackClient,
      })

      await finalizer.finalize('task-1')

      // Without the revert, this row would be stuck at input-required
      // forever: transitionGuard only allows entering input-required from
      // an active-execution state, so a row already at input-required could
      // never transition into it again to retry the post.
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask({ state: 'working' }),
        settled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })

      const retryingSlackClient = createStubSlackClient()
      const retryFinalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient: retryingSlackClient,
      })
      await retryFinalizer.finalize('task-1')

      expect(retryingSlackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'What did you eat?',
          blocks: [{ type: 'markdown', text: 'What did you eat?' }],
          loadingMessages: undefined,
        },
      ])
    })

    it('does not repost the question when the task is still input-required on a later observation', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask({ state: 'working' }))
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith('input-required', textMessage('What did you eat?')),
      )
      const slackClient = createStubSlackClient()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
      })

      await finalizer.finalize('task-1')
      // A second observation (e.g. a redelivered push, or the future
      // reconciler polling the still-unsettled row) with the exact same
      // remote state must not duplicate the question in the thread.
      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'What did you eat?',
          blocks: [{ type: 'markdown', text: 'What did you eat?' }],
          loadingMessages: undefined,
        },
      ])
    })
  })

  describe('finalize - heartbeat', () => {
    it('refreshes the row on a working observation without posting anything', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask({ state: 'submitted' }))
      const { handle } = recordingHandleForGetTask(async () => ({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'working' },
      }))
      const slackClient = createStubSlackClient()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
      })

      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([])
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask({ state: 'working' }),
        settled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })
  })

  describe('finalize - unknown taskId', () => {
    it('retries once after a short delay, then discards it if still untracked', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      const sleepCalls: number[] = []
      const logger = createRecordingLogger()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient: createStubSlackClient(),
        unknownTaskRetryDelayMs: 1234,
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
        logger,
      })

      await finalizer.finalize('never-recorded')

      expect(sleepCalls).toEqual([1234])
      expect(logger.entries).toEqual([
        {
          level: 'warn',
          payload: {
            event: 'llm_agent_a2a_finalize_unknown_task',
            task_id: 'never-recorded',
          },
          message:
            'llm-agent received a push notification for an untracked task; discarding',
        },
      ])
    })

    it('picks up the row if it is recorded during the retry delay', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      const { handle } = recordingHandleForGetTask(async () =>
        taskWith('completed', textMessage('done')),
      )
      const slackClient = createStubSlackClient()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
        sleep: async () => {
          await tracker.recordDelegated(baseTask())
        },
      })

      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([
        {
          kind: 'post',
          channel: 'C1',
          thread: '111.222',
          text: 'done',
          blocks: [{ type: 'markdown', text: 'done' }],
          loadingMessages: undefined,
        },
      ])
    })
  })

  describe('finalize - remote agent unavailable', () => {
    it('logs a warning and does not post when the remote agent is no longer registered', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask())
      const slackClient = createStubSlackClient()
      const logger = createRecordingLogger()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
        logger,
      })

      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([])
      expect(logger.entries).toEqual([
        {
          level: 'warn',
          payload: {
            event: 'llm_agent_a2a_finalize_agent_not_found',
            task_id: 'task-1',
            agent_name: 'meshi',
          },
          message:
            'llm-agent could not finalize a task: its remote agent is no longer registered',
        },
      ])
    })
  })

  describe('finalize - tasks/get failure', () => {
    it('logs a warning and does not post when tasks/get fails', async () => {
      const tracker = createInMemoryA2aTaskTracker({ now: () => NOW })
      await tracker.recordDelegated(baseTask())
      const networkError = new Error('network error')
      const { handle } = recordingHandleForGetTask(async () => {
        throw networkError
      })
      const slackClient = createStubSlackClient()
      const logger = createRecordingLogger()
      const finalizer = createResponseFinalizer({
        a2aTaskTracker: tracker,
        remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
        eventLogStore: createScriptedEventLogStore(),
        slackClient,
        logger,
      })

      await finalizer.finalize('task-1')

      expect(slackClient.calls).toEqual([])
      expect(logger.entries).toEqual([
        {
          level: 'warn',
          payload: {
            event: 'llm_agent_a2a_finalize_get_task_failed',
            task_id: 'task-1',
            agent_name: 'meshi',
            err: networkError,
          },
          message:
            'llm-agent failed to fetch tasks/get while finalizing a task',
        },
      ])
      expect(await tracker.findByTaskId('task-1')).toEqual({
        ...baseTask(),
        settled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    })
  })
})
