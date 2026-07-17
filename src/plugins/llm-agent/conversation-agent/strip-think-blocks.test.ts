import { describe, expect, it } from 'vitest'

import { stripThinkBlocks } from '@/plugins/llm-agent/conversation-agent/strip-think-blocks'

describe('stripThinkBlocks', () => {
  it('removes a leading think block and the whitespace around it', () => {
    expect(
      stripThinkBlocks('<think>\nreasoning here\n</think>\nthe answer'),
    ).toBe('the answer')
  })

  it('removes multiple think blocks', () => {
    expect(
      stripThinkBlocks('<think>first</think>before<think>second</think>after'),
    ).toBe('beforeafter')
  })

  it('leaves text with no think block unchanged', () => {
    expect(stripThinkBlocks('just the answer')).toBe('just the answer')
  })

  it('returns an empty string when the whole text is a think block', () => {
    expect(stripThinkBlocks('<think>only reasoning</think>')).toBe('')
  })

  it('matches think tags case-insensitively', () => {
    expect(stripThinkBlocks('<THINK>reasoning</THINK>the answer')).toBe(
      'the answer',
    )
  })
})
