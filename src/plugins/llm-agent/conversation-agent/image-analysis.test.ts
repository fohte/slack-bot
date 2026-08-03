import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRecordingChatModel } from '#plugins/llm-agent/conversation-agent/_test-utils'
import { describeImages } from '#plugins/llm-agent/conversation-agent/image-analysis'
import { ImageAnalysisError } from '#types/errors'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

const IMAGE_ANALYSIS_FINGERPRINT = 'llm-agent.image-analysis.describe-failed'

describe('describeImages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined without calling the model when there are no images', async () => {
    const model = createRecordingChatModel(() => 'should never be called')

    const result = await describeImages(model, [])

    expect(result.isOk() && result.value).toBe(undefined)
    expect(model.calls).toEqual([])
  })

  it('sends the images as content blocks alongside an instruction and returns the model reply', async () => {
    const model = createRecordingChatModel(
      () => '[画像 1] a photo of a cat\n[画像 2] a photo of a dog',
    )

    const result = await describeImages(model, [
      { base64: 'AAAA', mimeType: 'image/jpeg' },
      { base64: 'BBBB', mimeType: 'image/png' },
    ])

    expect(result.isOk() && result.value).toBe(
      '[画像 1] a photo of a cat\n[画像 2] a photo of a dog',
    )
    const [humanMessage] = model.calls[0] ?? []
    expect(humanMessage?.content).toEqual([
      { type: 'text', text: expect.any(String) },
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'image', mimeType: 'image/png', data: 'BBBB' },
    ])
  })

  it('strips a <think> block from the model reply before returning it', async () => {
    const model = createRecordingChatModel(
      () => '<think>reasoning</think>[画像 1] a photo of a cat',
    )

    const result = await describeImages(model, [
      { base64: 'AAAA', mimeType: 'image/jpeg' },
    ])

    expect(result.isOk() && result.value).toBe('[画像 1] a photo of a cat')
  })

  it('returns undefined when the model reply is empty after stripping', async () => {
    const model = createRecordingChatModel(() => '<think>reasoning</think>')

    const result = await describeImages(model, [
      { base64: 'AAAA', mimeType: 'image/jpeg' },
    ])

    expect(result.isOk() && result.value).toBe(undefined)
  })

  it('wraps a model invocation failure in an ImageAnalysisError', async () => {
    const model = createRecordingChatModel(() => {
      throw new Error('upstream unavailable')
    })

    const result = await describeImages(model, [
      { base64: 'AAAA', mimeType: 'image/jpeg' },
    ])

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ImageAnalysisError)
  })

  it('reports a model invocation failure to Sentry', async () => {
    const model = createRecordingChatModel(() => {
      throw new Error('upstream unavailable')
    })

    const result = await describeImages(model, [
      { base64: 'AAAA', mimeType: 'image/jpeg' },
    ])

    const error = result._unsafeUnwrapErr()
    expect(vi.mocked(captureWithFingerprint).mock.calls).toEqual([
      [error, IMAGE_ANALYSIS_FINGERPRINT, { extras: { imageCount: 1 } }],
    ])
  })
})
