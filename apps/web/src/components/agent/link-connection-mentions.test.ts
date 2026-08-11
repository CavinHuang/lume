import { describe, expect, test } from 'bun:test'
import { buildLinkConnectionMentionItems } from './link-connection-mentions'

describe('buildLinkConnectionMentionItems', () => {
  const providers = [
    { service: 'gmail', displayName: 'Gmail', categories: [], authTypes: [], iconUrl: 'gmail.svg' },
    { service: 'github', displayName: 'GitHub', categories: [], authTypes: [], iconUrl: 'github.svg' },
  ]
  const connections = [
    { service: 'github', configured: true, connectionName: 'personal', authType: 'oauth2', profile: { displayName: 'Octo' } },
    { service: 'gmail', configured: true, default: true, connectionName: 'work', authType: 'oauth2', profile: { displayName: 'user@example.com' } },
    { service: 'gmail', configured: true, connectionName: 'fallback', authType: 'oauth2' },
    { service: 'gmail', configured: false, connectionName: 'pending', authType: 'oauth2' },
  ]

  test('only returns configured accounts with default-first ordering and logo data', () => {
    const items = buildLinkConnectionMentionItems(connections, providers, '')
    expect(items.map(({ service, connectionName }) => `${service}:${connectionName}`)).toEqual([
      'gmail:work', 'github:personal', 'gmail:fallback',
    ])
    expect(items[0]).toMatchObject({ displayText: 'Gmail · user@example.com', iconUrl: 'gmail.svg', meta: '默认' })
    expect(items[1]).toMatchObject({ displayText: 'GitHub · Octo', iconUrl: 'github.svg' })
    expect(items[2]).toMatchObject({ displayText: 'Gmail · fallback', iconUrl: 'gmail.svg' })
  })

  test('searches service, provider, profile and connection name', () => {
    expect(buildLinkConnectionMentionItems(connections, providers, 'user@')).toHaveLength(1)
    expect(buildLinkConnectionMentionItems(connections, providers, 'github')[0]?.connectionName).toBe('personal')
    expect(buildLinkConnectionMentionItems(connections, providers, 'fallback')[0]?.displayText).toBe('Gmail · fallback')
  })
})
