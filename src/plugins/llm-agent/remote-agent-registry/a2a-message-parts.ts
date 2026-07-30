import type { Part, TextPart } from '@a2a-js/sdk'

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
