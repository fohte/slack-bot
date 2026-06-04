import type { InteractionContext } from '@/interaction/context'
import type { MessageUpdater } from '@/interaction/message-updater'
import {
  translateApplyFailure,
  translateException,
} from '@/plugins/blog/error-translator'
import {
  decodeDocIds,
  renderAlreadyAppliedBlocks,
  renderAppliedBlocks,
  renderApplyingBlocks,
  renderPlanBlocks,
} from '@/plugins/blog/plan-presenter'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type {
  BlockActionPayloadAction,
  BlockActionsPayload,
} from '@/types/slack-payloads'

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
    await ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: Apply ボタンの value が空です。再度 /blog-post を実行してください。',
    })
    return
  }

  let docIds: string[]
  try {
    docIds = decodeDocIds(action.value)
  } catch {
    await ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: Apply ボタンの状態が不正です。再度 /blog-post を実行してください。',
    })
    return
  }

  const updater = ctx.originalUpdater()
  const applying = renderApplyingBlocks()
  await updater.patch({ text: applying.text, blocks: applying.blocks })

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
      await updater.patch({ text: rendered.text, blocks: rendered.blocks })
      // CiWatcher polling hook; not implemented yet.
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
      await updater.patch({
        text: `:warning: Plan が変わりました — ${rendered.text}`,
        blocks: rendered.blocks,
      })
      return
    }
    case 'alreadyApplied': {
      const rendered = renderAlreadyAppliedBlocks({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      })
      await updater.patch({ text: rendered.text, blocks: rendered.blocks })
      return
    }
    case 'failed': {
      const text = `:x: ${translateApplyFailure(result)}`
      await updater.patch({
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      })
      return
    }
  }
}

const patchError = async (
  updater: MessageUpdater,
  err: unknown,
): Promise<void> => {
  const text = `:x: ${translateException(err)}`
  try {
    await updater.patch({
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    })
  } catch {
    // ignore secondary patch failure; primary error still propagates
  }
}
