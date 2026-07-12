import { describe, expect, it } from 'vitest'

import { deriveConversationThreadId } from '@/plugins/llm-agent/conversation-agent/thread-id'

describe('deriveConversationThreadId', () => {
  it('joins team, channel, and thread root ts with colons', () => {
    expect(
      deriveConversationThreadId({
        teamId: 'T1',
        channelId: 'C1',
        threadRootTs: '111.222',
      }),
    ).toBe('T1:C1:111.222')
  })

  it('is deterministic for the same key', () => {
    const key = { teamId: 'T1', channelId: 'C2', threadRootTs: '333.444' }
    expect(deriveConversationThreadId(key)).toBe(
      deriveConversationThreadId({ ...key }),
    )
  })

  it('differs when any single field differs', () => {
    const base = { teamId: 'T1', channelId: 'C1', threadRootTs: '111.222' }
    const baseId = deriveConversationThreadId(base)
    expect(deriveConversationThreadId({ ...base, teamId: 'T2' })).not.toBe(
      baseId,
    )
    expect(deriveConversationThreadId({ ...base, channelId: 'C2' })).not.toBe(
      baseId,
    )
    expect(
      deriveConversationThreadId({ ...base, threadRootTs: '999.888' }),
    ).not.toBe(baseId)
  })
})
