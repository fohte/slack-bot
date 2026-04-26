import pino, { type Logger as PinoLogger } from 'pino'

import type { LogLevel } from '@/config/config'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(fields: LogFields, message?: string): void
  info(fields: LogFields, message?: string): void
  warn(fields: LogFields, message?: string): void
  error(fields: LogFields, message?: string): void
  child(bindings: LogFields): Logger
}

const REDACT_PATHS = [
  '*.authorization',
  '*.bot_token',
  '*.slack_bot_token',
  '*.signing_secret',
  '*.slack_signing_secret',
  '*.cf_access_client_secret',
  '*.service_token_secret',
  '*.token',
  '*.secret',
  'authorization',
  'bot_token',
  'slack_bot_token',
  'signing_secret',
  'slack_signing_secret',
  'cf_access_client_secret',
  'service_token_secret',
  'token',
  'secret',
]

export interface LoggerOptions {
  readonly level: LogLevel
  readonly destination?: NodeJS.WritableStream | undefined
  readonly base?: LogFields | undefined
  readonly additionalRedactPaths?: readonly string[] | undefined
}

export const createLogger = (options: LoggerOptions): Logger => {
  const redactPaths = [...REDACT_PATHS, ...(options.additionalRedactPaths ?? [])]
  const pinoOptions: pino.LoggerOptions = {
    level: options.level,
    base: options.base ?? null,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  }
  const stream = options.destination ?? process.stdout
  const instance = pino(pinoOptions, stream)
  return wrap(instance)
}

const wrap = (instance: PinoLogger): Logger => ({
  debug(fields, message) {
    instance.debug(fields, message)
  },
  info(fields, message) {
    instance.info(fields, message)
  },
  warn(fields, message) {
    instance.warn(fields, message)
  },
  error(fields, message) {
    instance.error(fields, message)
  },
  child(bindings) {
    return wrap(instance.child(bindings))
  },
})

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
}
