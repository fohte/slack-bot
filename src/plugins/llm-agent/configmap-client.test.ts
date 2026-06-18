import { describe, expect, it } from 'vitest'

import { buildConfigMapManifest } from '@/plugins/llm-agent/configmap-client'

describe('buildConfigMapManifest', () => {
  it('encodes binary entries to base64 and emits the kubernetes v1 ConfigMap shape', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    expect(
      buildConfigMapManifest({
        name: 'slack-abcd1234-images',
        namespace: 'kubeopencode',
        binaryEntries: [{ filename: 'f1.png', bytes: png }],
        labels: { 'slack-bot.fohte.net/slack-event-id': 'Ev1' },
      }),
    ).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'slack-abcd1234-images',
        namespace: 'kubeopencode',
        labels: { 'slack-bot.fohte.net/slack-event-id': 'Ev1' },
      },
      binaryData: {
        'f1.png': Buffer.from(png).toString('base64'),
      },
    })
  })

  it('omits the labels block when no labels are supplied', () => {
    expect(
      buildConfigMapManifest({
        name: 'cm',
        namespace: 'kubeopencode',
        binaryEntries: [],
      }),
    ).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'cm', namespace: 'kubeopencode' },
      binaryData: {},
    })
  })
})
