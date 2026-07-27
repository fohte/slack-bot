import type { Plugin, SlackAppManifestCommand } from '#plugin/plugin'
import { createPluginRegistry } from '#plugin/registry'
import { BLOG_COMMANDS, BLOG_PLUGIN_NAME } from '#plugins/blog/index'
import {
  LLM_AGENT_COMMANDS,
  LLM_AGENT_PLUGIN_NAME,
} from '#plugins/llm-agent/index'

export interface SlackAppManifestSlashCommand extends SlackAppManifestCommand {
  readonly url: string
}

// Only name + commands are needed to build the manifest, so these are
// listed directly instead of going through each plugin's factory (which
// otherwise requires full runtime deps: DB connections, the Slack client,
// LangGraph model config, etc.). Keep this in sync with the plugins
// registered via bootstrap() in src/main.ts — this list isn't derived from
// it, so an addition there won't automatically appear here.
const MANIFEST_PLUGINS: readonly Plugin[] = [
  { name: BLOG_PLUGIN_NAME, commands: BLOG_COMMANDS },
  { name: LLM_AGENT_PLUGIN_NAME, commands: LLM_AGENT_COMMANDS },
]

export const buildSlashCommandsManifest = (
  requestUrl: string,
  plugins: readonly Plugin[] = MANIFEST_PLUGINS,
): SlackAppManifestSlashCommand[] => {
  const registry = createPluginRegistry()
  for (const plugin of plugins) {
    const registerResult = registry.register(plugin)
    // eslint-disable-next-line no-restricted-syntax -- boundary: script entrypoint fail-fast, no caller of this exported function has a Result-based flow to receive the error
    if (registerResult.isErr()) throw registerResult.error
  }
  return registry
    .buildAppManifestCommands()
    .map((command) => ({ ...command, url: requestUrl }))
}

const entry = process.argv[1] ?? ''
if (
  entry.endsWith('print-slash-commands.js') ||
  entry.endsWith('print-slash-commands.ts')
) {
  const requestUrl = process.argv[2]
  if (requestUrl === undefined || requestUrl === '') {
    // eslint-disable-next-line no-restricted-syntax -- boundary: script entrypoint fail-fast, runs once at CLI invocation
    throw new Error(
      'usage: pnpm print-slash-commands <request-url>\n' +
        'example: pnpm print-slash-commands https://slack-bot.fohte.net/api/slack/commands',
    )
  }
  console.log(JSON.stringify(buildSlashCommandsManifest(requestUrl), null, 2))
}
