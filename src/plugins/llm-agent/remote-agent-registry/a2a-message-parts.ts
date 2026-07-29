import type { Part, TextPart } from '@a2a-js/sdk'

import type { ImageBlock } from '#plugins/llm-agent/conversation-agent/image-block'

// Shared between fresh delegations (DelegationToolFactory) and task-resume
// message/send calls (steps/resume-active-task.ts).
export const toFilePart = (image: ImageBlock) => ({
  kind: 'file' as const,
  file: { bytes: image.base64, mimeType: image.mimeType },
})

export const isTextPart = (part: Part): part is TextPart => part.kind === 'text'

// Shared between ResponseFinalizer (settle/question text) and
// TaskProgressStatus (progress text): both read a Message's text parts the
// same way, differing only in what they fall back to when it's empty.
export const collectPartsText = (parts: readonly Part[] | undefined): string =>
  (parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join('\n')
    .trim()
