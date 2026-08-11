import type { Editor } from '@tiptap/core'
import type { LinkConnectionSummary, LinkProviderSummary } from '@lume/shared'
import { listLinkConnections, listLinkProviders } from '@/lib/desktop-api/link'
import type { MentionItem } from './slash-command-state'

let cachedCatalog: { expiresAt: number; value: Promise<{ connections: LinkConnectionSummary[]; providers: LinkProviderSummary[] }> } | null = null

const MAX_REFERENCE_COMPONENT_LENGTH = 256
const MAX_PROVIDER_DISPLAY_LENGTH = 96

function getLinkCatalog() {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) return cachedCatalog.value
  const value = Promise.all([listLinkConnections(), listLinkProviders()])
    .then(([connections, providers]) => ({ connections, providers }))
    .catch(() => ({ connections: [], providers: [] }))
  cachedCatalog = { expiresAt: Date.now() + 3_000, value }
  return value
}

export function buildLinkConnectionMentionItems(
  connections: LinkConnectionSummary[],
  providers: LinkProviderSummary[],
  query: string,
): MentionItem[] {
  const providerByService = new Map(providers.map((provider) => [provider.service, provider]))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return connections
    .filter((connection) => connection.configured
      && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(connection.service)
      && isValidReferenceComponent(connection.connectionName))
    .map((connection) => {
      const provider = providerByService.get(connection.service)
      const providerName = truncateDisplayText(
        provider?.displayName?.trim() || connection.service,
        MAX_PROVIDER_DISPLAY_LENGTH,
      )
      const accountName = truncateDisplayText(
        connection.profile?.displayName?.trim() || connection.connectionName,
        MAX_REFERENCE_COMPONENT_LENGTH - providerName.length - 3,
      )
      return {
        id: `connector:${connection.service}:${connection.connectionName}`,
        label: `${providerName} · ${accountName}`,
        displayText: `${providerName} · ${accountName}`,
        title: providerName,
        subtitle: accountName,
        type: 'connector' as const,
        section: 'connector' as const,
        meta: connection.default ? '默认' : undefined,
        service: connection.service,
        connectionName: connection.connectionName,
        iconUrl: provider?.iconUrl,
        searchText: `${connection.service}\n${providerName}\n${accountName}\n${connection.connectionName}`.toLocaleLowerCase(),
        isDefault: connection.default === true,
      }
    })
    .filter((item) => !normalizedQuery || item.searchText.includes(normalizedQuery))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
      || left.title.localeCompare(right.title)
      || left.subtitle.localeCompare(right.subtitle)
      || left.connectionName.localeCompare(right.connectionName))
    .map(({ searchText: _searchText, isDefault: _isDefault, ...item }) => item)
}

function isValidReferenceComponent(value: string): boolean {
  return value === value.trim()
    && value.length > 0
    && value.length <= MAX_REFERENCE_COMPONENT_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function truncateDisplayText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

export async function fetchLinkConnectionMentionItems(query: string): Promise<MentionItem[]> {
  const { connections, providers } = await getLinkCatalog()
  return buildLinkConnectionMentionItems(connections, providers, query)
}

export function insertLinkConnectionMention(
  editor: Editor,
  range: { from: number; to: number },
  item: MentionItem,
): boolean {
  if (!item.service || !item.connectionName || !item.displayText) return false
  return editor.chain().focus().deleteRange(range).insertContent([
    {
      type: 'linkConnectionMention',
      attrs: {
        schemaVersion: 1,
        service: item.service,
        connectionName: item.connectionName,
        displayText: item.displayText,
      },
    },
    { type: 'text', text: ' ' },
  ]).run()
}
