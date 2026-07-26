import type { InteractionContext } from '#interaction/context'
import type { MessageUpdater } from '#interaction/message-updater'
import {
  translateApplyFailure,
  translateException,
} from '#plugins/blog/error-translator'
import {
  decodeDocIds,
  renderAlreadyAppliedBlocks,
  renderAppliedBlocks,
  renderApplyingBlocks,
  renderPlanBlocks,
} from '#plugins/blog/plan-presenter'
import type { BlogServiceClient } from '#plugins/blog/service-client'
import type {
  BlockActionPayloadAction,
  BlockActionsPayload,
} from '#types/slack-payloads'

export interface HandleApplyButtonInput {
  readonly ctx: InteractionContext
  readonly payload: BlockActionsPayload
  readonly action: BlockActionPayloadAction
  readonly client: BlogServiceClient
  readonly onSuccess?: (input: ApplySuccessInput) => void | Promise<void>
}

export interface ApplySuccessInput {
  readonly ctx: InteractionContext
  readonly prNumber: number
  readonly prUrl: string
  readonly branch: string
}

export const handleApplyButton = async (
  input: HandleApplyButtonInput,
): Promise<void> => {
  const { ctx, action, client } = input
  ctx.ack()

  if (action.value === undefined) {
    const followUpResult = await ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: Apply ボタンの value が空です。再度 /blog-post を実行してください。',
    })
    if (followUpResult.isErr()) throw followUpResult.error
    return
  }

  const decoded = decodeDocIds(action.value)
  if (decoded.isErr()) {
    const followUpResult = await ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: Apply ボタンの状態が不正です。再度 /blog-post を実行してください。',
    })
    if (followUpResult.isErr()) throw followUpResult.error
    return
  }
  const docIds = decoded.value

  const updater = ctx.originalUpdater()
  const applying = renderApplyingBlocks()
  const applyingPatchResult = await updater.patch({
    text: applying.text,
    blocks: applying.blocks,
  })
  if (applyingPatchResult.isErr()) throw applyingPatchResult.error

  let result
  try {
    result = await client.apply(docIds)
  } catch (err) {
    await patchError(updater, err)
    throw err
  }
  switch (result.kind) {
    case 'success': {
      const rendered = renderAppliedBlocks({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        branch: result.branch,
      })
      const patchResult = await updater.patch({
        text: rendered.text,
        blocks: rendered.blocks,
      })
      if (patchResult.isErr()) throw patchResult.error
      if (input.onSuccess !== undefined) {
        await input.onSuccess({
          ctx,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          branch: result.branch,
        })
      }
      return
    }
    case 'planChanged': {
      const rendered = renderPlanBlocks({ plan: result.newPlan })
      const patchResult = await updater.patch({
        text: `:warning: Plan が変わりました — ${rendered.text}`,
        blocks: rendered.blocks,
      })
      if (patchResult.isErr()) throw patchResult.error
      return
    }
    case 'alreadyApplied': {
      const rendered = renderAlreadyAppliedBlocks({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      })
      const patchResult = await updater.patch({
        text: rendered.text,
        blocks: rendered.blocks,
      })
      if (patchResult.isErr()) throw patchResult.error
      return
    }
    case 'failed': {
      const text = `:x: ${translateApplyFailure(result)}`
      const patchResult = await updater.patch({
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      })
      if (patchResult.isErr()) throw patchResult.error
      return
    }
  }
}

const patchError = async (
  updater: MessageUpdater,
  err: unknown,
): Promise<void> => {
  const text = `:x: ${translateException(err)}`
  const patchResult = await updater.patch({
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  })
  if (patchResult.isErr()) {
    // ignore secondary patch failure; primary error still propagates
  }
}
