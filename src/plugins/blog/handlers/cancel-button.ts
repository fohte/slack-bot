import type { InteractionContext } from '@/interaction/context'
import { renderCancelledBlocks } from '@/plugins/blog/plan-presenter'
import type {
  BlockActionPayloadAction,
  BlockActionsPayload,
} from '@/types/slack-payloads'

export interface HandleCancelButtonInput {
  readonly ctx: InteractionContext
  readonly payload: BlockActionsPayload
  readonly action: BlockActionPayloadAction
}

export const handleCancelButton = async (
  input: HandleCancelButtonInput,
): Promise<void> => {
  const { ctx } = input
  ctx.ack()
  const rendered = renderCancelledBlocks()
  await ctx.originalUpdater().patch({
    text: rendered.text,
    blocks: rendered.blocks,
  })
}
