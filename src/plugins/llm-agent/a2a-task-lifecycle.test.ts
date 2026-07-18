import type { Message, Task } from '@a2a-js/sdk'
import { ToolMessage } from '@langchain/core/messages'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import {
  cardFor,
  createFakeRemoteAgentRegistry,
  createInMemoryA2aTaskTracker,
  createScriptedEventLogStore,
  createStubRemoteAgent,
  createStubSlackClient,
  TEST_THREAD_KEY as THREAD_KEY,
} from '@/plugins/llm-agent/_test-utils'
import { createA2aNotificationHandler } from '@/plugins/llm-agent/push-notification-endpoint'
import { createDelegationTool } from '@/plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
import { createResponseFinalizer } from '@/plugins/llm-agent/response-finalizer'
import {
  DEADLINE_EXCEEDED_TEXT,
  startTaskReconciler,
} from '@/plugins/llm-agent/task-reconciler'

// These tests wire the real delegation tool, ResponseFinalizer, and
// TaskReconciler together against a single in-memory tracker (rather than
// exercising each in isolation as their own *.test.ts files do), and drive
// the push notification path through an actual HTTP request instead of
// calling ResponseFinalizer directly. Only the A2A remote agent (its Client)
// and the Slack client are stubbed, matching this repo's existing
// mock/stub conventions (see _test-utils.ts).

const TOKEN = 'shared-secret'

const submittedTask = (taskId: string, contextId: string): Task => ({
  kind: 'task',
  id: taskId,
  contextId,
  status: { state: 'submitted' },
})

const textMessage = (text: string): Message => ({
  kind: 'message',
  messageId: 'm1',
  role: 'agent',
  parts: [{ kind: 'text', text }],
})

const completedTask = (
  taskId: string,
  contextId: string,
  text: string,
): Task => ({
  kind: 'task',
  id: taskId,
  contextId,
  status: { state: 'completed', message: textMessage(text) },
})

const RUNTIME_CONTEXT = {
  slackEventId: 'Ev1',
  threadKey: THREAD_KEY,
  images: [] as ReadonlyArray<{ base64: string; mimeType: string }>,
}

// Invokes a delegation tool the way LangGraph's tool-calling node does, same
// as delegation-tool-factory.test.ts's own helper.
const invokeDelegationTool = async (
  toolInstance: ReturnType<typeof createDelegationTool>,
  args: Record<string, unknown>,
  context: typeof RUNTIME_CONTEXT = RUNTIME_CONTEXT,
): Promise<ToolMessage> => {
  const result: unknown = await toolInstance.invoke(
    { name: toolInstance.name, args, id: 'call-1', type: 'tool_call' },
    { context } as never,
  )
  if (!(result instanceof ToolMessage)) {
    throw new Error('expected a ToolMessage')
  }
  return result
}

const buildApp = (
  responseFinalizer: ReturnType<typeof createResponseFinalizer>,
): Hono => {
  const app = new Hono()
  app.post(
    '/api/a2a/notifications',
    createA2aNotificationHandler({ token: TOKEN, responseFinalizer }),
  )
  return app
}

const postNotification = (app: Hono, taskId: string, token = TOKEN) =>
  app.request('/api/a2a/notifications', {
    method: 'POST',
    headers: { 'X-A2A-Notification-Token': token },
    body: JSON.stringify({ id: taskId }),
  })

describe('A2A task lifecycle: delegation -> push notification -> settlement', () => {
  it('delegates a task, then settles it through the real push notification endpoint, finalizer, and tracker', async () => {
    const delegatedAt = new Date('2026-01-01T00:00:00Z')
    let clock = delegatedAt
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    const { handle, getTaskCalls } = createStubRemoteAgent({
      sendResult: async () => submittedTask('task-1', 'ctx-1'),
      getTaskResult: async (taskId) =>
        completedTask(taskId, 'ctx-1', 'Recorded your meal.'),
    })
    const delegationTool = createDelegationTool(handle, {
      a2aTaskTracker: tracker,
      now: () => clock,
      taskDeadlineMs: 15 * 60 * 1000,
      pushNotificationConfig: {
        url: 'https://slack-bot.example.com/api/a2a/notifications',
        token: TOKEN,
      },
    })

    const message = await invokeDelegationTool(delegationTool, {
      request: 'log my lunch',
    })
    expect(message.artifact).toEqual({
      agentName: 'meshi',
      taskId: 'task-1',
      contextId: 'ctx-1',
    })

    // Advance the clock to when the push notification arrives, so a settle
    // that failed to bump updatedAt would be caught by the assertion below.
    clock = new Date(delegatedAt.getTime() + 5 * 60 * 1000)

    const slackClient = createStubSlackClient()
    const eventLogStore = createScriptedEventLogStore()
    const finalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
      eventLogStore,
      slackClient,
    })
    const app = buildApp(finalizer)

    const response = await postNotification(app, 'task-1')

    expect(response.status).toBe(204)
    expect(getTaskCalls).toEqual(['task-1'])
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
      taskId: 'task-1',
      contextId: 'ctx-1',
      agentName: 'meshi',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      threadRootTs: '111.222',
      slackEventId: 'Ev1',
      state: 'completed',
      settled: true,
      deadlineAt: new Date('2026-01-01T00:15:00Z'),
      createdAt: delegatedAt,
      updatedAt: clock,
    })
  })

  it('rejects a push notification with an invalid token and leaves the delegated task unsettled', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const tracker = createInMemoryA2aTaskTracker({ now: () => now })
    const { handle, getTaskCalls } = createStubRemoteAgent({
      sendResult: async () => submittedTask('task-1', 'ctx-1'),
      getTaskResult: async (taskId) =>
        completedTask(taskId, 'ctx-1', 'Recorded your meal.'),
    })
    const delegationTool = createDelegationTool(handle, {
      a2aTaskTracker: tracker,
      now: () => now,
      taskDeadlineMs: 15 * 60 * 1000,
    })
    await invokeDelegationTool(delegationTool, { request: 'log my lunch' })

    const slackClient = createStubSlackClient()
    const finalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry: createFakeRemoteAgentRegistry([handle]),
      eventLogStore: createScriptedEventLogStore(),
      slackClient,
    })
    const app = buildApp(finalizer)

    const response = await postNotification(app, 'task-1', 'wrong-token')

    expect(response.status).toBe(401)
    expect(getTaskCalls).toEqual([])
    expect(slackClient.calls).toEqual([])
    expect(await tracker.findByTaskId('task-1')).toEqual({
      taskId: 'task-1',
      contextId: 'ctx-1',
      agentName: 'meshi',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      threadRootTs: '111.222',
      slackEventId: 'Ev1',
      state: 'submitted',
      settled: false,
      deadlineAt: new Date('2026-01-01T00:15:00Z'),
      createdAt: now,
      updatedAt: now,
    })
  })

  it('settles a task via reconciler polling when no push notification ever arrives', async () => {
    let clock = new Date('2026-01-10T00:00:00Z')
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    const { handle, getTaskCalls } = createStubRemoteAgent({
      sendResult: async () => submittedTask('task-1', 'ctx-1'),
      getTaskResult: async (taskId) => completedTask(taskId, 'ctx-1', 'done'),
    })
    const delegationTool = createDelegationTool(handle, {
      a2aTaskTracker: tracker,
      now: () => clock,
      taskDeadlineMs: 15 * 60 * 1000,
    })
    await invokeDelegationTool(delegationTool, { request: 'log my lunch' })

    // Past the reconciler's default grace period, but well before the
    // task's own 15-minute deadline: findUnsettled picks the row up, and
    // the reconciler must poll tasks/get (as opposed to the deadline test
    // below, where it must not).
    clock = new Date(clock.getTime() + 3 * 60 * 1000)

    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const finalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer: finalizer,
      eventLogStore,
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(getTaskCalls).toEqual(['task-1'])
    expect(result).toEqual({ settled: 1, pruned: 0 })
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
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(await tracker.findByTaskId('task-1')).toEqual({
      taskId: 'task-1',
      contextId: 'ctx-1',
      agentName: 'meshi',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      threadRootTs: '111.222',
      slackEventId: 'Ev1',
      state: 'completed',
      settled: true,
      deadlineAt: new Date('2026-01-10T00:15:00Z'),
      createdAt: new Date('2026-01-10T00:00:00Z'),
      updatedAt: clock,
    })
  })

  it('fails a task past its deadline via the reconciler, without polling, when no push arrives', async () => {
    let clock = new Date('2026-01-10T00:00:00Z')
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    const { handle, getTaskCalls } = createStubRemoteAgent({
      sendResult: async () => submittedTask('task-1', 'ctx-1'),
      getTaskResult: async () => {
        throw new Error('tasks/get must not be called once past the deadline')
      },
    })
    const delegationTool = createDelegationTool(handle, {
      a2aTaskTracker: tracker,
      now: () => clock,
      taskDeadlineMs: 60 * 1000,
    })
    await invokeDelegationTool(delegationTool, { request: 'log my lunch' })

    // Past both the grace period and the short deadline armed above.
    clock = new Date(clock.getTime() + 5 * 60 * 1000)

    const remoteAgentRegistry = createFakeRemoteAgentRegistry([handle])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const finalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const reconciler = startTaskReconciler({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      responseFinalizer: finalizer,
      eventLogStore,
      slackClient,
      now: () => clock,
      setIntervalImpl: () => ({}) as unknown as NodeJS.Timeout,
      clearIntervalImpl: () => {},
    })

    const result = await reconciler.runOnce()

    expect(getTaskCalls).toEqual([])
    expect(result).toEqual({ settled: 1, pruned: 0 })
    expect(slackClient.calls).toEqual([
      {
        kind: 'post',
        channel: 'C1',
        thread: '111.222',
        text: DEADLINE_EXCEEDED_TEXT,
        blocks: [{ type: 'markdown', text: DEADLINE_EXCEEDED_TEXT }],
        loadingMessages: undefined,
      },
    ])
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(await tracker.findByTaskId('task-1')).toEqual({
      taskId: 'task-1',
      contextId: 'ctx-1',
      agentName: 'meshi',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      threadRootTs: '111.222',
      slackEventId: 'Ev1',
      state: 'failed',
      settled: true,
      deadlineAt: new Date('2026-01-10T00:01:00Z'),
      createdAt: new Date('2026-01-10T00:00:00Z'),
      updatedAt: clock,
    })
  })

  it('settles two tasks delegated in parallel from the same Slack event independently, via the push notification endpoint', async () => {
    const delegatedAt = new Date('2026-01-01T00:00:00Z')
    let clock = delegatedAt
    const tracker = createInMemoryA2aTaskTracker({ now: () => clock })
    const { handle: meshi, getTaskCalls: meshiCalls } = createStubRemoteAgent({
      card: cardFor({ name: 'meshi' }),
      sendResult: async () => submittedTask('task-a', 'ctx-a'),
      getTaskResult: async (taskId) => completedTask(taskId, 'ctx-a', 'A done'),
    })
    const { handle: tRader, getTaskCalls: tRaderCalls } = createStubRemoteAgent(
      {
        card: cardFor({ name: 't-rader' }),
        sendResult: async () => submittedTask('task-b', 'ctx-b'),
        getTaskResult: async (taskId) =>
          completedTask(taskId, 'ctx-b', 'B done'),
      },
    )
    const meshiTool = createDelegationTool(meshi, {
      a2aTaskTracker: tracker,
      now: () => clock,
      taskDeadlineMs: 15 * 60 * 1000,
    })
    const tRaderTool = createDelegationTool(tRader, {
      a2aTaskTracker: tracker,
      now: () => clock,
      taskDeadlineMs: 15 * 60 * 1000,
    })

    // Simulates the conversation agent issuing two delegate_to_* tool calls
    // as parallel tool calls from the same turn/event.
    const [meshiMessage, tRaderMessage] = await Promise.all([
      invokeDelegationTool(meshiTool, { request: 'log my lunch' }),
      invokeDelegationTool(tRaderTool, { request: 'log my run' }),
    ])

    expect(meshiMessage.artifact).toEqual({
      agentName: 'meshi',
      taskId: 'task-a',
      contextId: 'ctx-a',
    })
    expect(tRaderMessage.artifact).toEqual({
      agentName: 't-rader',
      taskId: 'task-b',
      contextId: 'ctx-b',
    })

    // Advance the clock to when the push notifications arrive, so a settle
    // that failed to bump updatedAt would be caught by the assertions below.
    clock = new Date(delegatedAt.getTime() + 5 * 60 * 1000)

    const remoteAgentRegistry = createFakeRemoteAgentRegistry([meshi, tRader])
    const eventLogStore = createScriptedEventLogStore()
    const slackClient = createStubSlackClient()
    const finalizer = createResponseFinalizer({
      a2aTaskTracker: tracker,
      remoteAgentRegistry,
      eventLogStore,
      slackClient,
    })
    const app = buildApp(finalizer)

    const responseA = await postNotification(app, 'task-a')
    const responseB = await postNotification(app, 'task-b')

    expect(responseA.status).toBe(204)
    expect(responseB.status).toBe(204)
    expect(meshiCalls).toEqual(['task-a'])
    expect(tRaderCalls).toEqual(['task-b'])
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
    // markResponded only actually flips once (the second settle races an
    // already-responded event_log row), yet both tasks still posted.
    expect(eventLogStore.markedResponded).toEqual(['Ev1'])
    expect(await tracker.findByTaskId('task-a')).toEqual({
      taskId: 'task-a',
      contextId: 'ctx-a',
      agentName: 'meshi',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      threadRootTs: '111.222',
      slackEventId: 'Ev1',
      state: 'completed',
      settled: true,
      deadlineAt: new Date('2026-01-01T00:15:00Z'),
      createdAt: delegatedAt,
      updatedAt: clock,
    })
    expect(await tracker.findByTaskId('task-b')).toEqual({
      taskId: 'task-b',
      contextId: 'ctx-b',
      agentName: 't-rader',
      slackTeamId: 'T1',
      slackChannelId: 'C1',
      threadRootTs: '111.222',
      slackEventId: 'Ev1',
      state: 'completed',
      settled: true,
      deadlineAt: new Date('2026-01-01T00:15:00Z'),
      createdAt: delegatedAt,
      updatedAt: clock,
    })
  })
})
