import type { AgentCard, Message, MessageSendParams, Task } from '@a2a-js/sdk'
import type { Client } from '@a2a-js/sdk/client'
import { ToolMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'

import type {
  A2aTaskTracker,
  NewA2aTask,
  ThreadKey,
} from '@/plugins/llm-agent/a2a-task-tracker'
import type { Delegation } from '@/plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
import {
  createDelegationTool,
  createDelegationTools,
  delegationToolDescription,
  delegationToolName,
} from '@/plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
import type { RemoteAgentHandle } from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'

const THREAD_KEY: ThreadKey = {
  slackTeamId: 'T1',
  slackChannelId: 'C1',
  threadRootTs: '100.000',
}

const RUNTIME_CONTEXT = {
  slackEventId: 'Ev1',
  threadKey: THREAD_KEY,
  images: [] as ReadonlyArray<{ base64: string; mimeType: string }>,
}

const cardFor = (overrides: Partial<AgentCard> = {}): AgentCard => ({
  protocolVersion: '0.3.0',
  name: 'meshi',
  description: 'Tracks meals and food logs.',
  url: 'https://meshi.example.com',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    { id: 'log', name: 'Log a meal', description: 'Records a meal.', tags: [] },
  ],
  ...overrides,
})

// Wraps a canned sendMessage response with a call recorder, so tests assert
// on the params the tool actually sent instead of asserting from inside the
// stub (which would pass vacuously if the tool never called sendMessage).
const recordingHandleFor = (
  respond: (params: MessageSendParams) => Promise<Message | Task>,
  card: AgentCard = cardFor(),
): {
  readonly handle: RemoteAgentHandle
  readonly calls: MessageSendParams[]
} => {
  const calls: MessageSendParams[] = []
  const sendMessage = async (params: MessageSendParams) => {
    calls.push(params)
    return respond(params)
  }
  return {
    handle: {
      name: card.name,
      card,
      client: { sendMessage } as unknown as Client,
    },
    calls,
  }
}

const createFakeTracker = (
  contextId?: string,
): A2aTaskTracker & { readonly recorded: NewA2aTask[] } => {
  const recorded: NewA2aTask[] = []
  return {
    recorded,
    async recordDelegated(rec) {
      recorded.push(rec)
    },
    async findActiveInputRequired() {
      return undefined
    },
    async findUnsettled() {
      return []
    },
    async transition() {
      return { updated: false }
    },
    async lookupContext() {
      return contextId
    },
  }
}

const submittedTask = (overrides: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: 'submitted' },
  ...overrides,
})

// Invokes a delegation tool the way LangGraph's tool-calling node does: a
// ToolCall-shaped arg (so the framework returns a ToolMessage carrying both
// content and artifact) plus the runtime context this module threads
// per-turn Slack data through.
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

describe('delegationToolName / delegationToolDescription', () => {
  it('builds a slugified tool name and a description from the Agent Card', () => {
    const card = cardFor({ name: 'meshi', description: 'Tracks meals.' })

    expect(delegationToolName(card)).toBe('delegate_to_meshi')
    expect(delegationToolDescription(card)).toBe(
      'Delegate a task to the "meshi" agent. Tracks meals.\n' +
        'Skills:\n' +
        '- Log a meal: Records a meal.',
    )
  })
})

describe('createDelegationTool', () => {
  it('names and describes the tool from the Agent Card', () => {
    const card = cardFor({ name: 'meshi' })
    const { handle } = recordingHandleFor(async () => submittedTask(), card)
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: createFakeTracker(),
    })

    expect(toolInstance.name).toBe('delegate_to_meshi')
    expect(toolInstance.description).toBe(delegationToolDescription(card))
  })

  it('sends a message/send request with blocking:false and no contextId for a first delegation', async () => {
    const { handle, calls } = recordingHandleFor(async () => submittedTask())
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: createFakeTracker(),
      randomUUID: () => 'generated-id',
    })

    await invokeDelegationTool(toolInstance, { request: 'log my lunch' })

    expect(calls).toEqual([
      {
        message: {
          kind: 'message',
          messageId: 'generated-id',
          role: 'user',
          parts: [{ kind: 'text', text: 'log my lunch' }],
        },
        configuration: { blocking: false },
      },
    ])
  })

  it('records the delegated task immediately after a successful send and returns taskId/contextId', async () => {
    const tracker = createFakeTracker()
    const { handle } = recordingHandleFor(async () =>
      submittedTask({ id: 'task-1', contextId: 'ctx-1' }),
    )
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: tracker,
      now: () => new Date('2026-01-01T00:00:00Z'),
      taskDeadlineMs: 60_000,
    })

    const message = await invokeDelegationTool(toolInstance, {
      request: 'log my lunch',
    })

    expect(tracker.recorded).toEqual([
      {
        ...THREAD_KEY,
        taskId: 'task-1',
        contextId: 'ctx-1',
        agentName: 'meshi',
        slackEventId: 'Ev1',
        state: 'submitted',
        deadlineAt: new Date('2026-01-01T00:01:00Z'),
      },
    ])
    expect(message.content).toBe(
      'Delegated to meshi (taskId=task-1). The task runs asynchronously; ' +
        "tell the user their request was handed off and they'll get a " +
        'follow-up when it completes.',
    )
    expect(message.artifact).toEqual({
      agentName: 'meshi',
      taskId: 'task-1',
      contextId: 'ctx-1',
    } satisfies Delegation)
  })

  it('reuses an existing contextId for the same thread/agent instead of starting a new one', async () => {
    const { handle, calls } = recordingHandleFor(async () => submittedTask())
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: createFakeTracker('ctx-existing'),
    })

    await invokeDelegationTool(toolInstance, { request: 'log my lunch' })

    expect(calls[0]?.message.contextId).toBe('ctx-existing')
  })

  it('forwards attached images as A2A FileParts', async () => {
    const { handle, calls } = recordingHandleFor(async () => submittedTask())
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: createFakeTracker(),
    })

    await invokeDelegationTool(
      toolInstance,
      { request: 'what is this?' },
      {
        ...RUNTIME_CONTEXT,
        images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
      },
    )

    expect(calls[0]?.message.parts).toEqual([
      { kind: 'text', text: 'what is this?' },
      { kind: 'file', file: { bytes: 'AAAA', mimeType: 'image/jpeg' } },
    ])
  })

  it('includes the configured push notification config when sending', async () => {
    const { handle, calls } = recordingHandleFor(async () => submittedTask())
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: createFakeTracker(),
      pushNotificationConfig: {
        url: 'https://slack-bot.example.com/api/a2a/notifications',
        token: 'shared-token',
      },
    })

    await invokeDelegationTool(toolInstance, { request: 'log my lunch' })

    expect(calls[0]?.configuration?.pushNotificationConfig).toEqual({
      url: 'https://slack-bot.example.com/api/a2a/notifications',
      token: 'shared-token',
    })
  })

  it('maps a message/send failure to a tool error without recording a task', async () => {
    const tracker = createFakeTracker()
    const { handle } = recordingHandleFor(async () => {
      throw new Error('connection refused')
    })
    const toolInstance = createDelegationTool(handle, {
      a2aTaskTracker: tracker,
    })

    const message = await invokeDelegationTool(toolInstance, {
      request: 'log my lunch',
    })

    expect(message.content).toBe(
      'Delegating to meshi failed: connection refused. Tell the user the ' +
        'request could not be sent.',
    )
    expect(message.artifact).toBeUndefined()
    expect(tracker.recorded).toEqual([])
  })

  it.each<{ scenario: string; result: Message | Task }>([
    {
      scenario: 'a non-task message/send result',
      result: {
        kind: 'message',
        messageId: 'reply-1',
        role: 'agent',
        parts: [{ kind: 'text', text: 'done, no task needed' }],
      },
    },
    {
      // Simulates a remote agent whose response doesn't match the A2A Task
      // shape this module relies on (e.g. missing `status`).
      scenario: 'a malformed task result (missing status)',
      result: {
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
      } as unknown as Task,
    },
  ])(
    'maps $scenario to a tool error without recording a task',
    async ({ result }) => {
      const tracker = createFakeTracker()
      const { handle } = recordingHandleFor(async () => result)
      const toolInstance = createDelegationTool(handle, {
        a2aTaskTracker: tracker,
      })

      const message = await invokeDelegationTool(toolInstance, {
        request: 'log my lunch',
      })

      expect(message.artifact).toBeUndefined()
      expect(tracker.recorded).toEqual([])
    },
  )
})

describe('createDelegationTools', () => {
  it('generates one tool per remote agent handle, so adding a handle adds a tool with no other change', () => {
    const { handle: meshi } = recordingHandleFor(
      async () => submittedTask(),
      cardFor({ name: 'meshi' }),
    )
    const { handle: tRader } = recordingHandleFor(
      async () => submittedTask(),
      cardFor({ name: 't-rader' }),
    )

    const tools = createDelegationTools([meshi, tRader], {
      a2aTaskTracker: createFakeTracker(),
    })

    expect(tools.map((t) => t.name)).toEqual([
      'delegate_to_meshi',
      'delegate_to_t_rader',
    ])
  })

  it('rejects a duplicate delegation tool name instead of leaving a handle unreachable', () => {
    const { handle: first } = recordingHandleFor(
      async () => submittedTask(),
      cardFor({ name: 'meshi' }),
    )
    const { handle: second } = recordingHandleFor(
      async () => submittedTask(),
      cardFor({ name: 'Meshi' }),
    )

    expect(() =>
      createDelegationTools([first, second], {
        a2aTaskTracker: createFakeTracker(),
      }),
    ).toThrow(/duplicate delegation tool name/)
  })
})
