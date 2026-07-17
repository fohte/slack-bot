// Some reasoning models (e.g. MiniMax's OpenAI-compatible endpoint) emit
// their chain-of-thought inline in the response content wrapped in <think>
// tags unless the caller opts out via a provider-specific parameter. This is
// a backstop for when that opt-out isn't honored end-to-end (e.g. a gateway
// that doesn't pass it through), so reasoning never reaches Slack.
// https://platform.minimax.io/docs/api-reference/text-openai-api
const THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/gi

// A reasoning model's output can be cut off by a token limit while still
// inside a <think> block, leaving no closing tag; without this, that raw
// reasoning would fall through the pattern above unstripped.
const UNCLOSED_THINK_BLOCK_PATTERN = /<think>[\s\S]*$/i

export interface StripThinkBlocksResult {
  readonly text: string
  // True when a <think> block was actually found and removed, signaling
  // that the reasoning_split request parameter wasn't honored end-to-end
  // and this fallback was the only thing that kept it out of Slack.
  readonly stripped: boolean
}

export const stripThinkBlocks = (text: string): StripThinkBlocksResult => {
  const withoutThinkBlocks = text
    .replace(THINK_BLOCK_PATTERN, '')
    .replace(UNCLOSED_THINK_BLOCK_PATTERN, '')
  return {
    text: withoutThinkBlocks.trim(),
    stripped: withoutThinkBlocks !== text,
  }
}
