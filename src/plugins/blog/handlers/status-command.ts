import type { BlogPrSummary } from '@fohte/blog-publisher-contract'

import type { InteractionContext } from '@/interaction/context'
import { escapeMrkdwn } from '@/plugins/blog/plan-presenter'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type { SlashCommandBody } from '@/types/slack-payloads'

const MAX_PRS_PER_BLOCK = 20

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
  const shown = prs.slice(0, MAX_PRS_PER_BLOCK)
  const blocks: unknown[] = [
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
        text: shown
          .map(
            (pr) =>
              `• <${pr.url}|#${String(pr.number)}> ${escapeMrkdwn(pr.title)} (branch: \`${pr.branch}\`)`,
          )
          .join('\n'),
      },
    },
  ]
  if (prs.length > MAX_PRS_PER_BLOCK) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `他 ${String(prs.length - MAX_PRS_PER_BLOCK)} 件は省略しました。GitHub で確認してください。`,
        },
      ],
    })
  }
  return blocks
}
