import {
  createLogger as createServiceKitLogger,
  type CreateLoggerOptions,
  type LogFields,
  type Logger,
  type LogLevel,
  noopLogger,
} from '@fohte/service-kit/logger'

export type { CreateLoggerOptions, LogFields, Logger, LogLevel }
export { noopLogger }

// DEFAULT_SECRET_KEY_PATTERNS (token/dsn/api_key/authorization) doesn't
// cover this repo's `_secret`-suffixed env/field names (signing_secret,
// cf_access_client_secret, ...), so they're added here to avoid narrowing
// redaction coverage versus the previous hand-rolled pino config.
const EXTRA_SECRET_KEY_PATTERNS = [/(?:^|_)secret$/i]

export const createLogger = (options: CreateLoggerOptions = {}): Logger =>
  createServiceKitLogger({
    ...options,
    extraSecretKeyPatterns: [
      ...EXTRA_SECRET_KEY_PATTERNS,
      ...(options.extraSecretKeyPatterns ?? []),
    ],
  })
