import type { InteractionContext } from '@/interaction/context'
import { renderPlanBlocks } from '@/plugins/blog/plan-presenter'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type {
  BlockActionPayloadAction,
  BlockActionsPayload,
} from '@/types/slack-payloads'

export interface HandleSelectSubmitInput {
  readonly ctx: InteractionContext
  readonly payload: BlockActionsPayload
  readonly action: BlockActionPayloadAction
  readonly client: BlogServiceClient
}

export const handleSelectSubmit = async (
  input: HandleSelectSubmitInput,
): Promise<void> => {
  const { ctx, payload, client } = input
  ctx.ack()
  const docIds = extractSelectedDocIds(payload)
  if (docIds.length === 0) {
    await ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: ノートが選択されていません。',
    })
    return
  }
  const plan = await client.buildPlan(docIds)
  const rendered = renderPlanBlocks({ plan })
  await ctx.originalUpdater().patch({
    text: rendered.text,
    blocks: rendered.blocks,
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const extractSelectedValues = (action: unknown): string[] | undefined => {
  if (!isRecord(action)) return undefined
  const selected = action['selected_options']
  if (!Array.isArray(selected)) return undefined
  const values: string[] = []
  for (const opt of selected) {
    if (!isRecord(opt)) continue
    const value = opt['value']
    if (typeof value === 'string') values.push(value)
  }
  return values
}

const extractSelectedDocIds = (payload: BlockActionsPayload): string[] => {
  for (const action of payload.actions) {
    if (action.action_id !== 'blog:select-options') continue
    const values = extractSelectedValues(action)
    if (values !== undefined) return values
  }
  const state = payload['state']
  if (!isRecord(state)) return []
  const values = state['values']
  if (!isRecord(values)) return []
  for (const blockValues of Object.values(values)) {
    if (!isRecord(blockValues)) continue
    for (const action of Object.values(blockValues)) {
      const v = extractSelectedValues(action)
      if (v !== undefined) return v
    }
  }
  return []
}
