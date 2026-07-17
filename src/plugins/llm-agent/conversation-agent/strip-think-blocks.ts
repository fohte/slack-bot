// Some reasoning models (e.g. MiniMax's OpenAI-compatible endpoint) emit
// their chain-of-thought inline in the response content wrapped in <think>
// tags unless the caller opts out via a provider-specific parameter. This is
// a backstop for when that opt-out isn't honored end-to-end (e.g. a gateway
// that doesn't pass it through), so reasoning never reaches Slack.
// https://platform.minimax.io/docs/api-reference/text-openai-api
const THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/gi

export const stripThinkBlocks = (text: string): string =>
  text.replace(THINK_BLOCK_PATTERN, '').trim()
