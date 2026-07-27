import { describe, expect, it } from 'vitest'

import { buildSlashCommandsManifest } from '#scripts/print-slash-commands'

describe('buildSlashCommandsManifest', () => {
  it('aggregates commands across plugins in order and attaches the request URL to each', () => {
    const requestUrl = 'https://slack-bot.example.com/api/slack/commands'
    const plugins = [
      {
        name: 'alpha',
        commands: [
          { command: '/alpha-run', description: 'Run alpha' },
          {
            command: '/alpha-config',
            description: 'Configure alpha',
            usage_hint: '<key> <value>',
            should_escape: true,
          },
        ],
      },
      {
        name: 'beta',
        commands: [
          { command: '/beta-status', description: 'Show beta status' },
        ],
      },
    ]

    expect(buildSlashCommandsManifest(requestUrl, plugins)).toEqual([
      { command: '/alpha-run', description: 'Run alpha', url: requestUrl },
      {
        command: '/alpha-config',
        description: 'Configure alpha',
        usage_hint: '<key> <value>',
        should_escape: true,
        url: requestUrl,
      },
      {
        command: '/beta-status',
        description: 'Show beta status',
        url: requestUrl,
      },
    ])
  })

  it('registers the production plugin list without a name or command conflict', () => {
    const requestUrl = 'https://slack-bot.example.com/api/slack/commands'
    expect(() => buildSlashCommandsManifest(requestUrl)).not.toThrow()
  })
})
