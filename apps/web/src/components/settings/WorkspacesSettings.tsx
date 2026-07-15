import * as React from 'react'
import {
  Box,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { AgentWorkspace, LumeConfigSkillsSection, SkillCatalogItem, WorkspaceCapabilities, WorkspaceMcpConfig } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { getEffectiveLumeConfig, getMcpConfig, getSkillMarketCatalog, openFileDialog, saveMcpConfig, sidecarCall, updateSkillsConfig } from '@/lib/desktop-api'
import { Switch } from '@/components/ui/switch'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WorkspaceFileBrowser } from '@/components/file-browser/WorkspaceFileBrowser'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
type WorkspaceSettingsTab = 'overview' | 'files' | 'capabilities'

interface WorkspaceFilePreview {
  content: string
  truncated: boolean
}

const WORKSPACE_SETTINGS_TABS: Array<{ id: WorkspaceSettingsTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'files', label: '文件' },
  { id: 'capabilities', label: '能力开关' },
]

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
  const [activeTab, setActiveTab] = React.useState<WorkspaceSettingsTab>('overview')

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
      toast.error('项目名称不能为空')
      return
    }

    try {
      const updated = await sidecarCall<AgentWorkspace>(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE, {
        id: selectedWorkspace.id,
        name: nextName,
      })
      setWorkspaces((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      toast.success('已保存项目设置')
    } catch (error) {
      console.error('[WorkspacesSettings] 保存工作区失败:', error)
      toast.error('保存失败')
    }
  }

  const handleDelete = async () => {
    if (!selectedWorkspace) return

    if (!confirm(`确认移除项目「${selectedWorkspace.name}」？真实项目目录不会被删除。`)) return

    try {
      await sidecarCall(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, { id: selectedWorkspace.id, mode: 'keepHistory' })
      const nextWorkspaces = workspaces.filter((item) => item.id !== selectedWorkspace.id)
      const nextSelected = nextWorkspaces[0] ?? null
      setWorkspaces(nextWorkspaces)
      setSelectedWorkspaceId(nextSelected?.id ?? null)
      if (currentWorkspaceId === selectedWorkspace.id) {
        setCurrentWorkspaceId(null)
      }
      toast.success('已移除项目，会话已转为普通会话')
    } catch (error) {
      console.error('[WorkspacesSettings] 移除项目失败:', error)
      toast.error('移除失败')
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
      <section className="lume-panel p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-[12px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
          <Box size={22} />
        </div>
        <h3 className="mt-4 text-[16px] font-semibold text-[var(--text-1)]">暂无项目</h3>
        <p className="mt-2 text-[13px] text-[var(--text-2)]">添加项目后即可管理本地目录、默认行为和工作流边界。</p>
        <Button
                variant="ghost"
          type="button"
          onClick={() => setCreateWorkspaceOpen(true)}
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-[8px] bg-[var(--brand)] px-4 text-[13px] font-medium text-[var(--brand-foreground)]"
        >
          <Plus size={15} />
          添加项目
        </Button>
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

      <div className="lume-segmented flex items-center gap-1">
        {WORKSPACE_SETTINGS_TABS.map((item) => (
          <Button
                variant="ghost"
            key={item.id}
            type="button"
            onClick={() => setActiveTab(item.id)}
            className={cn(
              'lume-segmented-item',
              activeTab === item.id
                ? 'lume-segmented-item-active'
                : ''
            )}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <WorkspaceOverviewPanel
          currentWorkspaceId={currentWorkspaceId}
          filteredWorkspaces={filteredWorkspaces}
          handleDelete={handleDelete}
          handleOpenResources={handleOpenResources}
          handleSave={handleSave}
          jumpToSavedWorkspace={jumpToSavedWorkspace}
          openOnStart={openOnStart}
          preserveLayout={preserveLayout}
          query={query}
          rootPath={rootPath}
          selectedWorkspace={selectedWorkspace}
          setCreateWorkspaceOpen={setCreateWorkspaceOpen}
          setCurrentWorkspaceId={setCurrentWorkspaceId}
          setJumpToSavedWorkspace={setJumpToSavedWorkspace}
          setOpenOnStart={setOpenOnStart}
          setPreserveLayout={setPreserveLayout}
          setQuery={setQuery}
          setSelectedWorkspaceId={setSelectedWorkspaceId}
          setWorkspaceDescription={setWorkspaceDescription}
          setWorkspaceName={setWorkspaceName}
          workspaceDescription={workspaceDescription}
          workspaceName={workspaceName}
        />
      )}

      {activeTab === 'files' && (
        <WorkspaceFilesPanel workspace={selectedWorkspace} />
      )}

      {activeTab === 'capabilities' && (
        <WorkspaceCapabilitiesPanel workspace={selectedWorkspace} />
      )}

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

function WorkspaceOverviewPanel({
  currentWorkspaceId,
  filteredWorkspaces,
  handleDelete,
  handleOpenResources,
  handleSave,
  jumpToSavedWorkspace,
  openOnStart,
  preserveLayout,
  query,
  rootPath,
  selectedWorkspace,
  setCreateWorkspaceOpen,
  setCurrentWorkspaceId,
  setJumpToSavedWorkspace,
  setOpenOnStart,
  setPreserveLayout,
  setQuery,
  setSelectedWorkspaceId,
  setWorkspaceDescription,
  setWorkspaceName,
  workspaceDescription,
  workspaceName,
}: {
  currentWorkspaceId: string | null
  filteredWorkspaces: AgentWorkspace[]
  handleDelete: () => Promise<void>
  handleOpenResources: (path?: string) => Promise<void>
  handleSave: () => Promise<void>
  jumpToSavedWorkspace: boolean
  openOnStart: boolean
  preserveLayout: boolean
  query: string
  rootPath: string
  selectedWorkspace: AgentWorkspace
  setCreateWorkspaceOpen: (open: boolean) => void
  setCurrentWorkspaceId: (id: string | null) => void
  setJumpToSavedWorkspace: (checked: boolean) => void
  setOpenOnStart: (checked: boolean) => void
  setPreserveLayout: (checked: boolean) => void
  setQuery: (query: string) => void
  setSelectedWorkspaceId: (id: string) => void
  setWorkspaceDescription: (description: string) => void
  setWorkspaceName: (name: string) => void
  workspaceDescription: string
  workspaceName: string
}) {
  return (
    <>
      <div className="grid grid-cols-[minmax(0,438px)_minmax(0,1fr)] gap-4">
        <div className="space-y-4">
          <section className="lume-panel p-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[17px] font-semibold leading-6 text-[var(--text-1)]">项目列表</h3>
              <div className="flex items-center gap-2">
                <Button
                variant="ghost"
                  type="button"
                  onClick={() => setCreateWorkspaceOpen(true)}
                  className="lume-action-tile h-8 gap-1.5 px-3 text-[12px] shadow-none"
                >
                  <Plus size={14} />
                  添加项目
                </Button>
                <Button
                variant="ghost"
                  type="button"
                  className="lume-action-tile flex size-8 items-center justify-center p-0 shadow-none"
                  aria-label="更多项目操作"
                >
                  <MoreHorizontal size={16} />
                </Button>
              </div>
            </div>

            <label className="mb-3 flex h-9 items-center gap-2 rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[var(--text-3)]">
              <Search size={15} />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目"
                className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
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

          <section className="lume-panel p-4">
            <h3 className="mb-3 text-[17px] font-semibold leading-6 text-[var(--text-1)]">本地目录</h3>
            <div className="lume-subpanel overflow-hidden">
              {WORKSPACE_DIRS.map((item, index) => (
                <div
                  key={item.path}
                  className={cn(
                    'grid h-11 grid-cols-[100px_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 text-[12px]',
                    index > 0 && 'border-t border-border'
                  )}
                >
                  <div className="flex items-center gap-2 font-medium text-[var(--text-2)]">
                    <Folder size={15} className="text-[var(--text-3)]" />
                    {item.label}
                  </div>
                  <div className="truncate font-mono text-[11px] text-[var(--text-3)]">
                    {compactPath(rootPath, item.path)}
                  </div>
                  <Button
                variant="ghost"
                    type="button"
                    onClick={() => void handleOpenResources(item.path)}
                    className="lume-action-tile h-7 px-3 text-[12px] shadow-none"
                  >
                    打开
                  </Button>
                  <Button
                variant="ghost"
                    type="button"
                    className="lume-action-tile h-7 px-3 text-[12px] shadow-none"
                  >
                    更改
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="lume-panel p-5">
          <h3 className="mb-5 text-[17px] font-semibold leading-6 text-[var(--text-1)]">项目概览</h3>
          <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-6">
            <div className="space-y-4">
              <div className="flex size-[106px] items-center justify-center rounded-[12px] bg-gradient-to-br from-[#6d5cff] to-[#9b84ff] text-white shadow-[0_12px_28px_rgba(98,91,255,0.24)]">
                <Box size={58} strokeWidth={1.9} />
              </div>
              <Button
                variant="ghost"
                type="button"
                className="h-9 w-full rounded-[7px] border border-border bg-[var(--surface-1)] text-[12px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]"
              >
                更换图标
              </Button>
            </div>

            <div className="space-y-4">
              <WorkspaceField label="项目名称">
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  className="h-10 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[13px] font-medium text-[var(--text-1)] outline-none focus:border-[color-mix(in_oklab,var(--brand)_50%,var(--border-strong))] focus:ring-3 focus:ring-[var(--brand)]/10"
                />
              </WorkspaceField>
              <WorkspaceField label="本地路径">
                <div className="grid grid-cols-[minmax(0,1fr)_76px] gap-2">
                  <Input
                    value={rootPath || `~/Documents/Lume/${selectedWorkspace.slug}`}
                    readOnly
                    className="h-10 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-2)] outline-none"
                  />
                  <Button
                variant="ghost"
                    type="button"
                    onClick={() => void handleOpenResources()}
                    className="h-10 rounded-[8px] border border-border bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]"
                  >
                    打开目录
                  </Button>
                </div>
              </WorkspaceField>
              <WorkspaceField label="工作区描述">
                <Input
                  value={workspaceDescription}
                  onChange={(event) => setWorkspaceDescription(event.target.value)}
                  className="h-10 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none focus:border-[color-mix(in_oklab,var(--brand)_50%,var(--border-strong))] focus:ring-3 focus:ring-[var(--brand)]/10"
                />
              </WorkspaceField>
            </div>
          </div>

          <div className="my-5 h-px bg-border" />

          <h3 className="text-[17px] font-semibold leading-6 text-[var(--text-1)]">工作区偏好</h3>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">应用您的偏好以进入此工作区</p>
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

          <div className="lume-subpanel mt-5 px-3 py-2 text-[12px] font-medium text-[var(--text-2)]">
            <span className="mr-2 inline-flex size-4 items-center justify-center rounded-full border border-[var(--brand)] text-[11px] text-[var(--brand)]">i</span>
            这些设置仅作用于当前工作区。
          </div>
        </section>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_152px_minmax(360px,420px)] gap-3 border-t border-border pt-4">
        <Button
                variant="ghost"
          type="button"
          onClick={() => setWorkspaceName(selectedWorkspace.name)}
          className="h-10 rounded-[8px] border border-border bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]"
        >
          取消
        </Button>
        <Button
                variant="ghost"
          type="button"
          className="h-10 rounded-[8px] border border-border bg-[var(--surface-1)] text-[13px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]"
        >
          导出工作区配置
        </Button>
        <Button
                variant="ghost"
          type="button"
          onClick={() => void handleSave()}
          className="h-10 rounded-[8px] bg-[var(--brand)] text-[13px] font-medium text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))]"
        >
          保存更改
        </Button>
        <div className="lume-subpanel border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] px-4 py-3">
          <div className="text-[12px] font-semibold leading-4 text-[var(--lume-danger)]">危险操作</div>
          <div className="mt-2 flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                type="button"
                onClick={() => void handleDelete()}
                className="h-8 min-w-[120px] rounded-[6px] border border-[color:color-mix(in_oklab,var(--lume-danger)_38%,var(--border))] px-5 text-[12px] font-medium text-[var(--lume-danger)] hover:bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--surface-1))]"
              >
                移除项目
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => selectedWorkspace.id === currentWorkspaceId && setCurrentWorkspaceId(null)}
                className="h-8 min-w-[128px] rounded-[6px] border border-border px-5 text-[12px] font-medium text-[var(--text-3)] hover:bg-[var(--surface-2)]"
              >
                移除默认状态
              </Button>
          </div>
        </div>
      </div>

    </>
  )
}

function WorkspaceFilesPanel({ workspace }: { workspace: AgentWorkspace }) {
  const [selectedPath, setSelectedPath] = React.useState('')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [preview, setPreview] = React.useState<WorkspaceFilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)

  const refreshFiles = () => setRefreshToken((value) => value + 1)

  const handleOpenFile = async (path: string) => {
    setSelectedPath(path)
    setPreviewLoading(true)
    try {
      const nextPreview = await sidecarCall<WorkspaceFilePreview>(AGENT_IPC_CHANNELS.READ_WORKSPACE_ROOT_FILE, {
        workspaceSlug: workspace.slug,
        path,
      })
      setPreview(nextPreview)
    } catch (error) {
      console.error('[WorkspacesSettings] 预览工作区文件失败:', error)
      setPreview(null)
      toast.error('预览文件失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  const runFileAction = async (action: string, task: () => Promise<void>) => {
    setBusyAction(action)
    try {
      await task()
      refreshFiles()
    } finally {
      setBusyAction(null)
    }
  }

  const handleUpload = () => runFileAction('upload', async () => {
    const result = await openFileDialog()
    if (result.files.length === 0) return
    await sidecarCall(AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE_ROOT, {
      workspaceSlug: workspace.slug,
      files: result.files.map((file) => ({ filename: file.filename, sourcePath: file.sourcePath })),
    })
    toast.success(`已保存 ${result.files.length} 个文件到工作区`)
  })

  const handleOpenExternal = () => runFileAction('open', async () => {
    if (!selectedPath) return
    await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_ROOT_FILE, {
      workspaceSlug: workspace.slug,
      path: selectedPath,
    })
  })

  const handleRename = () => runFileAction('rename', async () => {
    if (!selectedPath) return
    const fallbackName = selectedPath.split('/').filter(Boolean).pop() ?? selectedPath
    const newName = window.prompt('重命名为', fallbackName)?.trim()
    if (!newName || newName === fallbackName) return
    await sidecarCall(AGENT_IPC_CHANNELS.RENAME_WORKSPACE_ROOT_FILE, {
      workspaceSlug: workspace.slug,
      path: selectedPath,
      newName,
    })
    setSelectedPath('')
    setPreview(null)
    toast.success('已重命名')
  })

  const handleMove = () => runFileAction('move', async () => {
    if (!selectedPath) return
    const targetDir = window.prompt('移动到目录（使用 . 表示根目录）', '.')?.trim()
    if (targetDir === undefined) return
    await sidecarCall(AGENT_IPC_CHANNELS.MOVE_WORKSPACE_ROOT_FILE, {
      workspaceSlug: workspace.slug,
      path: selectedPath,
      targetDir,
    })
    setSelectedPath('')
    setPreview(null)
    toast.success('已移动')
  })

  const handleDeleteFile = () => runFileAction('delete', async () => {
    if (!selectedPath) return
    if (!window.confirm(`确认删除「${selectedPath}」？`)) return
    await sidecarCall(AGENT_IPC_CHANNELS.DELETE_WORKSPACE_ROOT_FILE, {
      workspaceSlug: workspace.slug,
      path: selectedPath,
    })
    setSelectedPath('')
    setPreview(null)
    toast.success('已删除')
  })

  return (
    <section className="lume-panel grid min-h-[560px] grid-cols-[minmax(280px,360px)_minmax(0,1fr)] overflow-hidden">
      <div className="min-h-0 border-r border-border">
        <div className="border-b border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-[var(--text-1)]">工作区文件</h3>
              <p className="mt-1 truncate text-[12px] text-[var(--text-3)]">{workspace.name}</p>
            </div>
            <Button
                variant="ghost"
              type="button"
              onClick={() => void handleUpload()}
              className="lume-action-tile h-8 gap-1.5 px-3 text-[12px] shadow-none"
            >
              {busyAction === 'upload' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              上传
            </Button>
          </div>
          <label className="lume-action-tile mt-3 flex h-9 justify-start px-3 text-[var(--text-3)] shadow-none">
            <Search size={15} />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="筛选文件"
              className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
            />
          </label>
        </div>
        <WorkspaceFileBrowser
          workspaceSlug={workspace.slug}
          listChannel={AGENT_IPC_CHANNELS.LIST_WORKSPACE_ROOT_DIRECTORY}
          refreshToken={refreshToken}
          selectedPath={selectedPath}
          onOpenFile={(path) => void handleOpenFile(path)}
          showHeader={false}
          searchQuery={searchQuery}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex min-h-[64px] items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-[var(--text-1)]">{selectedPath || '选择文件查看预览'}</div>
            <div className="mt-1 text-[12px] text-[var(--text-3)]">第一版支持预览、打开、重命名、移动、删除与上传，不内置编辑器。</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <IconButton disabled={!selectedPath || busyAction === 'open'} title="系统打开" onClick={() => void handleOpenExternal()}>
              <ExternalLink size={15} />
            </IconButton>
            <IconButton disabled={!selectedPath || busyAction === 'rename'} title="重命名" onClick={() => void handleRename()}>
              <Pencil size={15} />
            </IconButton>
            <IconButton disabled={!selectedPath || busyAction === 'move'} title="移动" onClick={() => void handleMove()}>
              <MoveRight size={15} />
            </IconButton>
            <IconButton disabled={!selectedPath || busyAction === 'delete'} title="删除" tone="danger" onClick={() => void handleDeleteFile()}>
              <Trash2 size={15} />
            </IconButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {previewLoading ? (
            <PreviewEmpty icon={<Loader2 size={20} className="animate-spin" />} label="正在加载预览..." />
          ) : preview ? (
            <div className="space-y-3">
              {preview.truncated && (
                <div className="rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-warning)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-warning)_8%,var(--surface-1))] px-3 py-2 text-[12px] text-[var(--lume-warning)]">
                  文件内容过长，当前仅显示前 512 KB。
                </div>
              )}
              <pre className="min-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-[var(--surface-2)] p-4 font-mono text-[12px] leading-6 text-[var(--text-1)]">
                {preview.content}
              </pre>
            </div>
          ) : (
            <PreviewEmpty icon={<FileText size={22} />} label="从左侧选择一个文件开始预览" />
          )}
        </div>
      </div>
    </section>
  )
}

function WorkspaceCapabilitiesPanel({ workspace }: { workspace: AgentWorkspace }) {
  const [capabilities, setCapabilities] = React.useState<WorkspaceCapabilities | null>(null)
  const [mcpConfig, setMcpConfig] = React.useState<WorkspaceMcpConfig | null>(null)
  const [skills, setSkills] = React.useState<SkillCatalogItem[]>([])
  const [disabledSkills, setDisabledSkills] = React.useState<Set<string>>(new Set())
  const [loading, setLoading] = React.useState(true)
  const [busyKey, setBusyKey] = React.useState<string | null>(null)
  const [mcpSearchQuery, setMcpSearchQuery] = React.useState('')
  const [skillSearchQuery, setSkillSearchQuery] = React.useState('')

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [nextCapabilities, nextMcpConfig, nextSkillsCatalog, nextConfig] = await Promise.all([
        sidecarCall<WorkspaceCapabilities>(AGENT_IPC_CHANNELS.GET_CAPABILITIES, { workspaceSlug: workspace.slug }),
        getMcpConfig(workspace.slug),
        getSkillMarketCatalog(workspace.slug, true),
        getEffectiveLumeConfig(workspace.slug),
      ])
      const nextDisabledSkills = new Set(nextConfig.skills?.disabled ?? [])
      setCapabilities(nextCapabilities)
      setMcpConfig(nextMcpConfig)
      setSkills(nextSkillsCatalog.items.filter((item) => item.installState === 'installed' || nextDisabledSkills.has(item.slug)))
      setDisabledSkills(nextDisabledSkills)
    } catch (error) {
      console.error('[WorkspacesSettings] 加载能力开关失败:', error)
      toast.error('加载能力开关失败')
    } finally {
      setLoading(false)
    }
  }, [workspace.slug])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const handleToggleMcpServer = async (serverName: string, enabled: boolean) => {
    if (!mcpConfig) return
    setBusyKey(`mcp:${serverName}`)
    try {
      const entry = mcpConfig.servers[serverName]
      if (!entry) return
      await saveMcpConfig(workspace.slug, {
        servers: {
          ...mcpConfig.servers,
          [serverName]: { ...entry, enabled },
        },
      })
      toast.success(enabled ? 'MCP 服务已启用' : 'MCP 服务已关闭')
      await refresh()
    } catch (error) {
      console.error('[WorkspacesSettings] 保存 MCP 开关失败:', error)
      toast.error('保存 MCP 开关失败')
    } finally {
      setBusyKey(null)
    }
  }

  const handleToggleSkill = async (skillSlug: string, enabled: boolean) => {
    setBusyKey(`skill:${skillSlug}`)
    try {
      const nextDisabled = new Set(disabledSkills)
      if (enabled) nextDisabled.delete(skillSlug)
      else nextDisabled.add(skillSlug)
      const nextSkills: LumeConfigSkillsSection = { disabled: Array.from(nextDisabled).sort() }
      await updateSkillsConfig(nextSkills, workspace.slug)
      setDisabledSkills(nextDisabled)
      toast.success(enabled ? '技能已启用' : '技能已关闭')
      await refresh()
    } catch (error) {
      console.error('[WorkspacesSettings] 保存技能开关失败:', error)
      toast.error('保存技能开关失败')
    } finally {
      setBusyKey(null)
    }
  }

  if (loading) {
    return (
      <div className="lume-panel flex h-[320px] items-center justify-center text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载能力开关...
      </div>
    )
  }

  const mcpServers = capabilities?.mcpServers ?? []
  const normalizedMcpSearchQuery = mcpSearchQuery.trim().toLowerCase()
  const normalizedSkillSearchQuery = skillSearchQuery.trim().toLowerCase()
  const filteredMcpServers = normalizedMcpSearchQuery
    ? mcpServers.filter((server) => (
      server.name.toLowerCase().includes(normalizedMcpSearchQuery) ||
      server.type.toLowerCase().includes(normalizedMcpSearchQuery)
    ))
    : mcpServers
  const filteredSkills = normalizedSkillSearchQuery
    ? skills.filter((skill) => (
      skill.name.toLowerCase().includes(normalizedSkillSearchQuery) ||
      skill.slug.toLowerCase().includes(normalizedSkillSearchQuery) ||
      (skill.description ?? '').toLowerCase().includes(normalizedSkillSearchQuery)
    ))
    : skills

  return (
    <div className="space-y-4">
      <SettingsPanel title="MCP 服务" description="只控制当前工作区的 server 启用状态，连接和工具级配置保留在 MCP 设置。">
        <CapabilitySearchInput
          value={mcpSearchQuery}
          onChange={setMcpSearchQuery}
          placeholder="搜索 MCP 服务"
        />
        <div className="space-y-2">
          {mcpServers.length === 0 && <EmptyLine label="当前工作区没有 MCP 服务" />}
          {mcpServers.length > 0 && filteredMcpServers.length === 0 && <EmptyLine label="没有匹配的 MCP 服务" />}
          {filteredMcpServers.map((server) => (
            <ToggleRow
              key={server.name}
              label={server.name}
              description={server.type}
              checked={server.enabled}
              disabled={busyKey === `mcp:${server.name}`}
              onCheckedChange={(checked) => void handleToggleMcpServer(server.name, checked)}
            />
          ))}
        </div>
      </SettingsPanel>

      <SettingsPanel title="技能" description="只控制当前工作区已安装技能的启用状态，安装和详情继续使用技能管理入口。">
        <CapabilitySearchInput
          value={skillSearchQuery}
          onChange={setSkillSearchQuery}
          placeholder="搜索技能"
        />
        <div className="space-y-2">
          {skills.length === 0 && <EmptyLine label="当前工作区没有已安装技能" />}
          {skills.length > 0 && filteredSkills.length === 0 && <EmptyLine label="没有匹配的技能" />}
          {filteredSkills.map((skill) => (
            <ToggleRow
              key={skill.slug}
              label={skill.name}
              description={skill.description ?? skill.slug}
              checked={!disabledSkills.has(skill.slug)}
              disabled={busyKey === `skill:${skill.slug}`}
              onCheckedChange={(checked) => void handleToggleSkill(skill.slug, checked)}
            />
          ))}
        </div>
      </SettingsPanel>
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
    { label: '工作区数量', value: String(workspaceCount), Icon: Box, iconClass: 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]' },
    { label: '默认工作区', value: defaultWorkspaceName, Icon: FolderOpen, iconClass: 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]' },
    { label: '最近打开', value: lastOpenedLabel, Icon: Clock3, iconClass: 'bg-[var(--surface-2)] text-[var(--text-2)]' },
    { label: '本地模式', value: '已启用', Icon: ShieldCheck, iconClass: 'bg-[color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]' },
  ]

  return (
    <section className="grid grid-cols-4 gap-3">
      {stats.map(({ label, value, Icon, iconClass }) => (
        <div
          key={label}
          className="lume-panel flex h-[72px] items-center gap-4 px-4"
        >
          <div className={cn('flex size-11 items-center justify-center rounded-full', iconClass)}>
            <Icon size={24} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-medium leading-4 text-[var(--text-2)]">{label}</div>
            <div className={cn('mt-1 truncate text-[18px] font-semibold leading-6 text-[var(--text-1)]', label === '本地模式' && 'text-[var(--lume-success)]')}>
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
    <Button
                variant="ghost"
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[58px] w-full items-center justify-start gap-3 rounded-[8px] border px-3 text-left transition-colors',
        active
          ? 'border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] shadow-[0_6px_16px_rgba(98,91,255,0.08)]'
          : 'border-transparent bg-[var(--surface-1)] hover:bg-[var(--surface-2)]'
      )}
    >
      <div className={cn('flex size-8 items-center justify-center rounded-[8px] bg-gradient-to-br text-white', accentClass)}>
        <Box size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-5 text-[var(--text-1)]">{workspace.name}</div>
        <div className="truncate text-[12px] leading-4 text-[var(--text-3)]">~/Documents/Lume/{workspace.slug}</div>
      </div>
      {isDefault && (
        <span className="rounded-[6px] bg-[var(--surface-1)] px-2 py-1 text-[12px] font-medium text-[var(--brand)] shadow-[0_0_0_1px_rgba(98,91,255,0.14)]">
          默认
        </span>
      )}
      <ChevronRight size={16} className="text-[var(--text-3)]" />
    </Button>
  )
}

function WorkspaceField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-4">
      <span className="text-[13px] font-medium text-[var(--text-2)]">{label}</span>
      {children}
    </label>
  )
}

function PreferenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-5 items-center justify-between">
      <span className="text-[13px] font-medium text-[var(--text-2)]">{label}</span>
      {children}
    </div>
  )
}

function SelectLike({ value }: { value: string }) {
  return (
    <Button
                variant="ghost"
      type="button"
      className="flex h-10 w-full items-center justify-between rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[13px] font-medium text-[var(--text-2)]"
    >
      {value}
      <ChevronDown size={15} className="text-[var(--text-3)]" />
    </Button>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      data-size="default"
      className={cn(
        'h-5 w-9 data-checked:bg-[var(--brand)]',
        '[&_[data-slot=switch-thumb]]:size-4 data-checked:[&_[data-slot=switch-thumb]]:translate-x-4',
        props.className,
      )}
    />
  )
}

function IconButton({
  children,
  disabled,
  onClick,
  title,
  tone = 'neutral',
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
  title: string
  tone?: 'neutral' | 'danger'
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'flex size-8 items-center justify-center rounded-[7px] border border-border bg-[var(--surface-1)] text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-45',
        tone === 'danger' && 'text-[#ff4e4e] hover:bg-[#fff5f5]'
      )}
    >
      {children}
    </Button>
  )
}

function PreviewEmpty({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center rounded-[8px] border border-dashed border-border bg-[var(--surface-2)] text-center text-[13px] text-[var(--text-3)]">
      <div className="mb-3 flex size-10 items-center justify-center rounded-[10px] bg-[var(--surface-1)] text-[var(--text-3)]">
        {icon}
      </div>
      {label}
    </div>
  )
}

function SettingsPanel({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description: string
  title: string
}) {
  return (
    <section className="lume-panel p-4">
      <h3 className="text-[17px] font-semibold leading-6 text-[var(--text-1)]">{title}</h3>
      <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function CapabilitySearchInput({
  onChange,
  placeholder,
  value,
}: {
  onChange: (value: string) => void
  placeholder: string
  value: string
}) {
  return (
    <label className="lume-action-tile mb-3 flex h-9 justify-start px-3 text-[var(--text-3)] shadow-none">
      <Search size={15} />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
      />
    </label>
  )
}

function ToggleRow({
  checked,
  description,
  disabled,
  label,
  onCheckedChange,
}: {
  checked: boolean
  description: string
  disabled?: boolean
  label: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-3 rounded-[8px] border border-border px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-[var(--text-1)]">{label}</div>
        <div className="mt-1 line-clamp-2 text-[12px] leading-4 text-[var(--text-3)]">{description}</div>
      </div>
      <LumeSwitch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function EmptyLine({ label }: { label: string }) {
  return (
    <div className="lume-subpanel border-dashed px-3 py-8 text-center text-[13px] text-[var(--text-3)]">
      {label}
    </div>
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
