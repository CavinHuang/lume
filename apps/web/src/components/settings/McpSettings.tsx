/**
 * McpSettings - 工作区 MCP 服务器管理
 *
 * 通过 agent:get-mcp-config / agent:save-mcp-config 管理当前工作区的 MCP 配置。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch,
  Globe2,
  Info,
  ListChecks,
  Loader2,
  NotepadText,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  getMcpConfig,
  getMcpStatus,
  saveMcpConfig,
  testMcpServer,
} from '@/lib/desktop-api'
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
import {
  MCP_TRANSPORT_OPTIONS,
  buildMcpConfigAfterSave,
  buildMcpServerRows,
  buildMcpToolDisplayItems,
  createMcpServerDraft,
  formatMcpTransport,
  formatMcpToolPreview,
  parseMcpConfigImportText,
  shouldPollMcpStatus,
  type McpServerDraft,
  type McpServerRow,
  type McpToolDisplayItem,
  type McpUiStatus,
} from './mcp-settings-state'
import type {
  McpServerEntry,
  McpServerStatus,
  WorkspaceMcpConfig,
} from '@lume/shared'

type ViewMode = 'list' | 'create' | 'edit'

interface EditingServer {
  name: string
  entry: McpServerEntry
}

type McpTableRow = McpServerRow & {
  Icon: LucideIcon
  iconClassName: string
}

export function McpSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const workspaceSlug = workspace?.slug ?? null

  const [config, setConfig] = React.useState<WorkspaceMcpConfig>({ servers: {} })
  const [statuses, setStatuses] = React.useState<McpServerStatus[]>([])
  const [loading, setLoading] = React.useState(true)
  const [statusLoading, setStatusLoading] = React.useState(false)
  const [testingServerId, setTestingServerId] = React.useState<string | null>(null)
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [editingServer, setEditingServer] = React.useState<EditingServer | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)
  const [importText, setImportText] = React.useState('')

  const refreshStatus = React.useCallback(async (options: {
    waitForConnections?: boolean
    showLoading?: boolean
    showErrorToast?: boolean
  } = {}) => {
    if (!workspaceSlug) return
    const {
      waitForConnections = true,
      showLoading = true,
      showErrorToast = true,
    } = options
    if (showLoading) setStatusLoading(true)
    try {
      const status = await getMcpStatus(workspaceSlug, { waitForConnections })
      setStatuses(status.servers ?? [])
    } catch (error) {
      console.error('[MCP 设置] 刷新状态失败:', error)
      if (showErrorToast) toast.error('刷新 MCP 状态失败')
    } finally {
      if (showLoading) setStatusLoading(false)
    }
  }, [workspaceSlug])

  const loadConfig = React.useCallback(async () => {
    if (!workspaceSlug) {
      setConfig({ servers: {} })
      setStatuses([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const workspaceConfig = await getMcpConfig(workspaceSlug)
      setConfig(workspaceConfig ?? { servers: {} })
      const status = await getMcpStatus(workspaceSlug, { waitForConnections: true })
      setStatuses(status.servers ?? [])
    } catch (error) {
      console.error('[MCP 设置] 加载失败:', error)
      toast.error('加载 MCP 配置失败')
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => { loadConfig() }, [loadConfig])

  const serverRows = React.useMemo(
    () => attachServerIcons(buildMcpServerRows(config.servers ?? {}, statuses)),
    [config.servers, statuses]
  )
  const isPollingStatus = shouldPollMcpStatus(serverRows)

  React.useEffect(() => {
    if (!workspaceSlug || viewMode !== 'list' || loading || !isPollingStatus) return
    const intervalId = window.setInterval(() => {
      void refreshStatus({
        waitForConnections: false,
        showLoading: false,
        showErrorToast: false,
      })
    }, 2_000)
    return () => window.clearInterval(intervalId)
  }, [workspaceSlug, viewMode, loading, isPollingStatus, refreshStatus])

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
      await saveMcpConfig(workspaceSlug, newConfig)
      setConfig(newConfig)
      toast.success(newConfig.servers[name]?.enabled ? 'MCP 服务已启用' : 'MCP 服务已停用')
      void refreshStatus({ waitForConnections: true })
    } catch (error) {
      console.error('[MCP 设置] 切换状态失败:', error)
      toast.error('更新 MCP 服务失败')
    }
  }

  const handleTestServer = async (name: string) => {
    if (!workspaceSlug) return
    setTestingServerId(name)
    try {
      const result = await testMcpServer(workspaceSlug, name)
      setStatuses((prev) => {
        const next = prev.filter((status) => status.serverId !== result.server.serverId)
        return [...next, result.server]
      })
      if (result.server.status === 'connected') {
        toast.success(`MCP 服务「${result.server.name}」已连接`)
      } else {
        toast.error(result.server.error?.message ?? `MCP 服务「${result.server.name}」未连接`)
      }
    } catch (error) {
      console.error('[MCP 设置] 测试连接失败:', error)
      toast.error('测试 MCP 服务失败')
    } finally {
      setTestingServerId(null)
    }
  }

  const handleToggleTool = async (serverName: string, originalToolName: string, nextEnabled: boolean) => {
    if (!workspaceSlug) return
    const entry = config.servers[serverName]
    if (!entry) return

    const disabledTools = new Set(entry.disabledTools ?? [])
    if (nextEnabled) {
      disabledTools.delete(originalToolName)
    } else {
      disabledTools.add(originalToolName)
    }
    const nextDisabledTools = Array.from(disabledTools).sort()
    const nextEntry: McpServerEntry = { ...entry }
    if (nextDisabledTools.length > 0) {
      nextEntry.disabledTools = nextDisabledTools
    } else {
      delete nextEntry.disabledTools
    }
    const newConfig: WorkspaceMcpConfig = {
      servers: {
        ...config.servers,
        [serverName]: nextEntry,
      },
    }

    try {
      await saveMcpConfig(workspaceSlug, newConfig)
      setConfig(newConfig)
      toast.success(nextEnabled ? 'MCP 工具已启用' : 'MCP 工具已停用')
    } catch (error) {
      console.error('[MCP 设置] 更新工具状态失败:', error)
      toast.error('更新 MCP 工具失败')
    }
  }

  const handleImport = async () => {
    if (!workspaceSlug) return
    const parsed = parseMcpConfigImportText(importText)
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    const importedCount = Object.keys(parsed.config.servers).length
    if (importedCount === 0) {
      toast.error('没有可导入的 MCP 服务')
      return
    }
    const nextConfig = {
      servers: {
        ...(config.servers ?? {}),
        ...parsed.config.servers,
      },
    }
    try {
      await saveMcpConfig(workspaceSlug, nextConfig)
      setConfig(nextConfig)
      setImportText('')
      setImportOpen(false)
      toast.success(`已导入 ${importedCount} 个 MCP 服务`)
      void refreshStatus({ waitForConnections: true })
    } catch (error) {
      console.error('[MCP 设置] 导入失败:', error)
      toast.error('导入 MCP 服务失败')
    }
  }

  const handleFormSaved = () => {
    setViewMode('list')
    setEditingServer(null)
    loadConfig()
  }

  if (!workspaceSlug) {
    return (
      <div className="rounded-[10px] border border-dashed border-[var(--border)] bg-[var(--surface-1)] p-8 text-center">
        <Plug size={24} className="mx-auto mb-2 text-[var(--text-3)]" />
        <p className="text-[13px] text-[var(--text-2)]">尚未选择工作区</p>
        <p className="mt-1 text-[11px] text-[var(--text-3)]">
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

  const connectedCount = serverRows.filter((row) => row.status === 'connected').length
  const warningCount = serverRows.filter((row) => row.status === 'warning').length
  const discoveredCount = serverRows.length
  const lastScan = statusLoading ? '刷新中' : isPollingStatus ? '连接中' : '实时状态'

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
          title="MCP 服务配置"
          marker="A"
          action={(
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setImportOpen((open) => !open)}
                className="lume-action-tile h-8 gap-2 px-3 text-[12px] shadow-none"
              >
                <Upload size={14} />
                导入 JSON
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void openLumeConfigSourceFile()}
                className="lume-action-tile h-8 gap-2 px-3 text-[12px] shadow-none"
              >
                <ExternalLink size={14} />
                打开配置文件
              </Button>
            </div>
          )}
        >
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            当前工作区的 MCP 服务由工作区配置文件管理。
          </p>

          <div className="lume-subpanel mt-4 grid h-[86px] grid-cols-[1fr_1fr_1fr] items-center">
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
              title="状态来源"
              value={lastScan}
              bordered
            />
          </div>

          <div className="mt-4 flex items-center gap-2 text-[12px] leading-5 text-[var(--text-3)]">
            <Info size={14} className="text-[var(--text-3)]" />
            支持 stdio、SSE 与 Streamable HTTP；导入会接受标准 mcpServers JSON。
          </div>

          {importOpen && (
            <div className="lume-subpanel mt-4 p-3">
              <Textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'{"mcpServers":{"github":{"type":"http","url":"https://example.com/mcp"}}}'}
                rows={5}
                className="resize-y text-[12px] font-mono"
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setImportText(''); setImportOpen(false) }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleImport()}
                  disabled={!importText.trim()}
                  className="gap-2"
                >
                  <Upload size={14} />
                  导入
                </Button>
              </div>
            </div>
          )}
        </SettingsCard>

        <SettingsCard
          title="已发现的 MCP 服务"
          marker="B"
          action={(
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshStatus({ waitForConnections: true })}
                disabled={statusLoading}
                className="lume-action-tile h-8 gap-2 px-3 text-[12px] shadow-none"
              >
                {statusLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                刷新
              </Button>
              <Button
                type="button"
                onClick={() => { setEditingServer(null); setViewMode('create') }}
                className="h-8 gap-2 rounded-[8px] px-3 text-[12px]"
              >
                <Plus size={14} />
                添加服务
              </Button>
            </div>
          )}
        >
          {loading ? (
            <div className="flex h-[180px] items-center justify-center text-[13px] text-[var(--text-3)]">
              <Loader2 size={14} className="mr-2 animate-spin" />
              加载 MCP 服务...
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <McpServiceTable
                rows={serverRows}
                testingServerId={testingServerId}
                onEdit={(name, entry) => { setEditingServer({ name, entry }); setViewMode('edit') }}
                onToggle={(name, nextEnabled) => void handleToggle(name, nextEnabled)}
                onTest={(name) => void handleTestServer(name)}
                onToggleTool={(serverName, originalToolName, nextEnabled) =>
                  void handleToggleTool(serverName, originalToolName, nextEnabled)}
              />
              <div className="mt-3 text-[12px] text-[var(--text-3)]">共 {serverRows.length} 个服务</div>
            </div>
          )}
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
    <section className="lume-panel px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          {marker && (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] border border-[color-mix(in_oklab,var(--brand)_25%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[12px] font-semibold text-[var(--brand)]">
              {marker}
            </span>
          )}
          <h2 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">{title}</h2>
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
    <div className={cn('flex h-full items-center gap-3 px-6', bordered && 'border-l border-[var(--border)]')}>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
        <Icon size={22} strokeWidth={1.8} />
      </div>
      <div className="min-w-0">
        <div className="text-[12px] font-medium leading-5 text-[var(--text-3)]">{title}</div>
        <div className="truncate text-[13px] font-semibold leading-5 text-[var(--text-1)]">{value}</div>
        {subValue && <div className="truncate text-[13px] font-semibold leading-5 text-[var(--text-1)]">{subValue}</div>}
      </div>
    </div>
  )
}

function McpServiceTable({
  rows,
  testingServerId,
  onEdit,
  onToggle,
  onTest,
  onToggleTool,
}: {
  rows: McpTableRow[]
  testingServerId: string | null
  onEdit: (name: string, entry: McpServerEntry) => void
  onToggle: (name: string, nextEnabled: boolean) => void
  onTest: (name: string) => void
  onToggleTool: (serverName: string, originalToolName: string, nextEnabled: boolean) => void
}) {
  const [expandedServerName, setExpandedServerName] = React.useState<string | null>(null)

  return (
    <div className="min-w-[1000px]">
      <div className="grid h-8 grid-cols-[176px_96px_88px_88px_minmax(180px,1fr)_96px_280px] items-center border-b border-[var(--border)] text-[12px] font-semibold text-[var(--text-3)]">
        <div>服务名称</div>
        <div>状态</div>
        <div>来源</div>
        <div>传输方式</div>
        <div>工具</div>
        <div>最后检查</div>
        <div className="text-right">操作</div>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-[182px] flex-col items-center justify-center rounded-[8px] border border-dashed border-[var(--border)] bg-[var(--background)] text-center">
          <Plug size={24} className="mb-2 text-[var(--text-3)]" />
          <div className="text-[13px] font-semibold text-[var(--text-2)]">暂无 MCP 服务</div>
          <div className="mt-1 text-[12px] text-[var(--text-3)]">添加服务或导入 mcpServers JSON 后会显示在这里</div>
        </div>
      ) : rows.map((row) => {
        const toolItems = buildMcpToolDisplayItems(row)
        const isExpanded = expandedServerName === row.name
        const toolListTitle = toolItems.map((item) => item.label).join(', ') || '暂无工具'
        const isBuiltIn = row.source === '内置'

        return (
          <React.Fragment key={row.name}>
            <div className="grid min-h-11 grid-cols-[176px_96px_88px_88px_minmax(180px,1fr)_96px_280px] items-center border-b border-[var(--border)] py-1 text-[13px]">
              <div className="flex min-w-0 items-center gap-3">
                <row.Icon size={18} className={cn('shrink-0', row.iconClassName)} />
                <span className="truncate font-medium text-[var(--text-1)]" title={row.displayName}>{row.displayName}</span>
              </div>
              <StatusPill status={row.status} label={row.statusLabel} errorMessage={row.errorMessage} />
              <div className="truncate text-[var(--text-3)]" title={row.source}>{row.source}</div>
              <div className="text-[var(--text-3)]">{formatMcpTransport(row.transport)}</div>
              <div className="min-w-0 pr-3 text-[var(--text-3)]">
                <div className="truncate" title={toolListTitle}>{formatMcpToolPreview(row)}</div>
                {toolItems.length > 0 && (
                  <div className="text-[11px] leading-4 text-[var(--text-3)]">{toolItems.length} 个已加载</div>
                )}
              </div>
              <div className="text-[var(--text-3)]">{row.lastChecked}</div>
              <div className="flex items-center justify-end gap-1.5">
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(checked) => onToggle(row.name, checked)}
                  disabled={isBuiltIn}
                  aria-label={`${row.displayName} 启用状态`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onTest(row.name)}
                  disabled={isBuiltIn || testingServerId === row.name || !row.enabled}
                  className="h-7 gap-1 px-2 text-[12px]"
                >
                  {testingServerId === row.name
                    ? <Loader2 size={13} className="animate-spin" />
                    : row.status === 'warning' ? <RefreshCw size={13} /> : <Wrench size={13} />}
                  {row.status === 'warning' ? '重试' : '测试'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedServerName(isExpanded ? null : row.name)}
                  className="h-7 gap-1 px-2 text-[12px]"
                >
                  <ListChecks size={13} />
                  {row.errorMessage ? '详情' : '工具列表'}
                  {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(row.name, row.entry)}
                  disabled={isBuiltIn}
                  className="h-7 px-2 text-[12px]"
                >
                  {isBuiltIn ? '内置' : '编辑'}
                </Button>
              </div>
            </div>
            {isExpanded && (
              <McpToolListPanel
                serviceName={row.displayName}
                items={toolItems}
                errorMessage={row.errorMessage}
                retrying={testingServerId === row.name}
                onRetry={() => onTest(row.name)}
                readOnly={isBuiltIn}
                onToggleTool={(originalToolName, nextEnabled) =>
                  onToggleTool(row.name, originalToolName, nextEnabled)}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

function McpToolListPanel({
  serviceName,
  items,
  errorMessage,
  retrying,
  onRetry,
  readOnly = false,
  onToggleTool,
}: {
  serviceName: string
  items: McpToolDisplayItem[]
  errorMessage?: string
  retrying: boolean
  onRetry: () => void
  readOnly?: boolean
  onToggleTool: (originalToolName: string, nextEnabled: boolean) => void
}) {
  return (
    <div className="border-b border-[var(--border)] bg-[var(--background)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-[var(--text-2)]">
          <ListChecks size={14} className="shrink-0 text-[var(--text-3)]" />
          <span className="truncate" title={serviceName}>{serviceName} 工具列表</span>
        </div>
        <div className="shrink-0 text-[11px] text-[var(--text-3)]">{items.length} 个已加载</div>
      </div>

      {errorMessage && (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-[8px] border border-[#ffd6a3] bg-[#fff8ef] px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-[#a35b00]">
              <CircleAlert size={13} />
              连接错误
            </div>
            <div className="mt-1 break-words text-[12px] leading-5 text-[#7c4a03]">{errorMessage}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            className="h-7 shrink-0 gap-1 px-2 text-[12px] text-[var(--lume-warning)] hover:bg-[color:color-mix(in_oklab,var(--lume-warning)_10%,var(--surface-1))]"
          >
            {retrying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            重试
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="mt-3 h-10 rounded-[8px] border border-dashed border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[12px] text-[var(--text-3)]">
          暂无已加载工具
        </div>
      ) : (
        <div className="mt-2 divide-y divide-[var(--border)]">
          {items.map((item, index) => (
            <div key={`${item.wrapperName}-${index}`} className="grid min-h-12 grid-cols-[minmax(180px,1fr)_minmax(220px,1.2fr)_90px] items-center gap-4 py-2">
              <div className="min-w-0">
                <div className={cn(
                  'truncate text-[13px] font-medium',
                  item.enabled ? 'text-[var(--text-1)]' : 'text-[var(--text-3)]'
                )} title={item.label}>
                  {item.label}
                </div>
                {item.description && (
                  <div className="truncate text-[11px] leading-4 text-[var(--text-3)]" title={item.description}>
                    {item.description}
                  </div>
                )}
              </div>
              <code className="truncate rounded-[6px] bg-[var(--surface-1)] px-2 py-1 text-[11px] text-[var(--text-3)]" title={item.wrapperName}>
                {item.wrapperName}
              </code>
              <div className="flex items-center justify-end gap-2 text-[11px] text-[var(--text-3)]">
                <span>{item.enabled ? '启用' : '停用'}</span>
                <Switch
                  checked={item.enabled}
                  onCheckedChange={(checked) => onToggleTool(item.originalName, checked)}
                  disabled={readOnly}
                  aria-label={`${item.label} 启用状态`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusPill({
  status,
  label,
  errorMessage,
}: {
  status: McpUiStatus
  label: string
  errorMessage?: string
}) {
  const meta = {
    connected: { color: 'bg-[#20c872]', text: 'text-[var(--text-3)]' },
    connecting: { color: 'bg-[#4f7df3]', text: 'text-[var(--text-3)]' },
    warning: { color: 'bg-[#ff9d2e]', text: 'text-[var(--text-3)]' },
    disconnected: { color: 'bg-[#a3aabc]', text: 'text-[var(--text-3)]' },
  }[status]

  return (
    <div className={cn('flex items-center gap-2 text-[12px] font-medium', meta.text)} title={errorMessage}>
      <span className={cn('size-1.5 rounded-full', meta.color)} />
      {label}
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
      iconClassName: 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]',
    },
    {
      label: '已连接',
      value: String(connectedCount),
      icon: CheckCircle2,
      iconClassName: 'bg-[color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]',
    },
    {
      label: '异常',
      value: String(warningCount),
      icon: CircleAlert,
      iconClassName: warningCount > 0 ? 'bg-[color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] text-[var(--lume-warning)]' : 'bg-[var(--surface-2)] text-[var(--text-3)]',
    },
    {
      label: '最近扫描',
      value: lastScan,
      icon: Clock3,
      iconClassName: 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]',
    },
  ]

  return (
    <section className="lume-panel grid h-[78px] grid-cols-4 overflow-hidden">
      {stats.map((stat, index) => {
        const Icon = stat.icon

        return (
          <div key={stat.label} className={cn('flex items-center gap-4 px-5', index > 0 && 'border-l border-[var(--border)]')}>
            <div className={cn('flex size-12 shrink-0 items-center justify-center rounded-full', stat.iconClassName)}>
              <Icon size={24} strokeWidth={1.85} />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-4 text-[var(--text-2)]">{stat.label}</div>
              <div className="mt-1 truncate text-[20px] font-semibold leading-6 text-[var(--text-1)]">{stat.value}</div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function attachServerIcons(rows: McpServerRow[]): McpTableRow[] {
  return rows.map((row) => {
    const lowerName = row.name.toLowerCase()
    const Icon = getServerIcon(lowerName)
    const iconClassName = getServerIconClass(lowerName)
    return {
      ...row,
      Icon,
      iconClassName,
    }
  })
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
  return 'text-[var(--brand)]'
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

  const [draft, setDraft] = React.useState<McpServerDraft>(() => createMcpServerDraft(server))
  const [saving, setSaving] = React.useState(false)

  const updateDraft = (patch: Partial<McpServerDraft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  const canSubmit = () => {
    if (!draft.name.trim()) return false
    if (draft.transport === 'stdio' && !draft.command.trim()) return false
    if (draft.transport !== 'stdio' && !draft.url.trim()) return false
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit()) return

    setSaving(true)
    try {
      const newConfig = buildMcpConfigAfterSave(existingConfig, server?.name ?? null, draft)
      await saveMcpConfig(workspaceSlug, newConfig)
      toast.success(isEdit ? 'MCP 服务已保存' : 'MCP 服务已创建')
      onSaved()
    } catch (error) {
      console.error('[MCP 表单] 保存失败:', error)
      toast.error('保存 MCP 服务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="lume-panel p-5">
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
          <Input
            value={draft.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
            placeholder="例如: github-mcp"
            disabled={isEdit}
            className="h-8 text-[13px]"
          />
        </FormField>

        <FormField label="传输类型">
          <Select value={draft.transport} onValueChange={(value) => updateDraft({ transport: value as McpServerDraft['transport'] })}>
            <SelectTrigger className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MCP_TRANSPORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        {draft.transport === 'stdio' ? (
          <>
            <FormField label="命令">
              <Input value={draft.command} onChange={(e) => updateDraft({ command: e.target.value })} placeholder="例如: npx" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="参数" desc="多个参数用逗号分隔">
              <Input value={draft.argsText} onChange={(e) => updateDraft({ argsText: e.target.value })} placeholder="-y, @modelcontextprotocol/server-github" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="环境变量" desc="每行一个，格式: KEY=VALUE">
              <Textarea value={draft.envText} onChange={(e) => updateDraft({ envText: e.target.value })} placeholder={"GITHUB_TOKEN=ghp_xxx\nDEBUG=true"} rows={3} className="resize-y text-[13px] font-mono" />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="URL">
              <Input value={draft.url} onChange={(e) => updateDraft({ url: e.target.value })} placeholder="http://localhost:3000/mcp" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="请求头" desc="每行一个，格式: Key: Value">
              <Textarea value={draft.headersText} onChange={(e) => updateDraft({ headersText: e.target.value })} placeholder={"Authorization: Bearer xxx"} rows={3} className="resize-y text-[13px] font-mono" />
            </FormField>
          </>
        )}

        <Separator />

        <div className="flex items-center justify-between px-1">
          <div>
            <Label className="text-[13px]">启用此服务器</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">开启后在 Agent 会话中加载</p>
          </div>
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => updateDraft({ enabled })} />
        </div>

        {isEdit && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleDeleteFromForm(workspaceSlug, existingConfig, draft.name, onSaved)}
            className="h-9 gap-2 border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] text-[var(--lume-danger)] hover:bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--surface-1))] hover:text-[var(--lume-danger)]"
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
  await saveMcpConfig(workspaceSlug, { servers: nextServers })
  toast.success('MCP 服务已删除')
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
