import {
  initObservability as initObservabilityCore,
  type ObservabilityEnv,
  type ObservabilityHandle,
} from '@fohte/service-kit/observability'

import { createLogger } from '@/logger/logger'

export type { ObservabilityEnv, ObservabilityHandle }

export const initObservability = (env: ObservabilityEnv): ObservabilityHandle =>
  initObservabilityCore(env, {
    logger: createLogger({ level: 'info', base: { service: 'slack-bot' } }),
    extraStringTruncators: [
      { pattern: /^(slack_)?message(_text|_body)?$/i, maxLength: 200 },
    ],
  })
