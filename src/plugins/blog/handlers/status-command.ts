import type { BlogPrSummary } from '@fohte/blog-publisher-contract'

import type { InteractionContext } from '@/interaction/context'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type { SlashCommandBody } from '@/types/slack-payloads'

export interface HandleStatusCommandInput {
  readonly ctx: InteractionContext
  readonly body: SlashCommandBody
  readonly client: BlogServiceClient
}

export const handleStatusCommand = async (
  input: HandleStatusCommandInput,
): Promise<void> => {
  const { ctx, client } = input
  ctx.ack()
  const prs = await client.listPrs('open')
  await ctx.followUp({
    response_type: 'ephemeral',
    text: buildHeader(prs),
    blocks: buildBlocks(prs),
  })
}

const buildHeader = (prs: readonly BlogPrSummary[]): string =>
  prs.length === 0
    ? ':information_source: open な publish PR はありません。'
    : `:open_file_folder: open な publish PR が ${String(prs.length)} 件あります。`

const buildBlocks = (prs: readonly BlogPrSummary[]): unknown[] => {
  if (prs.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':information_source: open な publish PR はありません。',
        },
      },
    ]
  }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:open_file_folder: open publish PR (${String(prs.length)} 件)`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: prs
          .map(
            (pr) =>
              `• <${pr.url}|#${String(pr.number)}> ${pr.title} (branch: \`${pr.branch}\`)`,
          )
          .join('\n'),
      },
    },
  ]
}
