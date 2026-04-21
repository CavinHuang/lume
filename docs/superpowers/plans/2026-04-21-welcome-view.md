# 新会话欢迎页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将"新建聊天"改为先显示欢迎页（问候语 + 大输入框 + 最近对话），发送第一条消息时才创建线程。

**Architecture:** 新增 `welcome` tab 类型，WelcomeView 组件包含独立的 TipTap 编辑器、模型选择器、ThinkingLevelPicker、文件附加和最近对话列表。发送时先调用 `agent:create-thread` 再调用 `agent:send-thread-message`。

**Tech Stack:** React + Jotai + TipTap + Tailwind + lucide-react（无新增依赖）

---

### Task 1: 扩展 Tab 类型 + 路由

**Files:**
- Modify: `apps/web/src/atoms/tab-atoms.ts`
- Modify: `apps/web/src/components/tabs/TabContent.tsx`

- [ ] **Step 1: 修改 tab-atoms.ts**

在 `apps/web/src/atoms/tab-atoms.ts` 第 4 行，将 `TabType` 增加 `'welcome'`：

```ts
export type TabType = 'agent' | 'settings' | 'welcome'
```

同时在 `Tab` interface 中增加可选的 `workspaceId` 字段（第 13 行之前）：

```ts
export interface Tab {
  id: string
  type: TabType
  title: string
  threadId?: string
  settingsTab?: SettingsTab
  workspaceId?: string
}
```

- [ ] **Step 2: 修改 TabContent.tsx**

将 `apps/web/src/components/tabs/TabContent.tsx` 替换为：

```tsx
import { useAtomValue } from 'jotai'
import { tabsAtom, activeTabIdAtom } from '@/atoms'
import { AgentView } from '@/components/agent/AgentView'
import { SettingsView } from '@/components/settings/SettingsView'
import { WelcomeView } from '@/components/welcome/WelcomeView'

export function TabContent() {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  if (!activeTab) {
    return (
      <div className="flex-1 flex items-center justify-center text-foreground/30 text-sm">
        点击左侧「新会话」开始
      </div>
    )
  }

  if (activeTab.type === 'welcome') {
    return <WelcomeView workspaceId={activeTab.workspaceId} />
  }

  if (activeTab.type === 'agent' && activeTab.threadId) {
    return <AgentView threadId={activeTab.threadId} />
  }

  if (activeTab.type === 'settings') {
    return <SettingsView />
  }

  return null
}
```

- [ ] **Step 3: 验证类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 编译失败，因为 WelcomeView 不存在（预期）

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/atoms/tab-atoms.ts apps/web/src/components/tabs/TabContent.tsx
git commit -m "feat(welcome): extend Tab type with 'welcome' and route to WelcomeView"
```

---

### Task 2: 修改 LeftSidebar — 新建聊天创建 welcome tab

**Files:**
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`

- [ ] **Step 1: 修改 handleNewThread 函数**

将 `apps/web/src/components/app-shell/LeftSidebar.tsx` 中的 `handleNewThread` 函数（第 68-75 行）替换为：

```ts
const handleNewThread = () => {
  const welcomeId = '__welcome__'
  // 如果已有 welcome tab，直接激活
  if (tabs.find((t) => t.id === welcomeId)) {
    setActiveTabId(welcomeId)
    return
  }
  // 创建新的 welcome tab
  setTabs((prev) => [
    { id: welcomeId, type: 'welcome' as const, title: '新会话', workspaceId: currentWorkspaceId ?? undefined },
    ...prev,
  ])
  setActiveTabId(welcomeId)
}
```

注意：函数从 `async` 变为同步，不再调用 sidecar。

- [ ] **Step 2: 验证类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 同样因 WelcomeView 不存在而失败

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/app-shell/LeftSidebar.tsx
git commit -m "feat(welcome): handleNewThread creates welcome tab instead of thread"
```

---

### Task 3: 创建 WelcomeView 组件

**Files:**
- Create: `apps/web/src/components/welcome/WelcomeView.tsx`
- Create: `apps/web/src/components/welcome/WelcomeModelPicker.tsx`
- Create: `apps/web/src/components/welcome/WorkspaceSelector.tsx`
- Create: `apps/web/src/components/welcome/RecentThreads.tsx`

- [ ] **Step 1: 创建 WelcomeView 主组件**

创建 `apps/web/src/components/welcome/WelcomeView.tsx`：

```tsx
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Send, Loader2, Paperclip } from 'lucide-react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useState, useEffect, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import {
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  activeTabIdAtom,
  agentSDKMessagesAtom,
} from '@/atoms'
import { sidecarCall, agentSend, openFileDialog } from '@/lib/desktop-api'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { WelcomeModelPicker } from './WelcomeModelPicker'
import { WorkspaceSelector } from './WorkspaceSelector'
import { RecentThreads } from './RecentThreads'
import type { AgentThreadMeta, LumeConfigThinkingLevel } from '@lume/shared'
import { cn } from '@/lib/utils'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'

interface WelcomeViewProps {
  workspaceId?: string
}

export function WelcomeView({ workspaceId: initialWorkspaceId }: WelcomeViewProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useAtom(activeTabIdAtom)[1]
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setCurrentWorkspaceId = useAtom(currentWorkspaceIdAtom)[1]

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? currentWorkspaceId ?? null
  )
  const [modelRef, setModelRef] = useState<string | undefined>()
  const [channelId, setChannelId] = useState<string | undefined>()
  const [modelId, setModelId] = useState<string | undefined>()
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [sending, setSending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<Array<{ filename: string; sourcePath: string }>>([])

  // 初始化思考等级
  useEffect(() => {
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.thinkingLevel) setThinkingLevel(config.agent.thinkingLevel)
      })
      .catch(() => {})
  }, [])

  // 工作区名称
  const selectedWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === selectedWorkspaceId),
    [workspaces, selectedWorkspaceId]
  )

  const workspaceSlug = selectedWorkspace?.slug ?? null

  // 当前工作区最近对话
  const recentThreads = useMemo(() => {
    if (!selectedWorkspaceId) return []
    return threads
      .filter((t) => t.workspaceId === selectedWorkspaceId && !t.pinned)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
  }, [threads, selectedWorkspaceId])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: '描述你想完成的任务...' }),
    ],
    editorProps: {
      attributes: { class: 'outline-none min-h-[80px] max-h-[200px] overflow-y-auto text-[14px] leading-relaxed' },
    },
  })

  // Enter 发送
  useEffect(() => {
    if (!editor) return
    const handler = editor.view.dom.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    })
    return () => editor.view.dom.removeEventListener('keydown', handler as EventListener)
  }, [editor, sending, pendingFiles, modelRef, channelId, modelId, thinkingLevel, selectedWorkspaceId])

  const handleSend = async () => {
    if (!editor || sending) return
    const text = editor.getText().trim()
    if (!text) return

    setSending(true)
    try {
      // 1. 创建线程
      const meta = await sidecarCall<AgentThreadMeta>('agent:create-thread', {
        workspaceId: selectedWorkspaceId ?? undefined,
        modelRef,
        channelId,
        modelId,
      })

      // 2. 上传待定文件
      if (pendingFiles.length > 0) {
        await sidecarCall('agent:save-files-to-thread', {
          threadId: meta.id,
          files: pendingFiles,
          workspaceSlug,
        })
      }

      // 3. 发送消息
      const now = Date.now()
      const userMsg = {
        type: 'user' as const,
        uuid: `user:${meta.id}:${now}`,
        session_id: meta.id,
        timestamp: new Date(now).toISOString(),
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content: [{ type: 'text' as const, text }],
        },
      }
      setSDKMessages((prev) => ({
        ...prev,
        [meta.id]: [...(prev[meta.id] ?? []), userMsg as any],
      }))

      await agentSend({
        threadId: meta.id,
        userMessage: text,
        modelRef,
        channelId,
        modelId,
        thinkingLevel,
      } as any)

      // 4. 切换到 agent tab
      setTabs((prev) => {
        const withoutWelcome = prev.filter((t) => t.id !== '__welcome__')
        return [
          { id: meta.id, type: 'agent' as const, title: meta.title, threadId: meta.id },
          ...withoutWelcome,
        ]
      })
      setActiveTabId(meta.id)

      // 更新线程列表（触发重新加载）
      const updated = await sidecarCall<AgentThreadMeta[]>('agent:list-threads', {})
      // 通过 atom 更新（这里需要 setThreads，但 WelcomeView 没有）
      // 替代方案：直接更新 tabs 中的标题
    } catch (err) {
      console.error('[WelcomeView] 发送失败:', err)
      toast.error('发送失败，请重试')
    } finally {
      setSending(false)
    }
  }

  const handleAttach = async () => {
    try {
      const result = await openFileDialog()
      if (result.files.length === 0) return
      setPendingFiles((prev) => [
        ...prev,
        ...result.files.map((f) => ({ filename: f.filename, sourcePath: f.sourcePath })),
      ])
      toast.success(`已添加 ${result.files.length} 个文件`)
    } catch (err) {
      console.error('[WelcomeView] 文件选择失败:', err)
      toast.error('文件选择失败')
    }
  }

  const handleSelectWorkspace = (wsId: string) => {
    setSelectedWorkspaceId(wsId)
    setCurrentWorkspaceId(wsId)
    // 同步更新 welcome tab 的 workspaceId
    setTabs((prev) =>
      prev.map((t) =>
        t.id === '__welcome__' ? { ...t, workspaceId: wsId } : t
      )
    )
  }

  const handleOpenThread = (thread: AgentThreadMeta) => {
    setActiveTabId(thread.id)
    if (!tabs.find((t) => t.id === thread.id)) {
      setTabs((prev) => [...prev, { id: thread.id, type: 'agent' as const, title: thread.title, threadId: thread.id }])
    }
  }

  const hasText = editor?.getText().trim().length > 0

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 overflow-y-auto">
      <div className="w-full max-w-xl flex flex-col items-center">
        {/* 问候语 */}
        <h2 className="text-xl font-semibold text-foreground mb-6">
          What should we work on
          {selectedWorkspace ? (
            <>
              {' '}in{' '}
              <span className="bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent">
                {selectedWorkspace.name}
              </span>
            </>
          ) : null}
          ?
        </h2>

        {/* 输入框 */}
        <div className={cn(
          'w-full rounded-2xl border border-border/60 bg-background shadow-sm transition-colors',
          sending && 'opacity-60'
        )}>
          <div className="px-4 py-3">
            <EditorContent editor={editor} />
          </div>

          {/* 待上传文件标签 */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {pendingFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[11px] bg-muted px-2 py-0.5 rounded"
                >
                  {f.filename}
                  <button
                    onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 工具栏 */}
          <div className="flex items-center justify-between px-3 pb-2 gap-2">
            <div className="flex items-center gap-1 min-w-0 flex-wrap">
              <WorkspaceSelector
                workspaces={workspaces}
                selectedId={selectedWorkspaceId}
                onSelect={handleSelectWorkspace}
              />
              <WelcomeModelPicker
                onModelChange={(ref, chId, mId) => {
                  setModelRef(ref)
                  setChannelId(chId)
                  setModelId(mId)
                }}
              />
              <button
                onClick={handleAttach}
                className="p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors"
                title="附加文件"
                disabled={sending}
              >
                <Paperclip size={15} />
              </button>
              <ThinkingLevelPicker value={thinkingLevel} onChange={setThinkingLevel} />
            </div>
            {sending ? (
              <div className="p-1.5">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={!hasText}
                className={cn(
                  'p-1.5 rounded-lg transition-colors',
                  hasText
                    ? 'bg-primary text-primary-foreground hover:opacity-90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
                title="发送"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>

        {/* 最近对话 */}
        <RecentThreads threads={recentThreads} onOpen={handleOpenThread} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 WelcomeModelPicker**

创建 `apps/web/src/components/welcome/WelcomeModelPicker.tsx`：

```tsx
import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, Search, Cpu } from 'lucide-react'
import { sidecarCall } from '@/lib/desktop-api'
import { listChannels } from '@/lib/desktop-api/channel'
import { buildModelSelectionGroups } from '@/components/model-selection/model-selection-state'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { cn } from '@/lib/utils'
import type { Channel, ModelSelectionOption } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'

interface WelcomeModelPickerProps {
  onModelChange: (modelRef?: string, channelId?: string, modelId?: string) => void
}

export function WelcomeModelPicker({ onModelChange }: WelcomeModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedLabel, setSelectedLabel] = useState<string>('默认模型')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listChannels().then(setChannels).catch(() => {})
  }, [])

  useEffect(() => {
    // 获取默认模型标签
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.defaultModelRef) {
          setSelectedLabel(config.agent.defaultModelRef.split('/').pop() ?? '默认模型')
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const groups = useMemo(() => buildModelSelectionGroups(channels), [channels])

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups
    const q = search.toLowerCase()
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) => o.label.toLowerCase().includes(q) || o.modelId?.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.options.length > 0)
  }, [groups, search])

  const handleSelect = (option: ModelSelectionOption) => {
    onModelChange(option.modelRef, option.channelId, option.modelId)
    setSelectedLabel(option.label)
    setOpen(false)
    setSearch('')
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors text-[12px]"
        title="选择模型"
      >
        <Cpu size={14} />
        <span className="max-w-[80px] truncate">{selectedLabel}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 bg-muted/50 rounded-md px-2 py-1">
              <Search size={12} className="text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="flex-1 bg-transparent outline-none text-[12px] placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[200px] overflow-y-auto p-1">
            {filteredGroups.map((group) => (
              <div key={group.channelId}>
                <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{group.label}</div>
                {group.options.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => handleSelect(option)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md hover:bg-muted/50 text-left transition-colors"
                  >
                    {option.channelId && <ChannelProviderIcon channelId={option.channelId} size={14} />}
                    <span className="truncate">{option.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {filteredGroups.length === 0 && (
              <div className="px-2 py-3 text-[12px] text-muted-foreground text-center">无匹配模型</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 创建 WorkspaceSelector**

创建 `apps/web/src/components/welcome/WorkspaceSelector.tsx`：

```tsx
import { useState, useRef, useEffect } from 'react'
import { ChevronDown, FolderOpen, Plus, Search } from 'lucide-react'
import { sidecarCall } from '@/lib/desktop-api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { AgentWorkspace } from '@lume/shared'

interface WorkspaceSelectorProps {
  workspaces: AgentWorkspace[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function WorkspaceSelector({ workspaces, selectedId, onSelect }: WorkspaceSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = workspaces.find((ws) => ws.id === selectedId)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = search.trim()
    ? workspaces.filter((ws) => ws.name.toLowerCase().includes(search.toLowerCase()))
    : workspaces

  const handleCreate = async () => {
    const name = prompt('工作区名称：')
    if (!name?.trim()) return
    try {
      const ws = await sidecarCall<AgentWorkspace>('agent:create-workspace', { name: name.trim() })
      onSelect(ws.id)
      setOpen(false)
      setSearch('')
      toast.success(`已创建工作区「${ws.name}」`)
    } catch {
      toast.error('创建失败')
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors text-[12px]"
        title="选择工作区"
      >
        <FolderOpen size={14} />
        <span className="max-w-[80px] truncate">{selected?.name ?? '默认'}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 bg-muted/50 rounded-md px-2 py-1">
              <Search size={12} className="text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索工作区..."
                className="flex-1 bg-transparent outline-none text-[12px] placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[160px] overflow-y-auto p-1">
            {filtered.map((ws) => (
              <button
                key={ws.id}
                onClick={() => { onSelect(ws.id); setOpen(false); setSearch('') }}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md text-left transition-colors',
                  ws.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
                )}
              >
                <FolderOpen size={12} className="flex-shrink-0" />
                <span className="truncate flex-1">{ws.name}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-[12px] text-muted-foreground text-center">无匹配工作区</div>
            )}
          </div>
          <div className="border-t border-border p-1">
            <button
              onClick={handleCreate}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md hover:bg-muted/50 text-muted-foreground text-left transition-colors"
            >
              <Plus size={12} />
              新建工作区
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 创建 RecentThreads**

创建 `apps/web/src/components/welcome/RecentThreads.tsx`：

```tsx
import type { AgentThreadMeta } from '@lume/shared'

interface RecentThreadsProps {
  threads: AgentThreadMeta[]
  onOpen: (thread: AgentThreadMeta) => void
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function RecentThreads({ threads, onOpen }: RecentThreadsProps) {
  if (threads.length === 0) return null

  return (
    <div className="w-full mt-6">
      <div className="text-[11px] font-medium text-foreground/40 mb-2">最近对话</div>
      <div className="flex flex-col gap-1">
        {threads.map((thread) => (
          <button
            key={thread.id}
            onClick={() => onOpen(thread)}
            className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 bg-background hover:bg-muted/30 transition-colors text-left"
          >
            <span className="text-[13px] text-foreground/80 truncate flex-1">{thread.title}</span>
            <span className="text-[11px] text-foreground/30 flex-shrink-0 ml-2">{relativeTime(thread.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 验证类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 通过（可能需要修复少量类型问题）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/welcome/
git commit -m "feat(welcome): create WelcomeView with model picker, workspace selector, and recent threads"
```

---

### Task 4: 修复 WelcomeView 中的 threads 更新 + 清理 agent:send 参数

**Files:**
- Modify: `apps/web/src/components/welcome/WelcomeView.tsx`

- [ ] **Step 1: 添加 agentThreadsAtom 的 set**

在 WelcomeView 中需要更新 threads 列表。修改导入：

```ts
import {
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  activeTabIdAtom,
  agentSDKMessagesAtom,
} from '@/atoms'
```

改为：

```ts
import {
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  activeTabIdAtom,
  agentSDKMessagesAtom,
} from '@/atoms'
```

然后在组件内添加：

```ts
const setThreads = useAtom(agentThreadsAtom)[1]
```

在 `handleSend` 的成功路径中，在 `setActiveTabId(meta.id)` 之后添加：

```ts
// 更新线程列表
setThreads((prev) => [meta, ...prev])
```

同时删除后面那个多余的 `agent:list-threads` 调用和注释。

- [ ] **Step 2: 验证类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/welcome/WelcomeView.tsx
git commit -m "fix(welcome): update threads list on send and clean up send handler"
```

---

### Task 5: 验证与最终提交

- [ ] **Step 1: 完整类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 0 errors

- [ ] **Step 2: 启动开发服务器手动验证**

Run: `cd apps/web && bun run dev`

验证清单：
1. 点击"新建聊天" → 显示欢迎页（居中布局）
2. 问候语显示 "What should we work on in {工作区名}?"（工作区名渐变色）
3. 输入框支持多行，Enter 发送，Shift+Enter 换行
4. 工作区选择器弹出搜索 + 列表 + 新建工作区
5. 模型选择器弹出模型列表
6. 文件附加按钮可选文件，显示在输入框内标签
7. 最近对话显示当前工作区 3 条，点击跳转
8. 发送消息 → 创建线程 → 切换到 agent tab → 消息正常发送
9. 重复点击"新建聊天" → 复用已有的 welcome tab
10. 发送失败 → toast 提示，输入内容保留

- [ ] **Step 3: 最终提交（如有遗漏修复）**

```bash
git add -A
git commit -m "feat(welcome): finalize welcome view feature"
```
