import type { ApplyResult } from '@fohte/blog-publisher-contract'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'

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

export const handleApplyButton = (
  input: HandleApplyButtonInput,
): ResultAsync<void, unknown> => {
  const { ctx, action, client } = input
  ctx.ack()

  if (action.value === undefined) {
    return ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: Apply ボタンの value が空です。再度 /blog-post を実行してください。',
    })
  }

  const decoded = decodeDocIds(action.value)
  if (decoded.isErr()) {
    return ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: Apply ボタンの状態が不正です。再度 /blog-post を実行してください。',
    })
  }
  const docIds = decoded.value

  const updater = ctx.originalUpdater()
  const applying = renderApplyingBlocks()

  return updater
    .patch({ text: applying.text, blocks: applying.blocks })
    .andThen(() =>
      ResultAsync.fromPromise(
        client.apply(docIds),
        (caughtErr) => caughtErr,
      ).orElse((caughtErr) =>
        patchError(updater, caughtErr).andThen(() => errAsync(caughtErr)),
      ),
    )
    .andThen((result) => handleApplyResult(input, updater, result))
}

const handleApplyResult = (
  input: HandleApplyButtonInput,
  updater: MessageUpdater,
  result: ApplyResult,
): ResultAsync<void, unknown> => {
  const { ctx } = input
  switch (result.kind) {
    case 'success': {
      const rendered = renderAppliedBlocks({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        branch: result.branch,
      })
      return updater
        .patch({ text: rendered.text, blocks: rendered.blocks })
        .andThen(() => {
          if (input.onSuccess === undefined) return okAsync(undefined)
          return ResultAsync.fromSafePromise(
            Promise.resolve(
              input.onSuccess({
                ctx,
                prNumber: result.prNumber,
                prUrl: result.prUrl,
                branch: result.branch,
              }),
            ),
          )
        })
    }
    case 'planChanged': {
      const rendered = renderPlanBlocks({ plan: result.newPlan })
      return updater.patch({
        text: `:warning: Plan が変わりました — ${rendered.text}`,
        blocks: rendered.blocks,
      })
    }
    case 'alreadyApplied': {
      const rendered = renderAlreadyAppliedBlocks({
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      })
      return updater.patch({ text: rendered.text, blocks: rendered.blocks })
    }
    case 'failed': {
      const text = `:x: ${translateApplyFailure(result)}`
      return updater.patch({
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      })
    }
  }
}

// Ignores a secondary patch failure here: the primary error (the reason
// this is being called) still propagates to the caller either way.
const patchError = (
  updater: MessageUpdater,
  err: unknown,
): ResultAsync<void, never> => {
  const text = `:x: ${translateException(err)}`
  return updater
    .patch({
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    })
    .orElse(() => okAsync(undefined))
}
