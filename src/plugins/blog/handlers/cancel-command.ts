import { ResultAsync } from 'neverthrow'

import type { InteractionContext } from '#interaction/context'
import type { BlogServiceClient } from '#plugins/blog/service-client'
import type { SlashCommandBody } from '#types/slack-payloads'

export interface HandleCancelCommandInput {
  readonly ctx: InteractionContext
  readonly body: SlashCommandBody
  readonly client: BlogServiceClient
}

export const handleCancelCommand = (
  input: HandleCancelCommandInput,
): ResultAsync<void, unknown> => {
  const { ctx, body, client } = input
  ctx.ack()
  const arg = (body.text ?? '').trim()
  const prNumber = parsePrNumber(arg)
  if (prNumber === undefined) {
    return ctx.followUp({
      response_type: 'ephemeral',
      text: ':warning: 使用法: `/blog-cancel <pr_number>`',
    })
  }
  return ResultAsync.fromPromise(
    client.cancelPr(prNumber),
    (caughtErr) => caughtErr,
  ).andThen(() =>
    ctx.followUp({
      response_type: 'ephemeral',
      text: `:white_check_mark: PR #${String(prNumber)} を close しました。`,
    }),
  )
}

const parsePrNumber = (raw: string): number | undefined => {
  if (raw.length === 0) return undefined
  const cleaned = raw.replace(/^#/, '')
  const n = Number.parseInt(cleaned, 10)
  if (!Number.isFinite(n) || n <= 0 || String(n) !== cleaned) return undefined
  return n
}
