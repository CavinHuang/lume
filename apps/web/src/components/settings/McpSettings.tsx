/**
 * McpSettings - 工作区 MCP 服务器管理
 *
 * 通过 agent:get-mcp-config / agent:save-mcp-config 管理当前工作区的 MCP 配置。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  Box,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  Globe2,
  Info,
  Loader2,
  NotepadText,
  Plug,
  RefreshCcw,
  MessageSquare,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { sidecarCall } from '@/lib/desktop-api'
import { openLumeConfigSourceFile } from '@/lib/desktop-api/lume-config'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type {
  GlobalDiscoverySnapshot,
  McpServerEntry,
  McpTransportType,
  WorkspaceMcpConfig,
} from '@lume/shared'

type ViewMode = 'list' | 'create' | 'edit'
type ServerStatus = 'connected' | 'warning' | 'disconnected'

interface EditingServer {
  name: string
  entry: McpServerEntry
}

interface McpTableRow {
  name: string
  entry: McpServerEntry
  status: ServerStatus
  source: string
  lastChecked: string
  Icon: LucideIcon
  iconClassName: string
}

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio（命令行）' },
  { value: 'http', label: 'HTTP（Streamable HTTP）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
]

const INTEGRATIONS: Array<{
  name: string
  workspace: string
  connected: boolean
  Icon: LucideIcon
  color: string
}> = [
  { name: 'Slack', workspace: 'lume-core', connected: true, Icon: MessageSquare, color: 'text-[#24b47e]' },
  { name: 'GitHub', workspace: 'lume-org', connected: true, Icon: GitBranch, color: 'text-[#111827]' },
  { name: 'Notion', workspace: 'Lume Workspace', connected: true, Icon: NotepadText, color: 'text-[#111827]' },
  { name: 'Figma', workspace: '设计团队', connected: true, Icon: Sparkles, color: 'text-[#ff6b5f]' },
  { name: 'Jira', workspace: '-', connected: false, Icon: Box, color: 'text-[#2684ff]' },
  { name: '飞书', workspace: '产品团队', connected: true, Icon: FileText, color: 'text-[#3370ff]' },
]

function parseKeyValueText(text: string, separator: '=' | ':'): Record<string, string> {
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

function serializeKeyValueText(record: Record<string, string> | undefined, separator: '=' | ':'): string {
  if (!record) return ''
  return Object.entries(record)
    .map(([k, v]) => `${k}${separator}${separator === ':' ? ' ' : ''}${v}`)
    .join('\n')
}

export function McpSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const workspaceSlug = workspace?.slug ?? null

  const [config, setConfig] = React.useState<WorkspaceMcpConfig>({ servers: {} })
  const [globalDiscovery, setGlobalDiscovery] = React.useState<GlobalDiscoverySnapshot | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [rescanning, setRescanning] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [editingServer, setEditingServer] = React.useState<EditingServer | null>(null)

  const loadConfig = React.useCallback(async () => {
    if (!workspaceSlug) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [workspaceConfig, discovery] = await Promise.all([
        sidecarCall<WorkspaceMcpConfig>('agent:get-mcp-config', { workspaceSlug }),
        sidecarCall<GlobalDiscoverySnapshot>('agent:get-global-discovery', {}).catch(() => null),
      ])
      setConfig(workspaceConfig ?? { servers: {} })
      setGlobalDiscovery(discovery)
    } catch (error) {
      console.error('[MCP 设置] 加载失败:', error)
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => { loadConfig() }, [loadConfig])

  const handleToggle = async (name: string, nextEnabled?: boolean) => {
    if (!workspaceSlug) return
    try {
      const entry = config.servers[name]
      if (!entry) return
      const newConfig: WorkspaceMcpConfig = {
        servers: {
          ...config.servers,
          [name]: { ...entry, enabled: nextEnabled ?? !entry.enabled },
        },
      }
      await sidecarCall('agent:save-mcp-config', { workspaceSlug, config: newConfig })
      setConfig(newConfig)
    } catch (error) {
      console.error('[MCP 设置] 切换状态失败:', error)
    }
  }

  const handleRescan = async () => {
    setRescanning(true)
    try {
      const discovery = await sidecarCall<GlobalDiscoverySnapshot>('agent:rescan-global-discovery', {})
      setGlobalDiscovery(discovery)
      await loadConfig()
    } catch (error) {
      console.error('[MCP 设置] 重新扫描失败:', error)
    } finally {
      setRescanning(false)
    }
  }

  const handleFormSaved = () => {
    setViewMode('list')
    setEditingServer(null)
    loadConfig()
  }

  if (!workspaceSlug) {
    return (
      <div className="rounded-[10px] border border-dashed border-[#dfe4ee] bg-white p-8 text-center">
        <Plug size={24} className="mx-auto mb-2 text-[#9aa1b3]" />
        <p className="text-[13px] text-[#6d768c]">尚未选择工作区</p>
        <p className="mt-1 text-[11px] text-[#9aa1b3]">
          请先在左侧边栏或 AgentHeader 切换/创建工作区
        </p>
      </div>
    )
  }

  if (viewMode === 'create' || viewMode === 'edit') {
    return (
      <McpServerForm
        workspaceSlug={workspaceSlug}
        server={editingServer}
        existingConfig={config}
        onSaved={handleFormSaved}
        onCancel={() => { setViewMode('list'); setEditingServer(null) }}
      />
    )
  }

  const serverRows = buildServerRows(config.servers ?? {}, globalDiscovery?.mcpServers ?? [])
  const connectedCount = serverRows.filter((row) => row.status === 'connected').length
  const warningCount = serverRows.filter((row) => row.status === 'warning').length
  const discoveredCount = Math.max(serverRows.length, globalDiscovery?.mcpServers.length ?? 0)
  const lastScan = formatLastScan(globalDiscovery?.scannedAt)

  return (
    <div className="space-y-3">
      <McpOverviewStats
        discoveredCount={discoveredCount}
        connectedCount={connectedCount}
        warningCount={warningCount}
        lastScan={lastScan}
      />

      <div className="space-y-3">
        <SettingsCard
          title="MCP 服务发现"
          marker="A"
          action={(
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleRescan()}
                disabled={rescanning}
                className="h-8 gap-2 rounded-[8px] border-[#e1e5ee] bg-white px-3 text-[12px] font-medium text-[#566078] shadow-none hover:bg-[#f8f9fc]"
              >
                {rescanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
                重新扫描
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void openLumeConfigSourceFile()}
                className="h-8 gap-2 rounded-[8px] border-[#e1e5ee] bg-white px-3 text-[12px] font-medium text-[#566078] shadow-none hover:bg-[#f8f9fc]"
              >
                <ExternalLink size={14} />
                打开配置文件
              </Button>
            </div>
          )}
        >
          <p className="mt-1 text-[12px] leading-5 text-[#8a91a6]">
            Lume 会默认从配置文件自动发现 MCP 服务，无需手动添加。
          </p>

          <div className="mt-4 grid h-[86px] grid-cols-[1fr_1fr_1fr] items-center rounded-[8px] border border-[#e8ebf2] bg-white">
            <DiscoveryItem
              icon={FileCode2}
              title="发现方式"
              value="配置文件自动发现"
            />
            <DiscoveryItem
              icon={Folder}
              title="配置来源"
              value="~/.lume/mcp.json"
              subValue="或 项目工作区配置"
              bordered
            />
            <DiscoveryItem
              icon={Clock3}
              title="最近扫描"
              value={lastScan}
              bordered
            />
          </div>

          <div className="mt-4 flex items-center gap-2 text-[12px] leading-5 text-[#8a91a6]">
            <Info size={14} className="text-[#7e88a3]" />
            Lume 会默认从全局配置和当前工作区配置中自动发现 MCP 服务
          </div>
        </SettingsCard>

        <SettingsCard title="已发现的 MCP 服务" marker="B">
          {loading ? (
            <div className="flex h-[180px] items-center justify-center text-[13px] text-[#7c8398]">
              <Loader2 size={14} className="mr-2 animate-spin" />
              加载 MCP 服务...
            </div>
          ) : (
            <div className="mt-4 overflow-hidden">
              <McpServiceTable
                rows={serverRows}
                onEdit={(name, entry) => { setEditingServer({ name, entry }); setViewMode('edit') }}
                onReconnect={(name) => void handleToggle(name, true)}
              />
              <div className="mt-3 text-[12px] text-[#8a91a6]">共 {serverRows.length} 个服务</div>
            </div>
          )}
        </SettingsCard>

        <SettingsCard
          title="集成概览"
          marker="C"
          action={(
            <button
              type="button"
              className="flex items-center gap-1.5 text-[12px] font-semibold text-[#625bff]"
            >
              管理集成
              <ArrowRight size={14} />
            </button>
          )}
        >
          <div className="relative mt-4 min-w-0 overflow-hidden pr-8">
            <div className="grid min-w-0 grid-cols-6 gap-3">
              {INTEGRATIONS.map((item) => (
                <IntegrationCard key={item.name} {...item} />
              ))}
            </div>
            <button
              type="button"
              className="absolute right-0 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-[#7f879d] transition-colors hover:bg-[#f7f8fb] hover:text-[#625bff]"
              aria-label="查看更多集成"
            >
              <ArrowRight size={18} strokeWidth={1.9} />
            </button>
          </div>
        </SettingsCard>
      </div>
    </div>
  )
}

function SettingsCard({
  title,
  marker,
  action,
  children,
}: {
  title: string
  marker?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[10px] border border-[#e7e9f1] bg-white px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          {marker && (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] border border-[#d9d6ff] bg-[#f4f2ff] text-[12px] font-semibold text-[#625bff]">
              {marker}
            </span>
          )}
          <h2 className="text-[16px] font-semibold leading-6 text-[#202338]">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function DiscoveryItem({
  icon: Icon,
  title,
  value,
  subValue,
  bordered,
}: {
  icon: LucideIcon
  title: string
  value: string
  subValue?: string
  bordered?: boolean
}) {
  return (
    <div className={cn('flex h-full items-center gap-3 px-6', bordered && 'border-l border-[#edf0f5]')}>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-[#f0efff] text-[#625bff]">
        <Icon size={22} strokeWidth={1.8} />
      </div>
      <div className="min-w-0">
        <div className="text-[12px] font-medium leading-5 text-[#8a91a6]">{title}</div>
        <div className="truncate text-[13px] font-semibold leading-5 text-[#404960]">{value}</div>
        {subValue && <div className="truncate text-[13px] font-semibold leading-5 text-[#404960]">{subValue}</div>}
      </div>
    </div>
  )
}

function McpServiceTable({
  rows,
  onEdit,
  onReconnect,
}: {
  rows: McpTableRow[]
  onEdit: (name: string, entry: McpServerEntry) => void
  onReconnect: (name: string) => void
}) {
  return (
    <div className="w-full">
      <div className="grid h-8 grid-cols-[176px_112px_114px_112px_128px_1fr] items-center border-b border-[#e8ebf2] text-[12px] font-semibold text-[#7f879d]">
        <div>服务名称</div>
        <div>状态</div>
        <div>来源</div>
        <div>传输方式</div>
        <div>最后检查</div>
        <div className="text-right">操作</div>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-[182px] flex-col items-center justify-center rounded-[8px] border border-dashed border-[#dfe4ee] bg-[#fbfcff] text-center">
          <Plug size={24} className="mb-2 text-[#9aa1b3]" />
          <div className="text-[13px] font-semibold text-[#59637a]">暂无 MCP 服务</div>
          <div className="mt-1 text-[12px] text-[#9aa1b3]">打开配置文件后添加服务，重新扫描后会显示在这里</div>
        </div>
      ) : rows.map((row) => (
        <div
          key={row.name}
          className="grid h-10 grid-cols-[176px_112px_114px_112px_128px_1fr] items-center border-b border-[#edf0f5] text-[13px] last:border-b-0"
        >
          <div className="flex min-w-0 items-center gap-3">
            <row.Icon size={18} className={cn('shrink-0', row.iconClassName)} />
            <span className="truncate font-medium text-[#293246]">{row.name}</span>
          </div>
          <StatusPill status={row.status} />
          <div className="text-[#7b8499]">{row.source}</div>
          <div className="text-[#7b8499]">{row.entry.type}</div>
          <div className="text-[#7b8499]">{row.lastChecked}</div>
          <div className="flex items-center justify-end">
            {row.status === 'connected' ? (
              <button
                type="button"
                onClick={() => onEdit(row.name, row.entry)}
                className="text-[12px] font-semibold text-[#625bff] hover:text-[#5148f0]"
              >
                查看详情
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onReconnect(row.name)}
                className="text-[12px] font-semibold text-[#625bff] hover:text-[#5148f0]"
              >
                重连
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function StatusPill({ status }: { status: ServerStatus }) {
  const meta = {
    connected: { label: '已连接', color: 'bg-[#20c872]', text: 'text-[#7b8499]' },
    warning: { label: '异常', color: 'bg-[#ff9d2e]', text: 'text-[#7b8499]' },
    disconnected: { label: '未连接', color: 'bg-[#a3aabc]', text: 'text-[#7b8499]' },
  }[status]

  return (
    <div className={cn('flex items-center gap-2 text-[12px] font-medium', meta.text)}>
      <span className={cn('size-1.5 rounded-full', meta.color)} />
      {meta.label}
    </div>
  )
}

function IntegrationCard({
  name,
  workspace,
  connected,
  Icon,
  color,
}: {
  name: string
  workspace: string
  connected: boolean
  Icon: LucideIcon
  color: string
}) {
  return (
    <div className="flex h-[134px] min-w-0 flex-col rounded-[8px] border border-[#e8ebf2] bg-white px-3 py-3 shadow-[0_1px_1px_rgba(20,24,40,0.01)]">
      <div className="flex h-7 items-center gap-2">
        <Icon size={24} strokeWidth={2.15} className={cn('shrink-0', color)} />
        <div className="min-w-0 truncate text-[12px] font-semibold leading-4 text-[#293246]">{name}</div>
      </div>
      <div className="mt-[18px] flex items-center gap-1.5 text-[12px] font-medium leading-4 text-[#6f7890]">
        <span className={cn('size-1.5 shrink-0 rounded-full', connected ? 'bg-[#20c872]' : 'bg-[#ff9d2e]')} />
        {connected ? '已连接' : '未连接'}
      </div>
      <div className="mt-2 truncate text-[11px] leading-4 text-[#9aa1b3]">{workspace}</div>
      <button type="button" className="mt-auto self-start text-[12px] font-semibold leading-4 text-[#625bff] hover:text-[#5148f0]">
        管理
      </button>
    </div>
  )
}

function McpOverviewStats({
  discoveredCount,
  connectedCount,
  warningCount,
  lastScan,
}: {
  discoveredCount: number
  connectedCount: number
  warningCount: number
  lastScan: string
}) {
  const stats = [
    {
      label: '已发现服务',
      value: String(discoveredCount),
      icon: Box,
      iconClassName: 'bg-[#f0efff] text-[#625bff]',
    },
    {
      label: '已连接',
      value: String(connectedCount),
      icon: CheckCircle2,
      iconClassName: 'bg-[#eaf9f1] text-[#23b96a]',
    },
    {
      label: '异常',
      value: String(warningCount),
      icon: CircleAlert,
      iconClassName: warningCount > 0 ? 'bg-[#fff4e7] text-[#ff9d2e]' : 'bg-[#f5f7fb] text-[#8a94aa]',
    },
    {
      label: '最近扫描',
      value: lastScan,
      icon: Clock3,
      iconClassName: 'bg-[#eef5ff] text-[#4f7df3]',
    },
  ]

  return (
    <section className="grid h-[78px] grid-cols-4 overflow-hidden rounded-[10px] border border-[#e7e9f1] bg-white shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      {stats.map((stat, index) => {
        const Icon = stat.icon

        return (
          <div key={stat.label} className={cn('flex items-center gap-4 px-5', index > 0 && 'border-l border-[#edf0f6]')}>
            <div className={cn('flex size-12 shrink-0 items-center justify-center rounded-full', stat.iconClassName)}>
              <Icon size={24} strokeWidth={1.85} />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-4 text-[#7b849b]">{stat.label}</div>
              <div className="mt-1 truncate text-[20px] font-semibold leading-6 text-[#101527]">{stat.value}</div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function buildServerRows(
  servers: WorkspaceMcpConfig['servers'],
  discoveredServers: GlobalDiscoverySnapshot['mcpServers']
): McpTableRow[] {
  const rows = new Map<string, { entry: McpServerEntry; source: string }>()

  for (const discovered of discoveredServers) {
    rows.set(discovered.name, {
      entry: {
        type: discovered.type,
        enabled: discovered.enabled,
        command: discovered.command,
        args: discovered.args,
        env: discovered.env,
        url: discovered.url,
        headers: discovered.headers,
      },
      source: getDiscoverySource(discovered.sourcePath),
    })
  }

  for (const [name, entry] of Object.entries(servers ?? {})) {
    rows.set(name, {
      entry,
      source: '工作区配置',
    })
  }

  return Array.from(rows.entries()).map(([name, item], index) => {
    const lowerName = name.toLowerCase()
    const Icon = getServerIcon(lowerName)
    const iconClassName = getServerIconClass(lowerName)
    const invalidConfig = item.entry.type === 'stdio'
      ? !item.entry.command?.trim()
      : !item.entry.url?.trim()
    return {
      name,
      entry: item.entry,
      status: invalidConfig ? 'warning' : item.entry.enabled ? 'connected' : 'disconnected',
      source: item.source,
      lastChecked: item.entry.enabled ? `${Math.max(1, index * 2 + 1)} 分钟前` : '—',
      Icon,
      iconClassName,
    }
  })
}

function getDiscoverySource(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/')
  if (normalized.includes('/agent-workspaces/')) {
    return '工作区配置'
  }
  if (normalized.includes('/.lume/')) {
    return '全局配置'
  }
  return '配置文件'
}

function getServerIcon(name: string): LucideIcon {
  if (name.includes('github')) return GitBranch
  if (name.includes('notion')) return NotepadText
  if (name.includes('browser')) return Globe2
  if (name.includes('file')) return Folder
  return Plug
}

function getServerIconClass(name: string): string {
  if (name.includes('github')) return 'text-[#111827]'
  if (name.includes('notion')) return 'text-[#111827]'
  if (name.includes('browser')) return 'text-[#566078]'
  if (name.includes('file')) return 'text-[#ff9f2d]'
  return 'text-[#625bff]'
}

function formatLastScan(scannedAt?: number): string {
  if (!scannedAt) {
    return '刚刚'
  }

  const elapsedMs = Date.now() - scannedAt
  if (elapsedMs < 60_000) {
    return '刚刚'
  }

  const minutes = Math.max(1, Math.round(elapsedMs / 60_000))
  if (minutes < 60) {
    return `${minutes} 分钟前`
  }

  const hours = Math.round(minutes / 60)
  return `${hours} 小时前`
}

// ===== MCP 服务器表单 =====

function McpServerForm({
  workspaceSlug,
  server,
  existingConfig,
  onSaved,
  onCancel,
}: {
  workspaceSlug: string
  server: EditingServer | null
  existingConfig: WorkspaceMcpConfig
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = server !== null

  const [name, setName] = React.useState(server?.name ?? '')
  const [transportType, setTransportType] = React.useState<McpTransportType>(server?.entry.type ?? 'stdio')
  const [enabled, setEnabled] = React.useState(server?.entry.enabled ?? false)
  const [command, setCommand] = React.useState(server?.entry.command ?? '')
  const [argsText, setArgsText] = React.useState(server?.entry.args?.join(', ') ?? '')
  const [envText, setEnvText] = React.useState(serializeKeyValueText(server?.entry.env, '='))
  const [url, setUrl] = React.useState(server?.entry.url ?? '')
  const [headersText, setHeadersText] = React.useState(serializeKeyValueText(server?.entry.headers, ':'))
  const [saving, setSaving] = React.useState(false)

  const buildEntry = (): McpServerEntry => {
    const base: McpServerEntry = { type: transportType, enabled }
    if (transportType === 'stdio') {
      base.command = command.trim()
      const args = argsText.split(',').map((s) => s.trim()).filter(Boolean)
      if (args.length > 0) base.args = args
      const env = parseKeyValueText(envText, '=')
      if (Object.keys(env).length > 0) base.env = env
    } else {
      base.url = url.trim()
      const headers = parseKeyValueText(headersText, ':')
      if (Object.keys(headers).length > 0) base.headers = headers
    }
    return base
  }

  const canSubmit = () => {
    if (!name.trim()) return false
    if (transportType === 'stdio' && !command.trim()) return false
    if (transportType !== 'stdio' && !url.trim()) return false
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit()) return

    setSaving(true)
    try {
      const newConfig: WorkspaceMcpConfig = {
        servers: { ...(existingConfig.servers ?? {}), [name.trim()]: buildEntry() },
      }
      await sidecarCall('agent:save-mcp-config', { workspaceSlug, config: newConfig })
      onSaved()
    } catch (error) {
      console.error('[MCP 表单] 保存失败:', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-[10px] border border-[#e7e9f1] bg-white p-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={onCancel}>
          <ArrowLeft size={16} />
        </Button>
        <h3 className="flex-1 text-[15px] font-semibold">
          {isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        </h3>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>取消</Button>
        <Button size="sm" type="submit" disabled={saving || !canSubmit()}>
          {saving && <Loader2 size={13} className="animate-spin" />}
          {isEdit ? '保存' : '创建'}
        </Button>
      </div>

      <div className="mt-5 space-y-4">
        <FormField label="服务器名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如: github-mcp" disabled={isEdit} className="h-8 text-[13px]" />
        </FormField>

        <FormField label="传输类型">
          <Select value={transportType} onValueChange={(v) => setTransportType(v as McpTransportType)}>
            <SelectTrigger className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TRANSPORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        {transportType === 'stdio' ? (
          <>
            <FormField label="命令">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如: npx" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="参数" desc="多个参数用逗号分隔">
              <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y, @modelcontextprotocol/server-github" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="环境变量" desc="每行一个，格式: KEY=VALUE">
              <Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={"GITHUB_TOKEN=ghp_xxx\nDEBUG=true"} rows={3} className="resize-y text-[13px] font-mono" />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000/mcp" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="请求头" desc="每行一个，格式: Key: Value">
              <Textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder={"Authorization: Bearer xxx"} rows={3} className="resize-y text-[13px] font-mono" />
            </FormField>
          </>
        )}

        <Separator />

        <div className="flex items-center justify-between px-1">
          <div>
            <Label className="text-[13px]">启用此服务器</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">开启后在 Agent 会话中加载</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {isEdit && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleDeleteFromForm(workspaceSlug, existingConfig, name, onSaved)}
            className="h-9 gap-2 border-[#ff9fa8] text-[#ff4d57] hover:bg-[#fff5f6] hover:text-[#ff4d57]"
          >
            <Trash2 size={14} />
            删除服务器
          </Button>
        )}
      </div>
    </form>
  )
}

async function handleDeleteFromForm(
  workspaceSlug: string,
  existingConfig: WorkspaceMcpConfig,
  name: string,
  onSaved: () => void
) {
  if (!confirm(`确定删除 MCP 服务器「${name}」？`)) return
  const nextServers = { ...(existingConfig.servers ?? {}) }
  delete nextServers[name]
  await sidecarCall('agent:save-mcp-config', {
    workspaceSlug,
    config: { servers: nextServers },
  })
  onSaved()
}

function FormField({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px]">{label}</Label>
      {desc && <p className="text-[11px] text-muted-foreground">{desc}</p>}
      {children}
    </div>
  )
}
