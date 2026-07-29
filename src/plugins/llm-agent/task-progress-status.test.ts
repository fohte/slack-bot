import type { Message, Task } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'

import { createStubSlackClient } from '#plugins/llm-agent/_test-utils'
import type { A2aTaskRow } from '#plugins/llm-agent/a2a-task-tracker'
import { createTaskProgressStatus } from '#plugins/llm-agent/task-progress-status'
import type { SlackWebClient } from '#slack/web-client'

const baseRow = (override: Partial<A2aTaskRow> = {}): A2aTaskRow => ({
  taskId: 'task-1',
  contextId: 'ctx-1',
  agentName: 'meshi',
  slackTeamId: 'T1',
  slackChannelId: 'C1',
  threadRootTs: '111.222',
  slackEventId: 'Ev1',
  state: 'working',
  settled: false,
  deadlineAt: new Date('2026-01-01T00:15:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...override,
})

const textMessage = (text: string): Message => ({
  kind: 'message',
  messageId: 'm1',
  role: 'agent',
  parts: [{ kind: 'text', text }],
})

const taskWith = (message?: Message): Task => ({
  kind: 'task',
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: 'working', ...(message !== undefined ? { message } : {}) },
})

describe('createTaskProgressStatus', () => {
  describe('report', () => {
    it('reflects the task message into loading_messages, keeping status as the thinking indicator', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })

      await progressStatus.report(
        baseRow(),
        taskWith(textMessage('Looking up the food in the food database...')),
      )

      expect(slackClient.calls).toEqual([
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Looking up the food in the food database...'],
        },
      ])
    })

    it('does nothing when the task carries no message yet', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })

      await progressStatus.report(baseRow(), taskWith())

      expect(slackClient.calls).toEqual([])
    })

    it('does not repeat the same text for the same task', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })
      const task = taskWith(textMessage('Recording your meal...'))

      await progressStatus.report(baseRow(), task)
      await progressStatus.report(baseRow(), task)

      expect(slackClient.calls).toEqual([
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Recording your meal...'],
        },
      ])
    })

    it('reports again when the text changes for the same task', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })

      await progressStatus.report(
        baseRow(),
        taskWith(textMessage('Searching the web for food information...')),
      )
      await progressStatus.report(
        baseRow(),
        taskWith(textMessage('Registering a new food entry...')),
      )

      expect(slackClient.calls).toEqual([
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Searching the web for food information...'],
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Registering a new food entry...'],
        },
      ])
    })

    it('reports the same text again for a different taskId', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })
      const text = textMessage('Reading your profile...')

      await progressStatus.report(baseRow({ taskId: 'task-a' }), {
        ...taskWith(text),
        id: 'task-a',
      })
      await progressStatus.report(baseRow({ taskId: 'task-b' }), {
        ...taskWith(text),
        id: 'task-b',
      })

      expect(slackClient.calls).toEqual([
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Reading your profile...'],
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Reading your profile...'],
        },
      ])
    })

    it('does not cache the text after a failed send, so a retry sends it again', async () => {
      let shouldFail = true
      const baseSlackClient = createStubSlackClient()
      const flakySlackClient: SlackWebClient = {
        ...baseSlackClient,
        async setAssistantThreadStatus(arg) {
          if (shouldFail) {
            shouldFail = false
            throw new Error('rate_limited')
          }
          return baseSlackClient.setAssistantThreadStatus(arg)
        },
      }
      const progressStatus = createTaskProgressStatus({
        slackClient: flakySlackClient,
      })
      const task = taskWith(textMessage('Recording your meal...'))

      await progressStatus.report(baseRow(), task)
      await progressStatus.report(baseRow(), task)

      // Only the second (successful) call reaches baseSlackClient: had the
      // first (failed) call cached the text anyway, this second identical
      // call would have been skipped as a duplicate and never sent at all.
      expect(baseSlackClient.calls).toEqual([
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Recording your meal...'],
        },
      ])
    })
  })

  describe('clear', () => {
    it('clears the indicator', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })

      await progressStatus.clear(baseRow())

      expect(slackClient.calls).toEqual([
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

    it('forgets the cached text, so a later report re-sends the same text', async () => {
      const slackClient = createStubSlackClient()
      const progressStatus = createTaskProgressStatus({ slackClient })
      const task = taskWith(textMessage('Updating your profile...'))

      await progressStatus.report(baseRow(), task)
      await progressStatus.clear(baseRow())
      await progressStatus.report(baseRow(), task)

      expect(slackClient.calls).toEqual([
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Updating your profile...'],
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: '',
          blocks: undefined,
          loadingMessages: undefined,
        },
        {
          kind: 'status',
          channel: 'C1',
          thread: '111.222',
          text: 'is thinking...',
          blocks: undefined,
          loadingMessages: ['Updating your profile...'],
        },
      ])
    })
  })
})
