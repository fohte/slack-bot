import type { ApplyResult } from '@fohte/blog-publisher-contract'
import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { lastBody, makeSlack, nthBody } from '@/plugins/blog/_test-utils'
import {
  type ApplySuccessInput,
  handleApplyButton,
} from '@/plugins/blog/handlers/apply-button'
import { encodeDocIds } from '@/plugins/blog/plan-presenter'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type {
  BlockActionPayloadAction,
  BlockActionsPayload,
} from '@/types/slack-payloads'

const runHandler = async (
  applyResult: ApplyResult,
  onSuccess?: (input: ApplySuccessInput) => Promise<void> | void,
) => {
  const slack = makeSlack()
  const apply = vi.fn(async () => applyResult)
  const client = { apply } as unknown as BlogServiceClient
  const action: BlockActionPayloadAction = {
    action_id: 'blog:apply',
    value: encodeDocIds(['note:a']),
  }
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
  await handleApplyButton({
    ctx: result.ctx,
    payload,
    action,
    client,
    ...(onSuccess !== undefined ? { onSuccess } : {}),
  })
  return { slack, apply }
}

describe('ApplyButtonHandler', () => {
  it('success: patches PR URL and invokes onSuccess (CiWatcher hook)', async () => {
    const onSuccess = vi.fn()
    const { slack, apply } = await runHandler(
      {
        kind: 'success',
        prNumber: 42,
        prUrl: 'https://github.com/x/y/pull/42',
        branch: 'blog/abcd1234',
      },
      onSuccess,
    )
    expect(apply).toHaveBeenCalledWith(['note:a'])
    expect(JSON.stringify(nthBody(slack.postToResponseUrl, 0))).toContain(
      'Apply 中',
    )
    expect(JSON.stringify(lastBody(slack.postToResponseUrl))).toContain(
      'pull/42',
    )
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42 }),
    )
  })

  it('planChanged: renders new plan', async () => {
    const { slack } = await runHandler({
      kind: 'planChanged',
      newPlan: {
        signature: 'new',
        items: [],
        warnings: [],
        errors: [
          { docId: 'note:a', code: 'FrontmatterInvalid', message: 'bad' },
        ],
        imagesToUpload: [],
      },
    })
    expect(JSON.stringify(lastBody(slack.postToResponseUrl))).toContain(
      'Plan が変わりました',
    )
  })

  it('alreadyApplied: shows existing PR URL', async () => {
    const { slack } = await runHandler({
      kind: 'alreadyApplied',
      prNumber: 7,
      prUrl: 'https://github.com/x/y/pull/7',
    })
    expect(JSON.stringify(lastBody(slack.postToResponseUrl))).toContain(
      'pull/7',
    )
  })

  it('failed: translates failure code to Japanese', async () => {
    const { slack } = await runHandler({
      kind: 'failed',
      code: 'ImageUploadFailed',
      message: 'R2 down',
    })
    expect(JSON.stringify(lastBody(slack.postToResponseUrl))).toContain('画像')
  })

  it('rejects malformed button value', async () => {
    const slack = makeSlack()
    const apply = vi.fn()
    const client = { apply } as unknown as BlogServiceClient
    const action: BlockActionPayloadAction = {
      action_id: 'blog:apply',
      value: 'not-json',
    }
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
    await handleApplyButton({ ctx: result.ctx, payload, action, client })
    expect(apply).not.toHaveBeenCalled()
    expect(lastBody(slack.postToResponseUrl).text).toContain('不正')
  })
})
