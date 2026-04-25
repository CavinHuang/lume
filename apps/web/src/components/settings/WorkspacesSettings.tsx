import * as React from 'react'
import {
  Box,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { AgentWorkspace } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { Switch } from '@/components/ui/switch'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'

const WORKSPACE_ACCENTS = [
  'from-[#6d5cff] to-[#9d86ff]',
  'from-[#4f8cff] to-[#72b7ff]',
  'from-[#38d8a1] to-[#5ad7c5]',
  'from-[#f4aa3d] to-[#ffc464]',
]

const WORKSPACE_DIRS = [
  { label: '会话数据', path: 'chats' },
  { label: '附件目录', path: 'files' },
  { label: '自动化任务', path: 'agents' },
  { label: '导出目录', path: 'exports' },
]

export function WorkspacesSettings() {
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState<string | null>(currentWorkspaceId)
  const [query, setQuery] = React.useState('')
  const [workspaceName, setWorkspaceName] = React.useState('')
  const [workspaceDescription, setWorkspaceDescription] = React.useState('用于产品设计、研发协作与本地 AI 工作流管理')
  const [rootPath, setRootPath] = React.useState('')
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = React.useState(false)
  const [openOnStart, setOpenOnStart] = React.useState(true)
  const [preserveLayout, setPreserveLayout] = React.useState(true)
  const [jumpToSavedWorkspace, setJumpToSavedWorkspace] = React.useState(true)

  const selectedWorkspace = React.useMemo(
    () => workspaces.find((item) => item.id === selectedWorkspaceId) ?? workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, selectedWorkspaceId, workspaces],
  )
  const defaultWorkspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )

  React.useEffect(() => {
    if (!selectedWorkspaceId || !workspaces.some((item) => item.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(currentWorkspaceId ?? workspaces[0]?.id ?? null)
    }
  }, [currentWorkspaceId, selectedWorkspaceId, workspaces])

  React.useEffect(() => {
    setWorkspaceName(selectedWorkspace?.name ?? '')
  }, [selectedWorkspace?.id, selectedWorkspace?.name])

  React.useEffect(() => {
    let cancelled = false

    async function loadWorkspacePath() {
      if (!selectedWorkspace?.slug) {
        setRootPath('')
        return
      }

      try {
        const path = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH, {
          workspaceSlug: selectedWorkspace.slug,
        })
        if (!cancelled) setRootPath(path)
      } catch (error) {
        console.error('[WorkspacesSettings] 获取工作区路径失败:', error)
        if (!cancelled) setRootPath(`~/Documents/Lume/${selectedWorkspace.slug}`)
      }
    }

    void loadWorkspacePath()

    return () => {
      cancelled = true
    }
  }, [selectedWorkspace?.slug])

  const filteredWorkspaces = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return workspaces
    return workspaces.filter((workspace) => {
      return (
        workspace.name.toLowerCase().includes(normalizedQuery) ||
        workspace.slug.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [query, workspaces])

  const handleSave = async () => {
    if (!selectedWorkspace) return

    const nextName = workspaceName.trim()
    if (!nextName) {
      toast.error('工作区名称不能为空')
      return
    }

    try {
      const updated = await sidecarCall<AgentWorkspace>(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, {
        id: selectedWorkspace.id,
        name: nextName,
      })
      setWorkspaces((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      toast.success('已保存工作区设置')
    } catch (error) {
      console.error('[WorkspacesSettings] 保存工作区失败:', error)
      toast.error('保存失败')
    }
  }

  const handleDelete = async () => {
    if (!selectedWorkspace) return

    if (workspaces.length <= 1) {
      toast.error('至少保留一个工作区')
      return
    }

    if (!confirm(`确认删除工作区「${selectedWorkspace.name}」？`)) return

    try {
      await sidecarCall(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, { id: selectedWorkspace.id })
      const nextWorkspaces = workspaces.filter((item) => item.id !== selectedWorkspace.id)
      const nextSelected = nextWorkspaces[0] ?? null
      setWorkspaces(nextWorkspaces)
      setSelectedWorkspaceId(nextSelected?.id ?? null)
      if (currentWorkspaceId === selectedWorkspace.id) {
        setCurrentWorkspaceId(nextSelected?.id ?? null)
      }
      toast.success('已删除工作区')
    } catch (error) {
      console.error('[WorkspacesSettings] 删除工作区失败:', error)
      toast.error('删除失败')
    }
  }

  const handleOpenResources = async (path = '') => {
    if (!selectedWorkspace) return

    try {
      await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, {
        workspaceSlug: selectedWorkspace.slug,
        path,
      })
    } catch (error) {
      console.error('[WorkspacesSettings] 打开目录失败:', error)
      toast.error('打开目录失败')
    }
  }

  if (!selectedWorkspace) {
    return (
      <section className="rounded-[10px] border border-border bg-white p-10 text-center shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="mx-auto flex size-12 items-center justify-center rounded-[12px] bg-[#f0efff] text-[#625bff]">
          <Box size={22} />
        </div>
        <h3 className="mt-4 text-[16px] font-semibold text-[#161827]">暂无工作区</h3>
        <p className="mt-2 text-[13px] text-[#697089]">创建工作区后即可管理本地目录、默认行为和工作流边界。</p>
        <button
          type="button"
          onClick={() => setCreateWorkspaceOpen(true)}
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-[8px] bg-[#625bff] px-4 text-[13px] font-medium text-white"
        >
          <Plus size={15} />
          新建工作区
        </button>
        <CreateWorkspaceDialog
          open={createWorkspaceOpen}
          onOpenChange={setCreateWorkspaceOpen}
          onCreated={(workspace) => {
            setWorkspaces((prev) => [...prev, workspace])
            setCurrentWorkspaceId(workspace.id)
            setSelectedWorkspaceId(workspace.id)
          }}
        />
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <WorkspaceStats
        workspaceCount={workspaces.length}
        defaultWorkspaceName={defaultWorkspace?.name ?? '未设置'}
        lastOpenedLabel={formatRelativeDay(selectedWorkspace.updatedAt)}
      />

      <div className="grid grid-cols-[minmax(0,438px)_minmax(0,1fr)] gap-4">
        <div className="space-y-4">
          <section className="rounded-[10px] border border-border bg-white p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[17px] font-semibold leading-6 text-[#18203a]">工作区列表</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreateWorkspaceOpen(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-border bg-white px-3 text-[12px] font-medium text-[#44506a] shadow-[0_1px_1px_rgba(20,24,40,0.02)] hover:bg-[#f8f9fc]"
                >
                  <Plus size={14} />
                  新建工作区
                </button>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-[7px] border border-border bg-white text-[#59627a] hover:bg-[#f8f9fc]"
                  aria-label="更多工作区操作"
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            </div>

            <label className="mb-3 flex h-9 items-center gap-2 rounded-[8px] border border-border bg-white px-3 text-[#8b93a6]">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索工作区"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[#20263a] outline-none placeholder:text-[#97a0b5]"
              />
            </label>

            <div className="space-y-1">
              {filteredWorkspaces.map((workspace, index) => (
                <WorkspaceListItem
                  key={workspace.id}
                  workspace={workspace}
                  active={workspace.id === selectedWorkspace.id}
                  isDefault={workspace.id === currentWorkspaceId}
                  accentClass={WORKSPACE_ACCENTS[index % WORKSPACE_ACCENTS.length]}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                />
              ))}
            </div>
          </section>

          <section className="rounded-[10px] border border-border bg-white p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
            <h3 className="mb-3 text-[17px] font-semibold leading-6 text-[#18203a]">本地目录</h3>
            <div className="overflow-hidden rounded-[8px] border border-border">
              {WORKSPACE_DIRS.map((item, index) => (
                <div
                  key={item.path}
                  className={cn(
                    'grid h-11 grid-cols-[100px_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 text-[12px]',
                    index > 0 && 'border-t border-border'
                  )}
                >
                  <div className="flex items-center gap-2 font-medium text-[#536079]">
                    <Folder size={15} className="text-[#74809a]" />
                    {item.label}
                  </div>
                  <div className="truncate font-mono text-[11px] text-[#7d879d]">
                    {compactPath(rootPath, item.path)}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleOpenResources(item.path)}
                    className="h-7 rounded-[6px] border border-border bg-white px-3 text-[12px] font-medium text-[#45516d] hover:bg-[#f8f9fc]"
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="h-7 rounded-[6px] border border-border bg-white px-3 text-[12px] font-medium text-[#45516d] hover:bg-[#f8f9fc]"
                  >
                    更改
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="rounded-[10px] border border-border bg-white p-5 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
          <h3 className="mb-5 text-[17px] font-semibold leading-6 text-[#18203a]">工作区概览</h3>
          <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-6">
            <div className="space-y-4">
              <div className="flex size-[106px] items-center justify-center rounded-[12px] bg-gradient-to-br from-[#6d5cff] to-[#9b84ff] text-white shadow-[0_12px_28px_rgba(98,91,255,0.24)]">
                <Box size={58} strokeWidth={1.9} />
              </div>
              <button
                type="button"
                className="h-9 w-full rounded-[7px] border border-border bg-white text-[12px] font-medium text-[#52607a] hover:bg-[#f8f9fc]"
              >
                更换图标
              </button>
            </div>

            <div className="space-y-4">
              <WorkspaceField label="工作区名称">
                <input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  className="h-10 w-full rounded-[8px] border border-border bg-white px-3 text-[13px] font-medium text-[#273049] outline-none focus:border-[#9d8cff] focus:ring-3 focus:ring-[#625bff]/10"
                />
              </WorkspaceField>
              <WorkspaceField label="本地路径">
                <div className="grid grid-cols-[minmax(0,1fr)_76px] gap-2">
                  <input
                    value={rootPath || `~/Documents/Lume/${selectedWorkspace.slug}`}
                    readOnly
                    className="h-10 w-full rounded-[8px] border border-border bg-white px-3 text-[13px] text-[#43506b] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleOpenResources()}
                    className="h-10 rounded-[8px] border border-border bg-white text-[13px] font-medium text-[#33405c] hover:bg-[#f8f9fc]"
                  >
                    打开目录
                  </button>
                </div>
              </WorkspaceField>
              <WorkspaceField label="工作区描述">
                <input
                  value={workspaceDescription}
                  onChange={(event) => setWorkspaceDescription(event.target.value)}
                  className="h-10 w-full rounded-[8px] border border-border bg-white px-3 text-[13px] text-[#273049] outline-none focus:border-[#9d8cff] focus:ring-3 focus:ring-[#625bff]/10"
                />
              </WorkspaceField>
            </div>
          </div>

          <div className="my-5 h-px bg-border" />

          <h3 className="text-[17px] font-semibold leading-6 text-[#18203a]">工作区偏好</h3>
          <p className="mt-1 text-[12px] leading-5 text-[#778096]">应用您的偏好以进入此工作区</p>
          <div className="mt-5 space-y-4">
            <PreferenceRow label="在启动应用时显示会话">
              <LumeSwitch checked={openOnStart} onCheckedChange={setOpenOnStart} />
            </PreferenceRow>
            <PreferenceRow label="独立保存窗口布局">
              <LumeSwitch checked={preserveLayout} onCheckedChange={setPreserveLayout} />
            </PreferenceRow>
            <PreferenceRow label="默认跳转到保存的工作区">
              <LumeSwitch checked={jumpToSavedWorkspace} onCheckedChange={setJumpToSavedWorkspace} />
            </PreferenceRow>
            <WorkspaceField label="启动时">
              <SelectLike value="打开上次工作区" />
            </WorkspaceField>
            <WorkspaceField label="退出时">
              <SelectLike value="记住当前状态" />
            </WorkspaceField>
          </div>

          <div className="mt-5 rounded-[8px] bg-[#edf7ff] px-3 py-2 text-[12px] font-medium text-[#586982]">
            <span className="mr-2 inline-flex size-4 items-center justify-center rounded-full border border-[#4c8dff] text-[11px] text-[#4c7dff]">i</span>
            这些设置仅作用于当前工作区。
          </div>
        </section>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_152px_minmax(360px,420px)] gap-3 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => setWorkspaceName(selectedWorkspace.name)}
          className="h-10 rounded-[8px] border border-border bg-white text-[13px] font-medium text-[#35405a] hover:bg-[#f8f9fc]"
        >
          取消
        </button>
        <button
          type="button"
          className="h-10 rounded-[8px] border border-border bg-white text-[13px] font-medium text-[#35405a] hover:bg-[#f8f9fc]"
        >
          导出工作区配置
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          className="h-10 rounded-[8px] bg-[#625bff] text-[13px] font-medium text-white shadow-[0_8px_20px_rgba(98,91,255,0.22)] hover:bg-[#554dff]"
        >
          保存更改
        </button>
        <div className="rounded-[10px] border border-[#ffb7b7] px-4 py-3">
          <div className="text-[12px] font-semibold leading-4 text-[#ff5252]">危险操作</div>
          <div className="mt-2 flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="h-8 min-w-[120px] rounded-[6px] border border-[#ff5a5a] px-5 text-[12px] font-medium text-[#ff4e4e] hover:bg-[#fff5f5]"
              >
                删除工作区
              </button>
              <button
                type="button"
                onClick={() => selectedWorkspace.id === currentWorkspaceId && setCurrentWorkspaceId(null)}
                className="h-8 min-w-[128px] rounded-[6px] border border-border px-5 text-[12px] font-medium text-[#7a8498] hover:bg-[#f8f9fc]"
              >
                移除默认状态
              </button>
          </div>
        </div>
      </div>

      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={(workspace) => {
          setWorkspaces((prev) => (prev.some((item) => item.id === workspace.id) ? prev : [...prev, workspace]))
          setCurrentWorkspaceId(workspace.id)
          setSelectedWorkspaceId(workspace.id)
        }}
      />
    </div>
  )
}

function WorkspaceStats({
  workspaceCount,
  defaultWorkspaceName,
  lastOpenedLabel,
}: {
  workspaceCount: number
  defaultWorkspaceName: string
  lastOpenedLabel: string
}) {
  const stats = [
    { label: '工作区数量', value: String(workspaceCount), Icon: Box, iconClass: 'bg-[#f0efff] text-[#625bff]' },
    { label: '默认工作区', value: defaultWorkspaceName, Icon: FolderOpen, iconClass: 'bg-[#f0efff] text-[#625bff]' },
    { label: '最近打开', value: lastOpenedLabel, Icon: Clock3, iconClass: 'bg-[#eaf3ff] text-[#2f86ff]' },
    { label: '本地模式', value: '已启用', Icon: ShieldCheck, iconClass: 'bg-[#ddfae8] text-[#20b566]' },
  ]

  return (
    <section className="grid grid-cols-4 gap-3">
      {stats.map(({ label, value, Icon, iconClass }) => (
        <div
          key={label}
          className="flex h-[72px] items-center gap-4 rounded-[10px] border border-border bg-white px-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]"
        >
          <div className={cn('flex size-11 items-center justify-center rounded-full', iconClass)}>
            <Icon size={24} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-medium leading-4 text-[#788199]">{label}</div>
            <div className={cn('mt-1 truncate text-[18px] font-semibold leading-6 text-[#11172b]', label === '本地模式' && 'text-[#20b566]')}>
              {value}
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}

function WorkspaceListItem({
  workspace,
  active,
  isDefault,
  accentClass,
  onClick,
}: {
  workspace: AgentWorkspace
  active: boolean
  isDefault: boolean
  accentClass: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[58px] w-full items-center gap-3 rounded-[8px] border px-3 text-left transition-colors',
        active
          ? 'border-[#bbb4ff] bg-[#f3f1ff] shadow-[0_6px_16px_rgba(98,91,255,0.08)]'
          : 'border-transparent bg-white hover:bg-[#fafbff]'
      )}
    >
      <div className={cn('flex size-8 items-center justify-center rounded-[8px] bg-gradient-to-br text-white', accentClass)}>
        <Box size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-5 text-[#26304a]">{workspace.name}</div>
        <div className="truncate text-[12px] leading-4 text-[#8a93a8]">~/Documents/Lume/{workspace.slug}</div>
      </div>
      {isDefault && (
        <span className="rounded-[6px] bg-white px-2 py-1 text-[12px] font-medium text-[#625bff] shadow-[0_0_0_1px_rgba(98,91,255,0.14)]">
          默认
        </span>
      )}
      <ChevronRight size={16} className="text-[#758099]" />
    </button>
  )
}

function WorkspaceField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-4">
      <span className="text-[13px] font-medium text-[#667089]">{label}</span>
      {children}
    </label>
  )
}

function PreferenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-5 items-center justify-between">
      <span className="text-[13px] font-medium text-[#667089]">{label}</span>
      {children}
    </div>
  )
}

function SelectLike({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="flex h-10 w-full items-center justify-between rounded-[8px] border border-border bg-white px-3 text-[13px] font-medium text-[#495571]"
    >
      {value}
      <ChevronDown size={15} className="text-[#7b8498]" />
    </button>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      data-size="default"
      className={cn(
        'h-5 w-9 data-checked:bg-[#625bff]',
        '[&_[data-slot=switch-thumb]]:size-4 data-checked:[&_[data-slot=switch-thumb]]:translate-x-4',
        props.className,
      )}
    />
  )
}

function compactPath(rootPath: string, child: string) {
  if (!rootPath) return `~/Documents/Lume/Core/${child}`
  const normalizedRoot = rootPath.replace(/^\/Users\/[^/]+/, '~')
  return `${normalizedRoot}/${child}`
}

function formatRelativeDay(timestamp: number) {
  if (!timestamp) return '今天'
  const date = new Date(timestamp)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((startOfToday - startOfDate) / 86_400_000)

  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays} 天前`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
