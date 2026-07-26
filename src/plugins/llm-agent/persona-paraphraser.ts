import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ResultAsync } from 'neverthrow'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import { stripThinkBlocks } from '@/plugins/llm-agent/conversation-agent/strip-think-blocks'
import { PersonaParaphraseError } from '@/types/errors'

// Wraps personaPrompt (tone only, see ConversationAgentOptions.personaPrompt)
// with an instruction to rewrite rather than answer, so the same prompt a
// live conversation turn uses as its system prompt can also front this
// one-shot paraphrase call.
export const PARAPHRASE_INSTRUCTION =
  'Rewrite the message below in your own voice. Preserve every fact, ' +
  'number, name, link, and piece of formatting exactly as given — do not ' +
  'add, remove, or answer anything. Reply with only the rewritten message, ' +
  'nothing else.'

export interface PersonaParaphraser {
  // Must not reject: implementations are expected to fail open internally
  // (see createPersonaParaphraser below) since callers use this between an
  // eager settle and a Slack post, where an uncaught rejection could leave
  // a task settled with no response ever posted.
  paraphrase(text: string): Promise<string>
}

export interface CreatePersonaParaphraserOptions {
  // A stateless model (no checkpointer) so this can be called from
  // response-finalizer's own async trigger points (push notification
  // endpoint, task-reconciler poll) without joining ConversationAgent's
  // per-threadId in-flight constraint.
  readonly model: BaseChatModel
  // Same contract as ConversationAgentOptions.personaPrompt: tone only.
  // Undefined/empty skips the LLM call and returns the input unchanged.
  readonly personaPrompt?: string | undefined
  readonly logger?: Logger | undefined
}

export const createPersonaParaphraser = (
  options: CreatePersonaParaphraserOptions,
): PersonaParaphraser => {
  const logger = options.logger ?? noopLogger
  const personaPrompt = options.personaPrompt

  return {
    async paraphrase(text) {
      if (personaPrompt === undefined || personaPrompt === '') return text

      const result = await ResultAsync.fromPromise(
        options.model.invoke([
          new SystemMessage(`${personaPrompt}\n\n${PARAPHRASE_INSTRUCTION}`),
          new HumanMessage(text),
        ]),
        (caughtErr) =>
          new PersonaParaphraseError('failed to paraphrase text', caughtErr),
      )

      if (result.isErr()) {
        // Fail-open: the caller already has a safe, plain-text response, so
        // a paraphrase failure must never block posting it to Slack.
        logger.warn(
          {
            event: 'llm_agent_persona_paraphrase_failed',
            err: result.error.cause,
          },
          'llm-agent failed to paraphrase a response into persona tone; posting the original text',
        )
        return text
      }

      const { text: paraphrased } = stripThinkBlocks(result.value.text)
      return paraphrased.length > 0 ? paraphrased : text
    },
  }
}
