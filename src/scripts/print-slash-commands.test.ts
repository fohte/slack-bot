import { describe, expect, it } from 'vitest'

import { buildSlashCommandsManifest } from '#scripts/print-slash-commands'

describe('buildSlashCommandsManifest', () => {
  it('returns every registered plugin command with the request URL attached', () => {
    const requestUrl = 'https://slack-bot.example.com/api/slack/commands'
    expect(buildSlashCommandsManifest(requestUrl)).toEqual([
      {
        command: '/blog-post',
        description: 'Pick blog notes and create a publish PR',
        url: requestUrl,
      },
      {
        command: '/blog-status',
        description: 'List open blog publish PRs',
        url: requestUrl,
      },
      {
        command: '/blog-cancel',
        description: 'Cancel an open blog publish PR',
        usage_hint: '<pr_number>',
        url: requestUrl,
      },
    ])
  })
})
