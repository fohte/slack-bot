import { describe, expect, it } from 'vitest'

import { createRecordingLogger } from '@/plugins/llm-agent/_test-utils'
import { createRecordingChatModel } from '@/plugins/llm-agent/conversation-agent/_test-utils'
import {
  createPersonaParaphraser,
  PARAPHRASE_INSTRUCTION,
} from '@/plugins/llm-agent/persona-paraphraser'

describe('createPersonaParaphraser', () => {
  it('sends the persona prompt as a system message and returns the model reply', async () => {
    const model = createRecordingChatModel(() => 'にゃん、了解にゃ')
    const paraphraser = createPersonaParaphraser({
      model,
      personaPrompt: 'You are a cheerful cat persona.',
    })

    const result = await paraphraser.paraphrase('Recorded your meal.')

    expect(result).toBe('にゃん、了解にゃ')
    expect(
      model.calls.map((call) => call.map((m) => [m.type, m.text])),
    ).toEqual([
      [
        [
          'system',
          `You are a cheerful cat persona.\n\n${PARAPHRASE_INSTRUCTION}`,
        ],
        ['human', 'Recorded your meal.'],
      ],
    ])
  })

  it('strips a leaked think block from the reply', async () => {
    const model = createRecordingChatModel(
      () => '<think>plan the rewrite</think>the rewritten text',
    )
    const paraphraser = createPersonaParaphraser({
      model,
      personaPrompt: 'persona',
    })

    expect(await paraphraser.paraphrase('original')).toBe('the rewritten text')
  })

  it('returns the original text unchanged when personaPrompt is undefined', async () => {
    const model = createRecordingChatModel(() => 'should not be called')
    const paraphraser = createPersonaParaphraser({ model })

    expect(await paraphraser.paraphrase('original')).toBe('original')
    expect(model.calls).toEqual([])
  })

  it('returns the original text unchanged when personaPrompt is empty', async () => {
    const model = createRecordingChatModel(() => 'should not be called')
    const paraphraser = createPersonaParaphraser({ model, personaPrompt: '' })

    expect(await paraphraser.paraphrase('original')).toBe('original')
    expect(model.calls).toEqual([])
  })

  it('falls back to the original text when the reply is empty after stripping', async () => {
    const model = createRecordingChatModel(
      () => '<think>only reasoning</think>',
    )
    const paraphraser = createPersonaParaphraser({
      model,
      personaPrompt: 'persona',
    })

    expect(await paraphraser.paraphrase('original')).toBe('original')
  })

  it('fails open and logs a warning when the model call throws', async () => {
    const boom = new Error('rate_limited')
    const model = createRecordingChatModel(() => {
      throw boom
    })
    const logger = createRecordingLogger()
    const paraphraser = createPersonaParaphraser({
      model,
      personaPrompt: 'persona',
      logger,
    })

    expect(await paraphraser.paraphrase('original')).toBe('original')
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        payload: {
          event: 'llm_agent_persona_paraphrase_failed',
          err: boom,
        },
        message:
          'llm-agent failed to paraphrase a response into persona tone; posting the original text',
      },
    ])
  })
})
