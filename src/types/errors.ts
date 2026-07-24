export class ConfigLoadError extends Error {
  override readonly name = 'ConfigLoadError'
}

export class PluginNameConflictError extends Error {
  override readonly name = 'PluginNameConflictError'
  constructor(pluginName: string) {
    super(`Plugin name already registered: ${pluginName}`)
  }
}

export class SlashCommandConflictError extends Error {
  override readonly name = 'SlashCommandConflictError'
  constructor(commandName: string, existingPlugin: string, newPlugin: string) {
    super(
      `Slash command '${commandName}' is already registered by plugin '${existingPlugin}', cannot register again from plugin '${newPlugin}'`,
    )
  }
}

export class PluginInvalidNameError extends Error {
  override readonly name = 'PluginInvalidNameError'
  constructor(pluginName: string) {
    super(
      `Invalid plugin name: '${pluginName}'. Must match /^[a-z][a-z0-9-]{0,31}$/`,
    )
  }
}

export class InvalidSignatureError extends Error {
  override readonly name = 'InvalidSignatureError'
}

export class StaleTimestampError extends Error {
  override readonly name = 'StaleTimestampError'
}

export class PluginNotFoundError extends Error {
  override readonly name = 'PluginNotFoundError'
}

export class MalformedPayloadError extends Error {
  override readonly name = 'MalformedPayloadError'
}

export class PluginHandlerError extends Error {
  override readonly name = 'PluginHandlerError'
  override readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.cause = cause
  }
}

export class SlackApiError extends Error {
  override readonly name = 'SlackApiError'
  readonly status: number | undefined
  readonly slackError: string | undefined
  override readonly cause: unknown
  constructor(
    message: string,
    options: {
      status?: number | undefined
      slackError?: string | undefined
      cause?: unknown
    } = {},
  ) {
    super(message)
    this.status = options.status
    this.slackError = options.slackError
    this.cause = options.cause
  }
}

export class ResponseUrlExhaustedError extends Error {
  override readonly name = 'ResponseUrlExhaustedError'
}

export class CfAccessAuthError extends Error {
  override readonly name = 'CfAccessAuthError'
  constructor(pluginName: string) {
    super(
      `Cloudflare Access service token is not configured for plugin '${pluginName}'`,
    )
  }
}

export class SchedulerLimitError extends Error {
  override readonly name = 'SchedulerLimitError'
  constructor(limit: number) {
    super(`Scheduler concurrent task limit exceeded: ${String(limit)}`)
  }
}

export class SchedulerDuplicateNameError extends Error {
  override readonly name = 'SchedulerDuplicateNameError'
  constructor(name: string) {
    super(`Scheduler task with name '${name}' is already registered`)
  }
}

export class SchedulerInvalidArgumentError extends Error {
  override readonly name = 'SchedulerInvalidArgumentError'
}
