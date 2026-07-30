import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ContentBlock } from '@langchain/core/messages'
import { HumanMessage } from '@langchain/core/messages'
import { okAsync, ResultAsync } from 'neverthrow'

import type { ImageBlock } from '#plugins/llm-agent/conversation-agent/image-block'
import { stripThinkBlocks } from '#plugins/llm-agent/conversation-agent/strip-think-blocks'
import { ImageAnalysisError } from '#types/errors'

const IMAGE_ANALYSIS_INSTRUCTION =
  'Describe each of the following images faithfully and in detail, in the ' +
  'same order given, each starting with its own "[画像 N]" label (1-' +
  'indexed). Transcribe any visible text exactly as written, preserving its ' +
  'original language and script. If part of an image is unclear, cut off, ' +
  'or illegible, say so explicitly instead of guessing — never invent text, ' +
  'names, or brands that are not clearly visible.'

const toImageContentBlock = (
  image: ImageBlock,
): ContentBlock.Multimodal.Image => ({
  type: 'image',
  mimeType: image.mimeType,
  data: image.base64,
})

// Converts Slack image attachments into text once, through a vision-
// specialized model, so neither the conversation agent's own model nor any
// delegate agent ever has to read raw image bytes directly. Returns
// undefined when there is nothing to describe (no images, or the model
// produced no usable text).
export const describeImages = (
  model: BaseChatModel,
  images: readonly ImageBlock[],
): ResultAsync<string | undefined, ImageAnalysisError> => {
  if (images.length === 0) return okAsync(undefined)

  const message = new HumanMessage({
    contentBlocks: [
      { type: 'text', text: IMAGE_ANALYSIS_INSTRUCTION },
      ...images.map(toImageContentBlock),
    ],
  })
  return ResultAsync.fromPromise(
    model.invoke([message]),
    (caughtErr) =>
      new ImageAnalysisError('vision model image analysis failed', caughtErr),
  ).map((result) => {
    const { text } = stripThinkBlocks(result.text)
    return text.length > 0 ? text : undefined
  })
}
