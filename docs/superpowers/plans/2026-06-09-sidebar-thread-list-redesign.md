# 侧边栏线程列表重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lume 侧边栏工作区线程列表重构为 Proma 风格：紧凑信息密集、右键菜单、行内操作按钮组。

**Architecture:** 移植 Proma `LeftSidebar.tsx` 中的 `AgentSessionItem`、`AgentProjectGroupItem`、`SessionItemActions` 到 Lume，适配数据模型差异。视图模型简化为去掉二级分组，线程平铺。使用 `@base-ui/react`（Lume 已有的 UI 基础库）替代 Radix UI 实现右键菜单和下拉菜单。

**Tech Stack:** React 19, Jotai, Tailwind CSS, @base-ui/react, Lucide icons

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `apps/web/src/components/ui/context-menu.tsx` | 创建 | 基于 @base-ui/react 的右键菜单组件 |
| `apps/web/src/components/ui/dropdown-menu.tsx` | 创建 | 基于 @base-ui/react 的下拉菜单组件 |
| `apps/web/src/components/app-shell/ThreadItem.tsx` | 创建 | 线程列表项（移植 Proma AgentSessionItem） |
| `apps/web/src/components/app-shell/ThreadItemActions.tsx` | 创建 | 线程行内操作按钮组（移植 Proma SessionItemActions） |
| `apps/web/src/components/app-shell/WorkspaceGroupItem.tsx` | 创建 | 工作区分组组件（移植 Proma AgentProjectGroupItem） |
| `apps/web/src/components/app-shell/LumeSidebar.tsx` | 修改 | 替换 WorkspaceTree/ThreadRow 为新组件 |
| `apps/web/src/components/app-shell/lume-sidebar-view-model.ts` | 修改 | 简化：去掉二级分组，平铺线程 |

---

### Task 1: 创建 ContextMenu UI 组件

**Files:**
- Create: `apps/web/src/components/ui/context-menu.tsx`

基于 @base-ui/react 的 `Menu` 原语实现右键菜单组件，与 Lume 现有的 `tooltip.tsx`（使用 @base-ui/react/tooltip）风格一致。

- [ ] **Step 1: 创建 context-menu.tsx**

```tsx
// apps/web/src/components/ui/context-menu.tsx
import { Menu } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: Menu.Root.Props) {
  return <Menu.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ ...props }: Menu.Trigger.Props) {
  return <Menu.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({
  className,
  children,
  ...props
}: Menu.Popup.Props & { className?: string }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} className="isolate z-50">
        <Menu.Popup
          data-slot="context-menu-content"
          className={cn(
            "z-50 min-w-[140px] overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95",
            className
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

function ContextMenuItem({
  className,
  destructive,
  ...props
}: Menu.Item.Props & { className?: string; destructive?: boolean }) {
  return (
    <Menu.Item
      data-slot="context-menu-item"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors cursor-default",
        destructive
          ? "text-red-500 hover:bg-red-500/10"
          : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      data-slot="context-menu-separator"
      className={cn("my-0.5 h-px bg-[color:color-mix(in_oklab,var(--border-strong)_40%,transparent)]", className)}
    />
  )
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator }
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/context-menu.tsx
git commit -m "feat(ui): add ContextMenu component based on @base-ui/react"
```

---

### Task 2: 创建 DropdownMenu UI 组件

**Files:**
- Create: `apps/web/src/components/ui/dropdown-menu.tsx`

- [ ] **Step 1: 创建 dropdown-menu.tsx**

```tsx
// apps/web/src/components/ui/dropdown-menu.tsx
import { Menu } from "@base-ui/react/menu"
import { cn } from "@/lib/utils"

function DropdownMenu({ ...props }: Menu.Root.Props) {
  return <Menu.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: Menu.Trigger.Props) {
  return <Menu.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  children,
  ...props
}: Menu.Popup.Props & { className?: string }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} align="start" className="isolate z-50">
        <Menu.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "z-50 min-w-[140px] overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95",
            className
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

function DropdownMenuItem({
  className,
  destructive,
  disabled,
  ...props
}: Menu.Item.Props & { className?: string; destructive?: boolean }) {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors cursor-default",
        destructive
          ? "text-red-500 hover:bg-red-500/10"
          : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]",
        disabled && "cursor-not-allowed opacity-45",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      data-slot="dropdown-menu-separator"
      className={cn("my-0.5 h-px bg-[color:color-mix(in_oklab,var(--border-strong)_40%,transparent)]", className)}
    />
  )
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator }
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/dropdown-menu.tsx
git commit -m "feat(ui): add DropdownMenu component based on @base-ui/react"
```

---

### Task 3: 简化视图模型（去掉二级分组）

**Files:**
- Modify: `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`

去掉 `LumeSidebarThreadGroup`、`buildThreadGroupRows`、`groupThreadsByImProvider`、`groupThreadsByDate` 等二级分组逻辑。工作区内线程直接平铺，按 updatedAt 降序排列，默认只展示前 N 条。

- [ ] **Step 1: 修改视图模型类型和构建逻辑**

关键改动：
1. `LumeSidebarWorkspaceItem.rows` → `threads: LumeSidebarThreadItem[]`（平铺全部线程，组件自行管理折叠/展开）
2. 删除 `hiddenCount`（组件内部自行计算）
3. 删除 `LumeSidebarThreadGroup`、`LumeSidebarWorkspaceRow`
4. 删除 `buildThreadGroupRows`、`groupThreadsByImProvider`、`groupThreadsByDate` 及相关辅助函数
5. 保留 `buildWelcomeRow` → 改为 `LumeSidebarSyntheticThreadRow` 仍在 `LumeSidebarWorkspaceItem` 的 `syntheticRow` 字段

替换后的核心类型：

```typescript
// 删除的类型
// - LumeSidebarThreadGroup
// - LumeSidebarWorkspaceRow (synthetic-thread | thread-group 联合类型)
// - ThreadGroup (内部)

// 修改的类型
export interface LumeSidebarWorkspaceItem {
  id: string
  name: string
  count: number
  isCurrent: boolean
  isExpanded: boolean
  pinned: boolean
  syntheticRow: LumeSidebarSyntheticThreadRow | null
  threads: LumeSidebarThreadItem[]
}
```

替换 `buildLumeSidebarViewModel` 中工作区构建部分，将 `buildThreadGroupRows(...)` 替换为直接 `map`：

```typescript
// 在 workspaceItems 构建中替换：
const allThreads = sortThreadsByUpdatedAt(workspaceThreads)
  .map((thread) => buildThreadItem(thread, activeTabId, streamingStates))

return {
  id: workspace.id,
  name: workspace.name,
  count: workspaceThreads.length,
  isCurrent: workspace.id === selectedWorkspaceId,
  isExpanded: expandedSet.has(workspace.id),
  pinned: pinnedSet.has(workspace.id),
  syntheticRow: buildWelcomeRow(workspace.id, workspace.id === selectedWorkspaceId && activeTabId === '__welcome__'),
  threads: allThreads,
}
```

删除文件末尾的函数：`buildThreadGroupRows`、`getThreadImProvider`、`groupThreadsByImProvider`、`compareImProviders`、`groupThreadsByDate`。
删除 `IM_PROVIDER_LABELS`、`IM_PROVIDER_ORDER`、`ThreadGroup` 接口。

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/app-shell/lume-sidebar-view-model.ts
git commit -m "refactor(sidebar): flatten thread list, remove secondary grouping"
```

---

### Task 4: 创建 ThreadItemActions 组件

**Files:**
- Create: `apps/web/src/components/app-shell/ThreadItemActions.tsx`

移植 Proma `SessionItemActions`，适配 Lume 的样式系统（CSS 变量）。

- [ ] **Step 1: 创建 ThreadItemActions.tsx**

```tsx
// apps/web/src/components/app-shell/ThreadItemActions.tsx
import { useState, useEffect, useRef } from 'react'
import { Pin, PinOff, Archive, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

interface ThreadItemActionsProps {
  updatedAt: number
  pinned: boolean
  onTogglePin: () => void
  onArchive: () => void
  menuItems: (
    MenuItem: typeof DropdownMenuItem,
    MenuSeparator: typeof DropdownMenuSeparator,
  ) => React.ReactNode
  onMenuOpenChange?: (open: boolean) => void
}

function formatRelativeUpdatedAt(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}分钟`
  if (diff < day) return `${Math.floor(diff / hour)}小时`
  if (diff < 30 * day) return `${Math.floor(diff / day)}天`
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}月`
  return `${Math.floor(diff / (365 * day))}年`
}

export function ThreadItemActions({
  updatedAt,
  pinned,
  onTogglePin,
  onArchive,
  menuItems,
  onMenuOpenChange,
}: ThreadItemActionsProps) {
  const [archiveConfirming, setArchiveConfirming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const now = Date.now()

  useEffect(() => {
    if (!archiveConfirming) return
    const timer = setTimeout(() => setArchiveConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [archiveConfirming])

  const handleArchiveClick = (): void => {
    if (archiveConfirming) {
      setArchiveConfirming(false)
      onArchive()
      return
    }
    setArchiveConfirming(true)
  }

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setMenuOpen(true)
    } else {
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        setMenuOpen(false)
      }, 200)
    }
    onMenuOpenChange?.(open)
  }

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const forceVisible = archiveConfirming || menuOpen

  return (
    <div
      className="flex-shrink-0 flex items-center h-[18px]"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        title={`最后更新：${new Date(updatedAt).toLocaleString('zh-CN')}`}
        className={cn(
          'min-w-[42px] text-right text-[11px] leading-[18px] tabular-nums text-[var(--text-3)]',
          forceVisible ? 'hidden' : 'group-hover:hidden',
        )}
      >
        {formatRelativeUpdatedAt(updatedAt, now)}
      </span>
      <div
        className={cn(
          'items-center gap-0.5',
          forceVisible ? 'flex' : 'hidden group-hover:flex',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={cn(
                'p-0.5 rounded transition-colors',
                pinned
                  ? 'text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)] hover:text-[var(--brand)]'
                  : 'text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]',
              )}
              onClick={onTogglePin}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{pinned ? '取消置顶' : '置顶'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={cn(
                'p-0.5 rounded transition-colors',
                archiveConfirming
                  ? 'text-red-500 bg-red-500/10'
                  : 'text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]',
              )}
              onClick={handleArchiveClick}
            >
              <Archive size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {archiveConfirming ? '再次点击确认归档' : '归档'}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'p-0.5 rounded text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] transition-colors',
              )}
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/app-shell/ThreadItemActions.tsx
git commit -m "feat(sidebar): add ThreadItemActions with inline pin/archive/menu buttons"
```

---

### Task 5: 创建 ThreadItem 组件

**Files:**
- Create: `apps/web/src/components/app-shell/ThreadItem.tsx`

移植 Proma `AgentSessionItem`，支持右键菜单、行内操作、双击重命名、左侧状态色条。

- [ ] **Step 1: 创建 ThreadItem.tsx**

```tsx
// apps/web/src/components/app-shell/ThreadItem.tsx
import { memo, useState, useRef } from 'react'
import { Pin, PinOff, Pencil, Trash2, Archive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ThreadItemActions } from './ThreadItemActions'

import type { LumeSidebarThreadItem } from './lume-sidebar-view-model'

interface ThreadItemProps {
  thread: LumeSidebarThreadItem
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
}

export const ThreadItem = memo(function ThreadItem({
  thread,
  onSelect,
  onTogglePin,
  onArchive,
  onRename,
}: ThreadItemProps) {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const justStartedEditing = useRef(false)

  const startEdit = (): void => {
    setEditTitle(thread.title)
    setEditing(true)
    justStartedEditing.current = true
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const saveTitle = (): void => {
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === thread.title) {
      setEditing(false)
      return
    }
    onRename(thread.id, trimmed)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem onSelect={() => onTogglePin(thread.id)}>
        {thread.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        {thread.pinned ? '取消置顶' : '置顶'}
      </MenuItem>
      <MenuItem onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem onSelect={() => onArchive(thread.id)}>
        <Archive size={14} />
        归档
      </MenuItem>
      <MenuSeparator />
      <MenuItem destructive onSelect={() => onArchive(thread.id)}>
        <Trash2 size={14} />
        删除
      </MenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => !editing && onSelect(thread.id)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            startEdit()
          }}
          className={cn(
            'group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 text-left',
            thread.active && 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))]',
            !thread.active && 'hover:bg-[var(--surface-2)]',
          )}
        >
          {/* 左侧状态色条 */}
          {(thread.isStreaming || thread.active) && (
            <span
              className={cn(
                'absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none',
                thread.isStreaming ? 'bg-blue-500 animate-pulse' : 'bg-[var(--brand)]',
              )}
              aria-hidden="true"
            />
          )}
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={saveTitle}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent text-[13px] leading-5 text-[var(--text-1)] border-b border-[color:color-mix(in_oklab,var(--brand)_50%,transparent)] outline-none px-0 py-0"
                maxLength={100}
              />
            ) : (
              <div className={cn(
                'truncate text-[13px] leading-[18px] flex items-center gap-1.5',
                thread.active ? 'text-[var(--text-1)] font-medium' : 'text-[var(--text-2)]'
              )}>
                {thread.pinned && (
                  <Pin size={11} className="flex-shrink-0 text-[var(--brand)]" />
                )}
                <span className="truncate">{thread.title}</span>
              </div>
            )}
          </div>

          {!editing && (
            <ThreadItemActions
              updatedAt={thread.updatedAt}
              pinned={thread.pinned}
              onTogglePin={() => onTogglePin(thread.id)}
              onArchive={() => onArchive(thread.id)}
              onMenuOpenChange={setMenuOpen}
              menuItems={menuItems}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  )
})
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/app-shell/ThreadItem.tsx
git commit -m "feat(sidebar): add ThreadItem with context menu, inline actions, rename"
```

---

### Task 6: 创建 WorkspaceGroupItem 组件

**Files:**
- Create: `apps/web/src/components/app-shell/WorkspaceGroupItem.tsx`

移植 Proma `AgentProjectGroupItem`，支持文件夹图标 + 工作区名称 + hover 显示操作按钮。

- [ ] **Step 1: 创建 WorkspaceGroupItem.tsx**

```tsx
// apps/web/src/components/app-shell/WorkspaceGroupItem.tsx
import { memo, useState, useRef } from 'react'
import { FolderOpen, Plus, MoreHorizontal, Pencil, Trash2, Check, X, Home, Box } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ThreadItem } from './ThreadItem'
import type { LumeSidebarSyntheticThreadRow, LumeSidebarThreadItem } from './lume-sidebar-view-model'

const THREAD_EXPAND_STEP = 10
const THREAD_PREVIEW_LIMIT = 5

interface WorkspaceGroupItemProps {
  id: string
  name: string
  isCurrent: boolean
  isExpanded: boolean
  pinned: boolean
  syntheticRow: LumeSidebarSyntheticThreadRow | null
  threads: LumeSidebarThreadItem[]
  hiddenCount: number
  onSelectWorkspace: (workspaceId: string) => void
  onOpenThread: (threadId: string, workspaceId?: string) => void
  onToggleThreadPin: (threadId: string) => void
  onArchiveThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
  onToggleWorkspacePin: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, name: string) => void
  onDeleteWorkspace: (workspaceId: string) => void
  onNewThread: (workspaceId: string) => void
}

export const WorkspaceGroupItem = memo(function WorkspaceGroupItem({
  id,
  name,
  isCurrent,
  isExpanded,
  pinned,
  syntheticRow,
  threads,
  hiddenCount,
  onSelectWorkspace,
  onOpenThread,
  onToggleThreadPin,
  onArchiveThread,
  onRenameThread,
  onToggleWorkspacePin,
  onRenameWorkspace,
  onDeleteWorkspace,
  onNewThread,
}: WorkspaceGroupItemProps) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(name)
  const [extraCount, setExtraCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const justStartedRef = useRef(false)

  // 视图模型传入全部线程 + hiddenCount；组件内部管理折叠/展开
  const visibleThreads = threads.slice(0, THREAD_PREVIEW_LIMIT + extraCount)
  const currentHiddenCount = Math.max(0, threads.length - visibleThreads.length)

  const startRename = (): void => {
    setDraft(name)
    setRenaming(true)
    justStartedRef.current = true
    setTimeout(() => {
      justStartedRef.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const commitRename = (): void => {
    if (justStartedRef.current) return
    const trimmed = draft.trim()
    if (!trimmed || trimmed === name) {
      setRenaming(false)
      return
    }
    onRenameWorkspace(id, trimmed)
    setRenaming(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setRenaming(false)
    }
  }

  const isPersonal = name.toLowerCase() === 'personal'

  return (
    <section className={cn('relative py-0.5 rounded-md', !isExpanded && 'mb-1')}>
      {/* 工作区标题行 */}
      <div className="group/workspace relative flex items-center">
        {renaming ? (
          <div
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-1 px-1 py-1 rounded-md text-left',
              isCurrent ? 'text-[var(--text-1)]' : 'text-[var(--text-2)]',
            )}
          >
            {isPersonal ? <Home size={13} className="flex-shrink-0 text-[var(--text-3)]" /> : <FolderOpen size={13} className="flex-shrink-0 text-[var(--text-3)]" />}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              className="flex-1 min-w-0 bg-transparent text-[13px] font-medium text-[var(--text-1)] border-b border-[color:color-mix(in_oklab,var(--brand)_50%,transparent)] outline-none px-0.5 leading-[18px]"
              maxLength={50}
            />
            <button
              type="button"
              onClick={commitRename}
              className="flex size-5 items-center justify-center rounded-full text-[var(--brand)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)]"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={() => { setDraft(name); setRenaming(false) }}
              className="flex size-5 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-1)]"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onSelectWorkspace(id)}
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-1 px-1 py-1 rounded-md text-left transition-colors group-hover/workspace:pr-11 hover:bg-[var(--surface-2)]',
              isCurrent
                ? 'text-[var(--text-1)]'
                : 'text-[var(--text-2)] hover:text-[var(--text-1)]',
            )}
          >
            {isPersonal
              ? <Home size={13} strokeWidth={2} className={cn('flex-shrink-0', isCurrent ? 'text-[var(--brand)]' : 'text-[var(--text-3)]')} />
              : <Box size={13} strokeWidth={2} className={cn('flex-shrink-0', isCurrent ? 'text-[var(--brand)]' : 'text-[var(--text-3)]')} />
            }
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium leading-[18px]">
              {name}
            </span>
            <span className={cn(
              'shrink-0 text-[11px] font-medium leading-none text-[var(--text-3)]',
              'group-hover/workspace:opacity-0',
            )}>
              {threads.length}
            </span>
          </button>
        )}

        {/* hover 显示的新建按钮 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`在「${name}」中新建会话`}
              onClick={(e) => {
                e.stopPropagation()
                onNewThread(id)
              }}
              className="absolute right-5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-3)] opacity-0 transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)] group-hover/workspace:opacity-100"
            >
              <Plus size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">在此工作区新建会话</TooltipContent>
        </Tooltip>

        {/* hover 显示的三点菜单 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="工作区菜单"
              className="absolute right-0 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-3)] opacity-0 transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] group-hover/workspace:opacity-100"
            >
              <MoreHorizontal size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onToggleWorkspacePin(id)}>
              {pinned ? <Box size={14} /> : <Box size={14} />}
              {pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={startRename}>
              <Pencil size={14} />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => onDeleteWorkspace(id)}>
              <Trash2 size={14} />
              删除工作区
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 线程列表 */}
      {isExpanded && (
        <div className="ml-4 mt-px">
          {/* 合成入口（新对话） */}
          {syntheticRow && (
            <button
              type="button"
              onClick={() => onOpenThread(syntheticRow.id, syntheticRow.workspaceId)}
              className={cn(
                'group relative w-full flex items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 transition-colors duration-100 text-left',
                syntheticRow.active
                  ? 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
              )}
            >
              <span className="truncate text-[13px] font-medium">✨ {syntheticRow.label}</span>
            </button>
          )}

          {threads.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {threads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  onSelect={onOpenThread}
                  onTogglePin={onToggleThreadPin}
                  onArchive={onArchiveThread}
                  onRename={onRenameThread}
                />
              ))}

              {currentHiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExtraCount((prev) => prev + THREAD_EXPAND_STEP)}
                  className="w-full text-left px-1.5 py-1 rounded-md text-[12px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] transition-colors"
                >
                  显示更多（{currentHiddenCount}）
                </button>
              )}

              {extraCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExtraCount(0)}
                  className="w-full text-left px-1.5 py-1 rounded-md text-[12px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] transition-colors"
                >
                  收起
                </button>
              )}
            </div>
          ) : (
            <div className="px-1.5 py-0.5 text-[12px] text-[var(--text-3)] select-none">
              暂无会话
            </div>
          )}
        </div>
      )}
    </section>
  )
})
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/app-shell/WorkspaceGroupItem.tsx
git commit -m "feat(sidebar): add WorkspaceGroupItem with hover actions and flat thread list"
```

---

### Task 7: 重构 LumeSidebar 使用新组件

**Files:**
- Modify: `apps/web/src/components/app-shell/LumeSidebar.tsx`

用 `WorkspaceGroupItem` 替换 `WorkspaceTree`、`WorkspaceRowRenderer`、`ThreadRow`。删除旧组件。

- [ ] **Step 1: 修改 LumeSidebar 展开状态的线程列表渲染**

在展开状态的 `<ScrollArea>` 区域内，将：

```tsx
{model.workspaces.map((workspace) => (
  <WorkspaceTree key={workspace.id} workspace={workspace} ... />
))}
```

替换为：

```tsx
{model.workspaces.map((workspace) => (
  <WorkspaceGroupItem
    key={workspace.id}
    id={workspace.id}
    name={workspace.name}
    isCurrent={workspace.isCurrent}
    isExpanded={workspace.isExpanded}
    pinned={workspace.pinned}
    syntheticRow={workspace.syntheticRow}
    threads={workspace.threads}
    hiddenCount={workspace.hiddenCount}
    onSelectWorkspace={onSelectWorkspace}
    onOpenThread={onOpenThread}
    onToggleThreadPin={onToggleThreadPin}
    onArchiveThread={onDeleteThread}
    onRenameThread={onRenameThread}
    onToggleWorkspacePin={onToggleWorkspacePin}
    onRenameWorkspace={onRenameWorkspace}
    onDeleteWorkspace={onDeleteWorkspace}
    onNewThread={(wsId) => onOpenThread('__welcome__', wsId)}
  />
))}
```

- [ ] **Step 2: 删除旧组件**

从 `LumeSidebar.tsx` 中删除以下函数/组件：
- `WorkspaceTree` 函数组件（约 180 行）
- `WorkspaceIcon` 函数组件
- `WorkspaceRowRenderer` 函数组件
- `ThreadRow` 函数组件
- `shouldCloseThreadMenuForTarget` 函数
- `ThreadMenuItem` 函数组件

- [ ] **Step 3: 更新导入**

在文件顶部添加：
```typescript
import { WorkspaceGroupItem } from './WorkspaceGroupItem'
```

移除不再使用的导入：`Archive`、`BookOpen`、`Bot`、`Check`、`Clock3`、`Folder`、`Sparkles`、`X` 等（如果只有旧组件使用的话）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/app-shell/LumeSidebar.tsx
git commit -m "feat(sidebar): replace WorkspaceTree/ThreadRow with WorkspaceGroupItem/ThreadItem"
```

---

### Task 8: 适配 LeftSidebar 业务逻辑

**Files:**
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`

LeftSidebar 的业务逻辑基本不变，只需确保传递给新组件的 props 与视图模型的新结构匹配。

- [ ] **Step 1: 检查并适配 buildLumeSidebarViewModel 调用**

视图模型改动后 `model.workspaces[i].threads` 和 `model.workspaces[i].syntheticRow` 是新字段。LeftSidebar 中的 `buildLumeSidebarViewModel` 调用不需要改动（输入参数未变）。

确认 `LumeSidebar` 组件能接收到新的 props（`syntheticRow`、`threads`、`hiddenCount`）。

- [ ] **Step 2: 运行验证**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(sidebar): adapt LeftSidebar to new view model structure"
```

---

### Task 9: 视觉验证与修复

**Files:**
- May modify any of the above files

- [ ] **Step 1: 启动开发服务器**

```bash
cd apps/web && npm run dev
```

- [ ] **Step 2: 验证以下场景**

1. 展开侧边栏 → 工作区标题行显示正确（名称 + 计数 + hover 操作按钮）
2. 点击工作区 → 展开线程列表，显示合成入口 + 线程
3. 线程项 → 默认显示时间，hover 切换为 Pin/Archive/三点按钮
4. 右键线程 → 弹出上下文菜单
5. 双击线程 → 进入重命名模式
6. 流式状态 → 左侧蓝色脉冲条
7. 选中状态 → 左侧品牌色条 + 背景高亮
8. 折叠侧边栏 → 图标视图正常

- [ ] **Step 3: 修复发现的问题**

根据验证结果修复样式、交互或逻辑问题。

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "fix(sidebar): visual polish and interaction fixes"
```
