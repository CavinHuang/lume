# 命令面板搜索功能 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现全局命令面板，跨工作区搜索线程标题，支持 Ctrl+K 快捷键和侧边栏按钮双入口。

**Architecture:** 纯客户端搜索，从已有的 `agentThreadsAtom` 读取线程列表，标题模糊匹配排序后渲染。单文件组件 `CommandPalette.tsx` 包含所有子组件（遵循 LeftSidebar.tsx 的模式）。通过 `commandPaletteOpenAtom` 控制面板开关。

**Tech Stack:** React + Jotai + Tailwind CSS + lucide-react（无新增依赖）

---

### Task 1: 创建 command palette atom

**Files:**
- Create: `apps/web/src/atoms/command-palette.ts`
- Modify: `apps/web/src/atoms/index.ts`

- [ ] **Step 1: 创建 atom 文件**

创建 `apps/web/src/atoms/command-palette.ts`：

```ts
import { atom } from 'jotai'

export const commandPaletteOpenAtom = atom(false)
```

- [ ] **Step 2: 在 index.ts 中导出**

在 `apps/web/src/atoms/index.ts` 末尾添加：

```ts
export * from './command-palette'
```

- [ ] **Step 3: 验证无编译错误**

Run: `cd apps/web && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无与 `command-palette` 相关的错误

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/atoms/command-palette.ts apps/web/src/atoms/index.ts
git commit -m "feat(command-palette): add command palette open atom"
```

---

### Task 2: 创建 CommandPalette 组件

**Files:**
- Create: `apps/web/src/components/command-palette/CommandPalette.tsx`

- [ ] **Step 1: 创建组件文件**

创建 `apps/web/src/components/command-palette/CommandPalette.tsx`：

```tsx
import { useAtom, useAtomValue } from 'jotai'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  commandPaletteOpenAtom,
  tabsAtom,
  activeTabIdAtom,
  agentThreadsAtom,
  agentWorkspacesAtom,
} from '@/atoms'
import { cn } from '@/lib/utils'
import type { AgentThreadMeta, AgentWorkspace } from '@lume/shared'

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

export function CommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom)
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useAtom(activeTabIdAtom)[1]

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return threads
      .filter((t) => t.title.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
      })
  }, [query, threads])

  const wsMap = useMemo(() => {
    const m = new Map<string, AgentWorkspace>()
    for (const ws of workspaces) m.set(ws.id, ws)
    return m
  }, [workspaces])

  const openThread = (thread: AgentThreadMeta) => {
    setActiveTabId(thread.id)
    if (!tabs.find((t) => t.id === thread.id)) {
      setTabs((prev) => [
        ...prev,
        { id: thread.id, type: 'agent' as const, title: thread.title, threadId: thread.id },
      ])
    }
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!results.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (i + 1) % results.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (i - 1 + results.length) % results.length)
      return
    }
    if (e.key === 'Enter') {
      openThread(results[selectedIndex])
    }
  }

  // 打开时重置状态并聚焦
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 结果变化时重置选中索引
  useEffect(() => {
    setSelectedIndex(0)
  }, [results.length])

  // 选中项滚动到可视区
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 animate-in fade-in duration-150"
        onClick={() => setOpen(false)}
      />

      {/* 弹窗 */}
      <div className="relative w-full max-w-lg mx-4 bg-card border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-150">
        {/* 搜索输入 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索线程标题..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && results.length > 0 && (
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {results.length} 个结果
            </span>
          )}
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
            Esc
          </kbd>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[300px] overflow-y-auto p-1">
          {query.trim() === '' ? (
            <EmptyState />
          ) : results.length === 0 ? (
            <NoResults />
          ) : (
            results.map((thread, i) => (
              <ResultItem
                key={thread.id}
                thread={thread}
                workspace={thread.workspaceId ? wsMap.get(thread.workspaceId) : undefined}
                isSelected={i === selectedIndex}
                onClick={() => openThread(thread)}
                onMouseEnter={() => setSelectedIndex(i)}
              />
            ))
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
          <span>↑↓ 导航</span>
          <span>↵ 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}

/* ——— 子组件 ——— */

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <Search size={28} className="text-muted-foreground/40" strokeWidth={1.5} />
      <p className="text-sm text-muted-foreground mt-2">输入关键词搜索所有线程</p>
    </div>
  )
}

function NoResults() {
  return (
    <div className="flex flex-col items-center justify-center py-8">
      <p className="text-sm text-muted-foreground">未找到匹配的线程</p>
      <p className="text-xs text-muted-foreground/70 mt-1">尝试其他关键词</p>
    </div>
  )
}

function ResultItem({
  thread,
  workspace,
  isSelected,
  onClick,
  onMouseEnter,
}: {
  thread: AgentThreadMeta
  workspace?: AgentWorkspace
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors duration-100',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate">{thread.title}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5">
          {relativeTime(thread.updatedAt)}
        </div>
      </div>
      {workspace && (
        <span className="ml-2 flex-shrink-0 text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
          {workspace.name}
        </span>
      )}
    </button>
  )
}
```

- [ ] **Step 2: 验证无编译错误**

Run: `cd apps/web && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无与 `CommandPalette` 相关的错误

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/command-palette/CommandPalette.tsx
git commit -m "feat(command-palette): create CommandPalette component with search and keyboard nav"
```

---

### Task 3: 接入 AppShell — 渲染面板 + Ctrl+K 快捷键

**Files:**
- Modify: `apps/web/src/components/app-shell/AppShell.tsx`

- [ ] **Step 1: 修改 AppShell.tsx**

将 `apps/web/src/components/app-shell/AppShell.tsx` 的内容替换为：

```tsx
import { LeftSidebar } from './LeftSidebar'
import { TitleBar } from './TitleBar'
import { MainArea } from '@/components/tabs/MainArea'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { useSetAtom } from 'jotai'
import { commandPaletteOpenAtom } from '@/atoms'
import { useEffect } from 'react'

export function AppShell() {
  const setOpen = useSetAtom(commandPaletteOpenAtom)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setOpen])

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
      <TitleBar />
      <div className="p-2 pr-0 relative z-[60]">
        <LeftSidebar />
      </div>
      <div className="flex-1 min-w-0 p-2 relative z-[60]">
        <MainArea />
      </div>
      <CommandPalette />
    </div>
  )
}
```

关键改动：
- 导入 `CommandPalette`、`commandPaletteOpenAtom`、`useSetAtom`、`useEffect`
- 添加 `useEffect` 注册全局 `Ctrl+K` 快捷键（toggle 开关）
- 在 JSX 末尾渲染 `<CommandPalette />`

- [ ] **Step 2: 验证无编译错误**

Run: `cd apps/web && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/app-shell/AppShell.tsx
git commit -m "feat(command-palette): wire CommandPalette into AppShell with Ctrl+K shortcut"
```

---

### Task 4: 接入侧边栏搜索按钮

**Files:**
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`

- [ ] **Step 1: 修改搜索按钮 onClick**

在 `apps/web/src/components/app-shell/LeftSidebar.tsx` 中：

1. 在文件顶部导入区添加：

```ts
import { commandPaletteOpenAtom } from '@/atoms'
```

2. 在 `LeftSidebar` 函数体内（约第 46 行附近，其他 atom 声明旁）添加：

```ts
const setOpen = useSetAtom(commandPaletteOpenAtom)
```

注意：需要在导入中添加 `useSetAtom`：

```ts
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
```

3. 修改展开状态下的搜索按钮（第 202 行），将 `onClick={() => {}}` 改为：

```tsx
<SidebarAction icon={<Search size={17} />} label="搜索" onClick={() => setOpen(true)} />
```

4. 修改折叠状态下的搜索按钮（约第 149 行），添加 onClick：

```tsx
<button onClick={() => setOpen(true)} title="搜索" className="size-8 flex items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors">
```

- [ ] **Step 2: 验证无编译错误**

Run: `cd apps/web && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/app-shell/LeftSidebar.tsx
git commit -m "feat(command-palette): wire sidebar search button to open command palette"
```

---

### Task 5: 验证与最终提交

- [ ] **Step 1: 完整类型检查**

Run: `cd apps/web && npx tsc --noEmit --pretty`
Expected: 0 errors

- [ ] **Step 2: 启动开发服务器手动验证**

Run: `cd apps/web && npm run dev`

验证清单：
1. 按 `Ctrl+K` → 命令面板居中弹出，半透明遮罩
2. 面板打开时输入框自动聚焦
3. 输入关键词 → 实时显示匹配线程（标题 + 工作区标签 + 时间）
4. `↑` `↓` 键切换选中项（高亮背景）
5. `Enter` 打开选中线程 → 面板关闭 → 切换到对应标签页
6. `Esc` 或点击遮罩 → 面板关闭
7. 侧边栏展开状态点击"搜索"按钮 → 命令面板打开
8. 侧边栏折叠状态点击搜索图标 → 命令面板打开
9. 搜索不存在的关键词 → 显示"未找到匹配的线程"
10. 清空搜索词 → 回到空状态

- [ ] **Step 3: 最终提交（如有遗漏修复）**

```bash
git add -A
git commit -m "feat(command-palette): finalize command palette search feature"
```
