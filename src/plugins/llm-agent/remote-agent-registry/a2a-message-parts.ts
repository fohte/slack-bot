import type { ImageBlock } from '@/plugins/llm-agent/conversation-agent/image-block'

// Converts a resolved Slack image into an A2A message FilePart. Shared
// between fresh delegations (DelegationToolFactory) and task-resume
// message/send calls (steps/resume-active-task.ts).
export const toFilePart = (image: ImageBlock) => ({
  kind: 'file' as const,
  file: { bytes: image.base64, mimeType: image.mimeType },
})
