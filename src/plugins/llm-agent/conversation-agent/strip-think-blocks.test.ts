import { describe, expect, it } from 'vitest'

import { stripThinkBlocks } from '@/plugins/llm-agent/conversation-agent/strip-think-blocks'

describe('stripThinkBlocks', () => {
  it('removes a leading think block and the whitespace around it', () => {
    expect(
      stripThinkBlocks('<think>\nreasoning here\n</think>\nthe answer'),
    ).toEqual({ text: 'the answer', stripped: true })
  })

  it('removes multiple think blocks', () => {
    expect(
      stripThinkBlocks('<think>first</think>before<think>second</think>after'),
    ).toEqual({ text: 'beforeafter', stripped: true })
  })

  it('leaves text with no think block unchanged', () => {
    expect(stripThinkBlocks('just the answer')).toEqual({
      text: 'just the answer',
      stripped: false,
    })
  })

  it('returns an empty string when the whole text is a think block', () => {
    expect(stripThinkBlocks('<think>only reasoning</think>')).toEqual({
      text: '',
      stripped: true,
    })
  })

  it('matches think tags case-insensitively', () => {
    expect(stripThinkBlocks('<THINK>reasoning</THINK>the answer')).toEqual({
      text: 'the answer',
      stripped: true,
    })
  })

  it('strips an unclosed think block through to the end of the text', () => {
    expect(stripThinkBlocks('<think>\nreasoning cut off mid-thought')).toEqual({
      text: '',
      stripped: true,
    })
  })

  it('preserves text preceding an unclosed think block', () => {
    expect(stripThinkBlocks('before<think>reasoning cut off')).toEqual({
      text: 'before',
      stripped: true,
    })
  })
})
