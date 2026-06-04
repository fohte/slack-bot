import { describe, expect, it } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { lastBody, makeSlack } from '@/plugins/blog/_test-utils'
import { handleCancelButton } from '@/plugins/blog/handlers/cancel-button'
import type {
  BlockActionPayloadAction,
  BlockActionsPayload,
} from '@/types/slack-payloads'

describe('CancelButtonHandler', () => {
  it('patches dismissal message', async () => {
    const slack = makeSlack()
    const action: BlockActionPayloadAction = { action_id: 'blog:cancel' }
    const payload: BlockActionsPayload = {
      type: 'block_actions',
      actions: [action],
      response_url: 'https://hooks.example/x',
    }
    const result = createInteractionContext({
      source: { kind: 'block_actions', payload },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleCancelButton({ ctx: result.ctx, payload, action })
    expect(lastBody(slack.postToResponseUrl).text).toContain('破棄')
  })
})
