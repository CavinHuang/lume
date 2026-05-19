import * as React from 'react'
import {
  FileText,
  ListFilter,
  RefreshCw,
  Search,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type {
  MemoryCitationsMode,
  MemoryRuntimeConfig,
  MemorySearchResult,
} from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  getMemoryRuntimeConfig,
  searchMemory,
  sidecarCall,
  updateMemoryRuntimeConfig,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  isMemoryToolGroupEnabled,
  setMemoryToolGroupEnabled,
  summarizeMemoryResult,
  type MemorySettingsView,
  type MemoryToolPolicyGroupId,
} from './memory-settings-state'

export function MemorySettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )
  const workspaceSlug = workspace?.slug ?? null
  const [view, setView] = React.useState<MemorySettingsView>('workspace')
  const [runtimeConfig, setRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [query, setQuery] = React.useState('设计决策 偏好 当前状态')
  const [results, setResults] = React.useState<MemorySearchResult[]>([])
  const [includeGlobal, setIncludeGlobal] = React.useState(true)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      setRuntimeConfig(await getMemoryRuntimeConfig())
    } catch (error) {
      console.error('[MemorySettings] refresh FAILED:', error)
      toast.error('读取记忆设置失败')
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name)
    try {
      await action()
    } finally {
      setBusyAction(null)
    }
  }

  const handleSearch = () => runAction('search', async () => {
    if (!workspaceSlug || !query.trim()) return
    const found = await searchMemory({
      workspaceSlug,
      query: query.trim(),
      maxResults: 12,
      includeGlobal,
    })
    setResults(found)
    if (found.length === 0) toast.message('没有找到匹配的记忆')
  })

  const handleOpenMemoryFile = (path: string) => runAction(`open-${path}`, async () => {
    if (!workspaceSlug) return
    await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, {
      workspaceSlug,
      path,
    })
  })

  const handleTogglePolicyGroup = (
    groupId: MemoryToolPolicyGroupId,
    enabled: boolean,
  ) => runAction(`policy-${groupId}`, async () => {
    if (!runtimeConfig) return
    const nextTools = setMemoryToolGroupEnabled(runtimeConfig, groupId, enabled)
    const nextConfig = await updateMemoryRuntimeConfig({ tools: nextTools })
    setRuntimeConfig(nextConfig)
    toast.success('记忆工具权限已更新')
  })

  const handleCitationsMode = (citations: MemoryCitationsMode) => runAction(`citations-${citations}`, async () => {
    const nextConfig = await updateMemoryRuntimeConfig({ citations })
    setRuntimeConfig(nextConfig)
  })

  if (!workspaceSlug) {
    return (
      <EmptyPanel title="暂无工作区" desc="创建或选择一个工作区后即可管理记忆。" />
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
              <FileText size={15} />
              {workspace.name} · Memory V2
            </div>
            <h3 className="mt-2 text-[17px] font-semibold leading-6 text-[var(--text-1)]">记忆</h3>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busyAction !== null}>
            <RefreshCw size={14} />
            刷新
          </Button>
        </div>
      </section>

      <MemoryPolicyPanel
        busyAction={busyAction}
        runtimeConfig={runtimeConfig}
        onCitationsMode={(mode) => void handleCitationsMode(mode)}
        onToggle={(groupId, enabled) => void handleTogglePolicyGroup(groupId, enabled)}
      />

      <div className="flex gap-2">
        {MEMORY_SETTINGS_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={cn(
              'inline-flex h-8 items-center rounded-[8px] border px-3 text-[13px] font-medium transition-colors',
              view === item.id
                ? 'border-[var(--brand)] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                : 'border-border bg-[var(--surface-1)] text-[var(--text-2)] hover:bg-[var(--surface-2)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === 'workspace' && (
        <WorkspaceMemoryPanel
          busyAction={busyAction}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
        />
      )}

      {view === 'items' && (
        <StructuredMemoryPanel
          busy={busyAction === 'search'}
          includeGlobal={includeGlobal}
          query={query}
          results={results}
          onIncludeGlobalChange={setIncludeGlobal}
          onQueryChange={setQuery}
          onSearch={() => void handleSearch()}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
        />
      )}
    </div>
  )
}

function MemoryPolicyPanel({
  busyAction,
  runtimeConfig,
  onCitationsMode,
  onToggle,
}: {
  busyAction: string | null
  runtimeConfig: MemoryRuntimeConfig | null
  onCitationsMode: (mode: MemoryCitationsMode) => void
  onToggle: (groupId: MemoryToolPolicyGroupId, enabled: boolean) => void
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[16px] font-semibold text-[var(--text-1)]">Agent 记忆权限</h3>
        <div className="flex rounded-[8px] border border-border bg-[var(--surface-2)] p-0.5">
          {(['auto', 'on', 'off'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={!runtimeConfig || busyAction !== null}
              onClick={() => onCitationsMode(mode)}
              className={cn(
                'h-7 rounded-[6px] px-2 text-[12px] font-medium',
                runtimeConfig?.citations === mode
                  ? 'bg-[var(--surface-1)] text-[var(--text-1)] shadow-sm'
                  : 'text-[var(--text-3)]',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {MEMORY_TOOL_POLICY_GROUPS.map((group) => {
          const checked = isMemoryToolGroupEnabled(runtimeConfig?.tools, group.id)
          return (
            <label
              key={group.id}
              className={cn(
                'flex min-h-[76px] items-center justify-between gap-3 rounded-[8px] border p-3',
                checked
                  ? 'border-[color-mix(in_oklab,var(--brand)_35%,var(--border))] bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]'
                  : 'border-border bg-[var(--surface-2)]',
              )}
            >
              <span className="min-w-0">
                <span className="text-[13px] font-semibold text-[var(--text-1)]">{group.label}</span>
                <span className="mt-1 block text-[12px] leading-5 text-[var(--text-3)]">{group.desc}</span>
              </span>
              <Switch
                checked={checked}
                disabled={!runtimeConfig || busyAction !== null}
                onCheckedChange={(value) => onToggle(group.id, value)}
              />
            </label>
          )
        })}
      </div>
    </section>
  )
}

function WorkspaceMemoryPanel({
  busyAction,
  onOpenFile,
}: {
  busyAction: string | null
  onOpenFile: (path: string) => void
}) {
  const documents = [
    { path: 'MEMORY.md', desc: '工作区长期记忆' },
    { path: 'memory', desc: '每日记忆与运行归档' },
  ]

  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="grid gap-3">
        {documents.map((doc) => (
          <div key={doc.path} className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
                <FileText size={15} />
                {doc.path}
              </div>
              <p className="mt-1 text-[12px] text-[var(--text-3)]">{doc.desc}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenFile(doc.path)} disabled={busyAction !== null}>
              打开
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

function StructuredMemoryPanel({
  busy,
  includeGlobal,
  query,
  results,
  onIncludeGlobalChange,
  onQueryChange,
  onSearch,
  onOpenFile,
}: {
  busy: boolean
  includeGlobal: boolean
  query: string
  results: MemorySearchResult[]
  onIncludeGlobalChange: (value: boolean) => void
  onQueryChange: (value: string) => void
  onSearch: () => void
  onOpenFile: (path: string) => void
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-9 min-w-[280px] flex-1 items-center gap-2 rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[var(--text-3)]">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch()
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
            placeholder="搜索偏好、决策、事实、过程"
          />
        </label>
        <label className="flex h-9 items-center gap-2 rounded-[8px] border border-border px-3 text-[13px] text-[var(--text-2)]">
          全局
          <Switch checked={includeGlobal} onCheckedChange={onIncludeGlobalChange} />
        </label>
        <Button onClick={onSearch} disabled={busy || !query.trim()} size="sm">
          <ListFilter size={14} />
          搜索
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {results.map((result) => (
          <button
            key={`${result.id}:${result.path}`}
            type="button"
            onClick={() => onOpenFile(result.path)}
            className="block w-full rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left hover:bg-[var(--surface-3)]"
          >
            <div className="text-[12px] font-medium text-[var(--text-3)]">{summarizeMemoryResult(result)}</div>
            <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-[var(--text-1)]">{result.snippet}</p>
            <div className="mt-2 truncate text-[12px] text-[var(--text-3)]">{result.citation ?? result.path}</div>
          </button>
        ))}
      </div>
    </section>
  )
}

function EmptyPanel({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-border bg-[var(--surface-1)] p-6 text-center">
      <div className="text-[15px] font-semibold text-[var(--text-1)]">{title}</div>
      <p className="mt-2 text-[13px] text-[var(--text-3)]">{desc}</p>
    </div>
  )
}
