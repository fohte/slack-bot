import { describe, expect, it } from 'vitest'

import {
  buildTaskCrManifest,
  parseTaskCrItem,
} from '@/plugins/llm-agent/task-cr-client'

describe('parseTaskCrItem', () => {
  it('extracts name, phase, and message from a Task CR list item', () => {
    const item = {
      metadata: { name: 'slack-abc', namespace: 'kubeopencode' },
      status: {
        phase: 'Completed',
        message: 'done',
        session: { id: 'ses_42' },
      },
    }
    expect(parseTaskCrItem(item, 'fallback-ns')).toEqual({
      name: 'slack-abc',
      namespace: 'kubeopencode',
      phase: 'Completed',
      message: 'done',
    })
  })

  it('falls back to the provided namespace when metadata omits it', () => {
    const item = { metadata: { name: 'slack-x' } }
    expect(parseTaskCrItem(item, 'fallback-ns')).toEqual({
      name: 'slack-x',
      namespace: 'fallback-ns',
      phase: undefined,
      message: undefined,
    })
  })

  it('returns undefined when name is missing', () => {
    expect(parseTaskCrItem({ metadata: {} }, 'ns')).toBeUndefined()
    expect(parseTaskCrItem(null, 'ns')).toBeUndefined()
    expect(parseTaskCrItem('not-an-object', 'ns')).toBeUndefined()
  })
})

describe('buildTaskCrManifest', () => {
  it('renders text and configMap contexts side by side', () => {
    expect(
      buildTaskCrManifest({
        name: 'slack-abc',
        namespace: 'kubeopencode',
        agentName: 'slack-bot',
        description: 'go',
        contexts: [
          {
            kind: 'text',
            name: 'slack-channel',
            mountPath: 'slack-context/channel',
            text: 'C1',
          },
          {
            kind: 'configMap',
            name: 'slack-images',
            mountPath: 'slack-images',
            configMapName: 'slack-abc-images',
          },
        ],
      }),
    ).toEqual({
      apiVersion: 'kubeopencode.io/v1alpha1',
      kind: 'Task',
      metadata: { name: 'slack-abc', namespace: 'kubeopencode' },
      spec: {
        agentRef: { name: 'slack-bot' },
        description: 'go',
        contexts: [
          {
            name: 'slack-channel',
            type: 'Text',
            mountPath: 'slack-context/channel',
            text: 'C1',
          },
          {
            name: 'slack-images',
            type: 'ConfigMap',
            mountPath: 'slack-images',
            configMap: { name: 'slack-abc-images' },
          },
        ],
      },
    })
  })
})
