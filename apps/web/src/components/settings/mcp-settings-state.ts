import {
  normalizeMcpTransport,
  parseMcpImportPayload,
  type McpPublicStatus,
  type McpServerEntry,
  type McpServerStatus,
  type McpToolDetail,
  type McpTransportType,
  type WorkspaceMcpConfig,
} from '@lume/shared'

export const MCP_TRANSPORT_OPTIONS: Array<{ value: McpTransportType; label: string }> = [
  { value: 'stdio', label: 'stdio（命令行）' },
  { value: 'streamable_http', label: 'HTTP（Streamable HTTP）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
]

export type McpUiStatus = 'connected' | 'connecting' | 'warning' | 'disconnected'

export interface McpServerDraft {
  name: string
  enabled: boolean
  transport: McpTransportType
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
  disabledTools: string[]
}

export interface McpServerRow {
  name: string
  displayName: string
  entry: McpServerEntry
  transport: McpTransportType
  enabled: boolean
  status: McpUiStatus
  statusLabel: string
  source: string
  lastChecked: string
  toolCount: number
  tools: string[]
  toolDetails: McpToolDetail[]
  errorMessage?: string
}

export interface McpToolDisplayItem {
  label: string
  originalName: string
  wrapperName: string
  description?: string
  enabled: boolean
}

export type McpImportResult =
  | { ok: true; config: WorkspaceMcpConfig }
  | { ok: false; error: string }

export function parseKeyValueText(text: string, separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(separator)
    if (idx <= 0) continue
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return result
}

export function serializeKeyValueText(record: Record<string, string> | undefined, separator: '=' | ':'): string {
  if (!record) return ''
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${separator === ':' ? ' ' : ''}${value}`)
    .join('\n')
}

export function formatMcpTransport(transport: McpTransportType): string {
  if (transport === 'streamable_http') return 'HTTP'
  if (transport === 'sse') return 'SSE'
  return 'stdio'
}

export function formatMcpLastChecked(value: number | undefined, now = Date.now()): string {
  if (!value) return '—'
  const elapsedMs = Math.max(0, now - value)
  const elapsedMinutes = Math.floor(elapsedMs / 60_000)
  if (elapsedMinutes < 1) return '刚刚'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时前`
  return `${Math.floor(elapsedHours / 24)} 天前`
}

export function createMcpServerDraft(server?: { name: string; entry: McpServerEntry } | null): McpServerDraft {
  const entry = server?.entry
  const transport = normalizeMcpTransport(entry) ?? 'stdio'
  return {
    name: server?.name ?? '',
    enabled: entry?.enabled ?? false,
    transport,
    command: entry?.command ?? '',
    argsText: entry?.args?.join(', ') ?? '',
    envText: serializeKeyValueText(entry?.env, '='),
    url: entry?.url ?? '',
    headersText: serializeKeyValueText(entry?.headers, ':'),
    disabledTools: entry?.disabledTools ?? [],
  }
}

export function buildMcpServerEntryFromDraft(draft: McpServerDraft): McpServerEntry {
  const entry: McpServerEntry = {
    enabled: draft.enabled,
    transport: draft.transport,
  }

  if (draft.transport === 'stdio') {
    entry.command = draft.command.trim()
    const args = draft.argsText.split(',').map((item) => item.trim()).filter(Boolean)
    if (args.length > 0) entry.args = args
    const env = parseKeyValueText(draft.envText, '=')
    if (Object.keys(env).length > 0) entry.env = env
  } else {
    entry.url = draft.url.trim()
    const headers = parseKeyValueText(draft.headersText, ':')
    if (Object.keys(headers).length > 0) entry.headers = headers
  }
  const disabledTools = draft.disabledTools ?? []
  if (disabledTools.length > 0) entry.disabledTools = [...disabledTools]

  return entry
}

export function buildMcpConfigAfterSave(
  existingConfig: WorkspaceMcpConfig,
  originalName: string | null,
  draft: McpServerDraft
): WorkspaceMcpConfig {
  const nextServers = { ...(existingConfig.servers ?? {}) }
  const nextName = draft.name.trim()
  if (originalName && originalName !== nextName) {
    delete nextServers[originalName]
  }
  nextServers[nextName] = buildMcpServerEntryFromDraft(draft)
  return { servers: nextServers }
}

export function parseMcpConfigImportText(text: string): McpImportResult {
  try {
    const parsed = JSON.parse(text)
    const config = parseMcpImportPayload(parsed)
    return { ok: true, config }
  } catch {
    return { ok: false, error: 'JSON 格式无效' }
  }
}

export function buildMcpServerRows(
  servers: WorkspaceMcpConfig['servers'],
  statuses: McpServerStatus[] = [],
  now = Date.now()
): McpServerRow[] {
  const statusById = new Map(statuses.map((status) => [status.serverId, status]))
  return Object.entries(servers ?? {}).map(([name, entry]) => {
    const live = statusById.get(name)
    const transport = live?.transport ?? normalizeMcpTransport(entry) ?? 'stdio'
    const rowStatus = resolveRowStatus(entry, live)
    return {
      name,
      displayName: live?.name ?? entry.name ?? name,
      entry,
      transport,
      enabled: entry.enabled,
      status: rowStatus,
      statusLabel: formatMcpRowStatus(rowStatus, entry.enabled),
      source: '工作区配置',
      lastChecked: formatMcpLastChecked(live?.lastCheckedAt, now),
      toolCount: countEnabledMcpTools(entry, live),
      tools: live?.tools ?? [],
      toolDetails: live?.toolDetails ?? [],
      ...(live?.error?.message ? { errorMessage: live.error.message } : {}),
    }
  })
}

export function buildMcpToolDisplayItems(row: Pick<McpServerRow, 'tools' | 'toolDetails'> & {
  entry?: Pick<McpServerEntry, 'disabledTools'>
}): McpToolDisplayItem[] {
  const disabledTools = new Set(row.entry?.disabledTools ?? [])
  if (row.toolDetails.length > 0) {
    return row.toolDetails.map((tool) => ({
      label: tool.originalName || tool.name,
      originalName: tool.originalName || tool.name,
      wrapperName: tool.wrapperName || tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      enabled: !isMcpToolDisabled(disabledTools, tool.originalName, tool.wrapperName, tool.name),
    }))
  }

  return row.tools.map((name) => ({
    label: name,
    originalName: name,
    wrapperName: name,
    enabled: !isMcpToolDisabled(disabledTools, name),
  }))
}

export function formatMcpToolPreview(row: Pick<McpServerRow, 'tools' | 'toolDetails'>, max = 2): string {
  const items = buildMcpToolDisplayItems(row).filter((item) => item.enabled)
  if (items.length === 0) {
    return buildMcpToolDisplayItems(row).length > 0 ? '暂无启用工具' : '暂无工具'
  }
  const visibleCount = Math.max(1, max)
  const preview = items.slice(0, visibleCount).map((item) => item.label).join(', ')
  const remainingCount = items.length - visibleCount
  return remainingCount > 0 ? `${preview} +${remainingCount}` : preview
}

export function shouldPollMcpStatus(rows: Array<Pick<McpServerRow, 'status'>>): boolean {
  return rows.some((row) => row.status === 'connecting')
}

function resolveRowStatus(entry: McpServerEntry, live?: McpServerStatus): McpUiStatus {
  if (!entry.enabled) return 'disconnected'
  if (!hasRequiredConnectionFields(entry)) return 'warning'
  if (!live) return 'disconnected'
  return mapPublicStatus(live.status)
}

function countEnabledMcpTools(entry: McpServerEntry, live?: McpServerStatus): number {
  if (!live) return 0
  return buildMcpToolDisplayItems({
    entry,
    tools: live.tools,
    toolDetails: live.toolDetails,
  }).filter((item) => item.enabled).length
}

function isMcpToolDisabled(disabledTools: ReadonlySet<string>, ...names: Array<string | undefined>): boolean {
  return names.some((name) => Boolean(name && disabledTools.has(name)))
}

function mapPublicStatus(status: McpPublicStatus): McpUiStatus {
  if (status === 'connected') return 'connected'
  if (status === 'connecting') return 'connecting'
  if (status === 'error' || status === 'auth_needed') return 'warning'
  return 'disconnected'
}

function formatMcpRowStatus(status: McpUiStatus, enabled: boolean): string {
  if (!enabled) return '未启用'
  if (status === 'connected') return '已连接'
  if (status === 'connecting') return '连接中'
  if (status === 'warning') return '异常'
  return '未连接'
}

function hasRequiredConnectionFields(entry: McpServerEntry): boolean {
  const transport = normalizeMcpTransport(entry)
  if (transport === 'stdio') return Boolean(entry.command?.trim())
  if (transport === 'streamable_http' || transport === 'sse') return Boolean(entry.url?.trim())
  return false
}
