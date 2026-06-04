import type { Plan } from '@fohte/blog-publisher-contract'
import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { lastBody, makeSlack } from '@/plugins/blog/_test-utils'
import { handleSelectSubmit } from '@/plugins/blog/handlers/select-submit'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type { BlockActionsPayload } from '@/types/slack-payloads'

const samplePlan = (errors: Plan['errors'] = []): Plan => ({
  signature: 'sig',
  items: [
    {
      docId: 'note:a',
      kind: 'added',
      slug: 'a',
      publishedFilename: 'a.mdx',
      title: 'A',
      summary: 's',
    },
  ],
  warnings: [],
  errors,
  imagesToUpload: [],
})

describe('SelectSubmitHandler', () => {
  it('calls buildPlan with selected docIds and patches original message', async () => {
    const buildPlan = vi.fn(async () => samplePlan())
    const client = { buildPlan } as unknown as BlogServiceClient
    const slack = makeSlack({ channelId: 'C', messageTs: 'T', raw: 'ok' })
    const payload: BlockActionsPayload = {
      type: 'block_actions',
      actions: [
        {
          action_id: 'blog:select-options',
          selected_options: [{ value: 'note:a' }, { value: 'note:b' }],
        },
        { action_id: 'blog:select-submit' },
      ],
      response_url: 'https://hooks.example/x',
    }
    const result = createInteractionContext({
      source: { kind: 'block_actions', payload },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleSelectSubmit({
      ctx: result.ctx,
      payload,
      action: payload.actions[1]!,
      client,
    })
    expect(buildPlan).toHaveBeenCalledWith(['note:a', 'note:b'])
    const body = lastBody(slack.postToResponseUrl)
    expect(body['replace_original']).toBe(true)
  })

  it('warns when no notes selected', async () => {
    const buildPlan = vi.fn(async () => samplePlan())
    const client = { buildPlan } as unknown as BlogServiceClient
    const slack = makeSlack()
    const payload: BlockActionsPayload = {
      type: 'block_actions',
      actions: [
        { action_id: 'blog:select-options', selected_options: [] },
        { action_id: 'blog:select-submit' },
      ],
      response_url: 'https://hooks.example/x',
    }
    const result = createInteractionContext({
      source: { kind: 'block_actions', payload },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handleSelectSubmit({
      ctx: result.ctx,
      payload,
      action: payload.actions[1]!,
      client,
    })
    expect(buildPlan).not.toHaveBeenCalled()
    const body = lastBody(slack.postToResponseUrl)
    expect(body.text).toContain('選択されていません')
  })
})
