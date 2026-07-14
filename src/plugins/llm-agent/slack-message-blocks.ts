// Slack mrkdwn would otherwise interpret <, >, & inside the response text as
// user/channel mentions or HTML entities.
// https://docs.slack.dev/messaging/formatting-message-text#escaping
export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Structurally compatible with @slack/types' MarkdownBlock; kept local so
// this file doesn't need @slack/types as a direct dependency.
export interface SlackMarkdownBlock {
  readonly type: 'markdown'
  readonly text: string
}

// https://docs.slack.dev/reference/block-kit/blocks/markdown-block
const MARKDOWN_BLOCK_TEXT_LIMIT = 12_000

// Slicing on MARKDOWN_BLOCK_TEXT_LIMIT alone can land between the two
// UTF-16 units of a surrogate pair (e.g. an emoji), leaving a lone
// surrogate. Back the cut off by one more unit when that would happen,
// dropping the whole character instead of splitting it.
const isSurrogatePairAt = (text: string, lowSurrogateIndex: number): boolean =>
  text.charCodeAt(lowSurrogateIndex - 1) >= 0xd800 &&
  text.charCodeAt(lowSurrogateIndex - 1) <= 0xdbff &&
  text.charCodeAt(lowSurrogateIndex) >= 0xdc00 &&
  text.charCodeAt(lowSurrogateIndex) <= 0xdfff

const truncateForMarkdownBlock = (text: string): string => {
  if (text.length <= MARKDOWN_BLOCK_TEXT_LIMIT) return text
  const cutoff = MARKDOWN_BLOCK_TEXT_LIMIT - 1
  const end = isSurrogatePairAt(text, cutoff) ? cutoff - 1 : cutoff
  return `${text.slice(0, end)}…`
}

// Unlike the legacy mrkdwn text field escapeMrkdwn targets, this block type
// follows CommonMark (https://docs.slack.dev/reference/block-kit/blocks/markdown-block),
// where <, >, & do not trigger mention/entity parsing, so its text is not
// escaped here.
export const buildMarkdownBlocks = (text: string): SlackMarkdownBlock[] => [
  { type: 'markdown', text: truncateForMarkdownBlock(text) },
]
