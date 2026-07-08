import { describe, expect, it } from 'vitest'

import {
  extractInlineFileIds,
  isFileSharedToChannel,
  stripInlineFileIds,
} from '@/plugins/llm-agent/files'
import type { SlackFile } from '@/types/slack-payloads'

describe('extractInlineFileIds', () => {
  it('extracts a bare Slack file ID from message text', () => {
    expect(
      extractInlineFileIds('F0BG20H5AVA これ昼たべたから記録しといて'),
    ).toEqual(['F0BG20H5AVA'])
  })

  it('returns an empty array when there is no file ID reference', () => {
    expect(extractInlineFileIds('hello there')).toEqual([])
  })

  it('does not match short uppercase tokens that happen to start with F', () => {
    expect(extractInlineFileIds('FOO is not a file id')).toEqual([])
  })

  it('dedupes a repeated file ID', () => {
    expect(extractInlineFileIds('F0BG20H5AVA and again F0BG20H5AVA')).toEqual([
      'F0BG20H5AVA',
    ])
  })
})

describe('stripInlineFileIds', () => {
  it('removes a leading file ID token and its trailing whitespace', () => {
    expect(
      stripInlineFileIds('F0BG20H5AVA これ昼たべたから記録しといて', [
        'F0BG20H5AVA',
      ]),
    ).toBe('これ昼たべたから記録しといて')
  })

  it('removes a file ID token from the middle without leaving a double space', () => {
    expect(
      stripInlineFileIds('hey F0BG20H5AVA check this out', ['F0BG20H5AVA']),
    ).toBe('hey check this out')
  })

  it('returns the original text unchanged when ids is empty', () => {
    expect(stripInlineFileIds('hello', [])).toBe('hello')
  })

  it('removes every occurrence of an ID repeated in the text', () => {
    expect(
      stripInlineFileIds('F0BG20H5AVA and again F0BG20H5AVA', ['F0BG20H5AVA']),
    ).toBe('and again')
  })
})

describe('isFileSharedToChannel', () => {
  it('returns true when the channel is in the channels list', () => {
    const file: SlackFile = { id: 'F1', channels: ['C1', 'C2'] }
    expect(isFileSharedToChannel(file, 'C1')).toBe(true)
  })

  it('returns true when the channel is in the ims list', () => {
    const file: SlackFile = { id: 'F1', ims: ['D1'] }
    expect(isFileSharedToChannel(file, 'D1')).toBe(true)
  })

  it('returns false when the channel is absent from every share list', () => {
    const file: SlackFile = { id: 'F1', channels: ['C1'], groups: ['G1'] }
    expect(isFileSharedToChannel(file, 'C_OTHER')).toBe(false)
  })

  it('returns false when no share lists are present', () => {
    const file: SlackFile = { id: 'F1' }
    expect(isFileSharedToChannel(file, 'C1')).toBe(false)
  })
})
