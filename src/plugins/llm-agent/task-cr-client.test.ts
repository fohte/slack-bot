import { describe, expect, it } from 'vitest'

import { parseTaskCrItem } from '@/plugins/llm-agent/task-cr-client'

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
