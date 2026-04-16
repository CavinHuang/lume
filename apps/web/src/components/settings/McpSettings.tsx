/**
 * McpSettings - 工作区 MCP 服务器管理
 *
 * 通过 agent:get-mcp-config / agent:save-mcp-config 管理当前工作区的 MCP 配置。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Plus, Plug, Pencil, Trash2, Loader2, ArrowLeft } from 'lucide-react'
import { sidecarCall } from '@/lib/desktop-api'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from '@lume/shared'

type ViewMode = 'list' | 'create' | 'edit'

interface EditingServer {
  name: string
  entry: McpServerEntry
}

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio（命令行）' },
  { value: 'http', label: 'HTTP（Streamable HTTP）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
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
  const [loading, setLoading] = React.useState(true)
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [editingServer, setEditingServer] = React.useState<EditingServer | null>(null)

  const loadConfig = React.useCallback(async () => {
    if (!workspaceSlug) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const result = await sidecarCall<WorkspaceMcpConfig>('agent:get-mcp-config', { workspaceSlug })
      setConfig(result ?? { servers: {} })
    } catch (error) {
      console.error('[MCP 设置] 加载失败:', error)
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => { loadConfig() }, [loadConfig])

  const handleDelete = async (name: string) => {
    if (!workspaceSlug) return
    if (!confirm(`确定删除 MCP 服务器「${name}」？`)) return
    try {
      const newServers = { ...config.servers }
      delete newServers[name]
      const newConfig: WorkspaceMcpConfig = { servers: newServers }
      await sidecarCall('agent:save-mcp-config', { workspaceSlug, config: newConfig })
      setConfig(newConfig)
    } catch (error) {
      console.error('[MCP 设置] 删除失败:', error)
    }
  }

  const handleToggle = async (name: string) => {
    if (!workspaceSlug) return
    try {
      const entry = config.servers[name]
      if (!entry) return
      const newConfig: WorkspaceMcpConfig = {
        servers: {
          ...config.servers,
          [name]: { ...entry, enabled: !entry.enabled },
        },
      }
      await sidecarCall('agent:save-mcp-config', { workspaceSlug, config: newConfig })
      setConfig(newConfig)
    } catch (error) {
      console.error('[MCP 设置] 切换状态失败:', error)
    }
  }

  const handleFormSaved = () => {
    setViewMode('list')
    setEditingServer(null)
    loadConfig()
  }

  if (!workspaceSlug) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Plug size={24} className="mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-[13px] text-muted-foreground">尚未选择工作区</p>
          <p className="text-[11px] text-muted-foreground/60 mt-1">
            请先在左侧边栏或 AgentHeader 切换/创建工作区
          </p>
        </div>
      </div>
    )
  }

  if (viewMode === 'create' || viewMode === 'edit') {
    return (
      <div className="p-6">
        <McpServerForm
          workspaceSlug={workspaceSlug}
          server={editingServer}
          existingConfig={config}
          onSaved={handleFormSaved}
          onCancel={() => { setViewMode('list'); setEditingServer(null) }}
        />
      </div>
    )
  }

  const serverEntries = Object.entries(config.servers ?? {})

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">MCP 服务器</h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            工作区「{workspace?.name ?? workspaceSlug}」· Model Context Protocol
          </p>
        </div>
        <Button size="sm" onClick={() => setViewMode('create')}>
          <Plus size={13} />
          添加服务器
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-[13px]">
          <Loader2 size={14} className="animate-spin" />加载中...
        </div>
      ) : serverEntries.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Plug size={24} className="mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-[13px] text-muted-foreground">暂无 MCP 服务器</p>
          <p className="text-[11px] text-muted-foreground/60 mt-1">点击「添加服务器」开始配置</p>
        </div>
      ) : (
        <div className="space-y-2">
          {serverEntries.map(([name, entry]) => (
            <div
              key={name}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border hover:bg-muted/30 transition-colors group"
            >
              <Plug size={16} className="text-blue-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{name}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  {entry.type === 'stdio' ? entry.command : entry.url}
                </p>
              </div>
              <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">
                {entry.type}
              </span>
              <button
                onClick={() => { setEditingServer({ name, entry }); setViewMode('edit') }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => handleDelete(name)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
              <Switch checked={entry.enabled} onCheckedChange={() => handleToggle(name)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
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
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={onCancel}>
          <ArrowLeft size={16} />
        </Button>
        <h3 className="text-[15px] font-semibold flex-1">
          {isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        </h3>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>取消</Button>
        <Button size="sm" type="submit" disabled={saving || !canSubmit()}>
          {saving && <Loader2 size={13} className="animate-spin" />}
          {isEdit ? '保存' : '创建'}
        </Button>
      </div>

      <div className="space-y-4">
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
              <Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={"GITHUB_TOKEN=ghp_xxx\nDEBUG=true"} rows={3} className="text-[13px] font-mono resize-y" />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000/mcp" className="h-8 text-[13px]" />
            </FormField>
            <FormField label="请求头" desc="每行一个，格式: Key: Value">
              <Textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder={"Authorization: Bearer xxx"} rows={3} className="text-[13px] font-mono resize-y" />
            </FormField>
          </>
        )}

        <Separator />

        {/* 启用开关 */}
        <div className="flex items-center justify-between px-1">
          <div>
            <Label className="text-[13px]">启用此服务器</Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">开启后在 Agent 会话中加载</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
    </form>
  )
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
