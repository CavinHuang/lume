# 会话顶部「更多操作」菜单 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `AgentHeader` 顶部的 `WorkspacePicker` 替换为「⋯」更多操作菜单，集成切换工作区、置顶、重命名、归档、复制（工作目录/会话ID/Markdown）、Fork。

**Architecture:** 新建独立组件 `ThreadMoreActions`（SRP，与列表项 `ThreadItemActions` 同构）。会话写操作（置顶/重命名/归档）抽到共享 hook `useThreadActions`（复刻 `LeftSidebar.tsx:148-208`，供 `AgentHeader` 树使用；列表项本期不动）。会话→Markdown 抽纯函数 `threadToMarkdown`。子菜单复用 base-ui 的 `Menu.SubmenuRoot`（在 `dropdown-menu.tsx` 加封装）。后端零改动——复用现有 `GET_WORKSPACE_ROOT_PATH` IPC。

**Tech Stack:** React + TypeScript + jotai（状态）、base-ui（DropdownMenu/Dialog）、lucide-react（图标）、sonner（toast）、`bun:test`（单测）、`@lume/shared`（IPC channel 常量）。

## Global Constraints

- **测试框架**：`bun:test`；组件测试用 `renderToStaticMarkup`（`react-dom/server`）+ jotai `Provider`/`createStore`（项目惯例，**非** jsdom/RTL，菜单展开态不测交互，只测渲染冒烟）。
- **跑测试**：用 `rtk` 前缀（项目 RTK 约定），如 `rtk bun test`。
- **注释语言**：中文（与现有代码一致）。
- **IPC 调用**：`sidecarCall<T>(channel, input?)` from `@/lib/desktop-api`；channel 用 `AGENT_IPC_CHANNELS.XXX`（from `@lume/shared`），不硬编码字面量（复制工作区根路径用 `AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH`）。
- **写操作的 channel 字面量**（hook 内按 `LeftSidebar` 现状沿用）：`'agent:toggle-pin-thread'`、`'agent:update-thread-title'`、`'agent:archive-thread'`、`'agent:fork-thread'`。
- **toast**：`import { toast } from 'sonner'`。
- **剪贴板**：`writeClipboardText(text)` from `@/lib/desktop-api`。
- **提交策略**：每个任务末尾的 `git commit` 步骤**需经用户确认后执行**（遵循项目规则「未主动要求不自动提交」）。commit message 用 emoji 前缀（项目惯例，如 `✨ feat(web): ...`）。
- **YAGNI 简化**：Fork 本期**不自动跳转**到新会话（依赖 tab 管理 + thread 列表刷新链路，超出范围），仅 `toast` 提示，记入技术债。

---

### Task 1: `threadToMarkdown` 纯函数

**Files:**
- Create: `apps/web/src/components/agent/thread-to-markdown.ts`
- Test: `apps/web/src/components/agent/thread-to-markdown.test.ts`

**Interfaces:**
- Produces: `threadToMarkdown(title: string, messages: AgentThreadMessage[]): string`（`AgentThreadMessage` from `@lume/shared`，字段 `{ id, role: 'user'|'assistant'|'tool'|'status', content, ... }`）

- [ ] **Step 1: 写失败测试**

创建 `apps/web/src/components/agent/thread-to-markdown.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { threadToMarkdown } from './thread-to-markdown'
import type { AgentThreadMessage } from '@lume/shared'

function msg(id: string, role: AgentThreadMessage['role'], content: string): AgentThreadMessage {
  return { id, role, content, createdAt: 0 } as AgentThreadMessage
}

describe('threadToMarkdown', () => {
  test('空会话只返回标题', () => {
    expect(threadToMarkdown('我的会话', [])).toBe('# 我的会话')
  })

  test('user 与 assistant 交替拼接', () => {
    const out = threadToMarkdown('T', [
      msg('1', 'user', '你好'),
      msg('2', 'assistant', '有何可以帮你？'),
    ])
    expect(out).toBe('# T\n\n## 👤 用户\n\n你好\n\n## 🤖 助手\n\n有何可以帮你？')
  })

  test('空 content 的消息被跳过', () => {
    const out = threadToMarkdown('T', [msg('1', 'user', '   '), msg('2', 'assistant', '有效')])
    expect(out).toBe('# T\n\n## 🤖 助手\n\n有效')
  })

  test('tool 角色使用工具标签', () => {
    const out = threadToMarkdown('T', [msg('1', 'tool', '读取文件')])
    expect(out).toContain('## 🔧 工具')
    expect(out).toContain('读取文件')
  })

  test('空标题使用兜底文案', () => {
    expect(threadToMarkdown('', [msg('1', 'user', 'hi')])).toContain('# 未命名会话')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk bun test apps/web/src/components/agent/thread-to-markdown.test.ts`
Expected: FAIL（`threadToMarkdown is not defined` / 模块不存在）

- [ ] **Step 3: 写最小实现**

创建 `apps/web/src/components/agent/thread-to-markdown.ts`：

```ts
import type { AgentThreadMessage } from '@lume/shared'

/** 角色 → Markdown 标题标签 */
const ROLE_LABEL: Record<AgentThreadMessage['role'], string> = {
  user: '👤 用户',
  assistant: '🤖 助手',
  tool: '🔧 工具',
  status: '📋 状态',
}

/**
 * 把会话消息列表拼接为 Markdown 文本，用于「复制为 Markdown」。
 * 跳过空内容消息；工具调用/结果仅以角色标签 + content 简述呈现（YAGNI，不做完整还原）。
 */
export function threadToMarkdown(title: string, messages: AgentThreadMessage[]): string {
  const header = `# ${title?.trim() || '未命名会话'}`
  if (messages.length === 0) return header

  const body = messages
    .map((m) => {
      const content = m.content?.trim() ?? ''
      if (!content) return null
      const label = ROLE_LABEL[m.role] ?? m.role
      return `## ${label}\n\n${content}`
    })
    .filter((line): line is string => line !== null)

  return [header, ...body].join('\n\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `rtk bun test apps/web/src/components/agent/thread-to-markdown.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 提交（经用户确认）**

```bash
rtk git add apps/web/src/components/agent/thread-to-markdown.ts apps/web/src/components/agent/thread-to-markdown.test.ts
rtk git commit -m "✨ feat(web): 新增 threadToMarkdown 会话转 Markdown 纯函数"
```

---

### Task 2: `useThreadActions` 共享 hook

**Files:**
- Create: `apps/web/src/components/agent/use-thread-actions.ts`
- Test: `apps/web/src/components/agent/use-thread-actions.test.ts`

**Interfaces:**
- Consumes: `agentThreadsAtom`、`tabsAtom`、`activeTabIdAtom`（from `@/atoms`）、`sidecarCall`（from `@/lib/desktop-api`）、`toast`（from `sonner`）
- Produces: `useThreadActions(threadId: string): { togglePin: () => Promise<void>; rename: (title: string) => Promise<void>; archive: () => Promise<void> }`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/src/components/agent/use-thread-actions.test.ts`：

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { useThreadActions } from './use-thread-actions'
import { agentThreadsAtom, tabsAtom, activeTabIdAtom } from '@/atoms'

// mock sidecarCall（捕获调用参数）
const sidecarCallMock = mock(() => Promise.resolve())
mock.module('@/lib/desktop-api', () => ({
  sidecarCall: sidecarCallMock,
  writeClipboardText: mock(() => Promise.resolve()),
  getThreadMessages: mock(() => Promise.resolve([])),
}))

// mock sonner toast（避免噪声）
mock.module('sonner', () => ({ toast: { error: mock(), success: mock() } }))

/** 渲染一个 Harness 捕获 hook 返回值（渲染期取值，不依赖 useEffect） */
function captureActions(threadId: string, store: ReturnType<typeof createStore>) {
  let captured: ReturnType<typeof useThreadActions> | null = null
  function Harness() {
    captured = useThreadActions(threadId)
    return null
  }
  renderToStaticMarkup(
    <Provider store={store}>
      <Harness />
    </Provider>,
  )
  return captured!
}

describe('useThreadActions', () => {
  beforeEach(() => sidecarCallMock.mockReset())

  test('togglePin 调用 toggle-pin-thread 并翻转 pinned', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: 'T', pinned: false }])
    const actions = captureActions('t1', store)
    await actions.togglePin()
    expect(sidecarCallMock).toHaveBeenCalledWith('agent:toggle-pin-thread', { threadId: 't1' })
    expect(store.get(agentThreadsAtom)[0].pinned).toBe(true)
  })

  test('rename 调用 update-thread-title 并更新 threads 与 tabs', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: '旧', pinned: false }])
    store.set(tabsAtom, [{ id: 't1', title: '旧', type: 'agent' }])
    const actions = captureActions('t1', store)
    await actions.rename('新标题')
    expect(sidecarCallMock).toHaveBeenCalledWith('agent:update-thread-title', { threadId: 't1', title: '新标题' })
    expect(store.get(agentThreadsAtom)[0].title).toBe('新标题')
    expect(store.get(tabsAtom)[0].title).toBe('新标题')
  })

  test('archive 调用 archive-thread，移除 thread/tab 并切走激活', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: 'T', pinned: false }])
    store.set(tabsAtom, [{ id: 't1', title: 'T', type: 'agent' }])
    store.set(activeTabIdAtom, 't1')
    const actions = captureActions('t1', store)
    await actions.archive()
    expect(sidecarCallMock).toHaveBeenCalledWith('agent:archive-thread', { threadId: 't1' })
    expect(store.get(agentThreadsAtom)).toHaveLength(0)
    expect(store.get(tabsAtom)).toHaveLength(0)
    expect(store.get(activeTabIdAtom)).toBeNull()
  })

  test('rename 空标题不发起请求', async () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: '原标题', pinned: false }])
    const actions = captureActions('t1', store)
    await actions.rename('   ')
    expect(sidecarCallMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk bun test apps/web/src/components/agent/use-thread-actions.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写最小实现**

创建 `apps/web/src/components/agent/use-thread-actions.ts`：

```ts
import { useAtom, useSetAtom } from 'jotai'
import { agentThreadsAtom, tabsAtom, activeTabIdAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { toast } from 'sonner'

/**
 * 会话写操作 hook：置顶 / 重命名 / 归档。
 * 复刻 LeftSidebar.tsx:148-208 的逻辑，供 AgentHeader 树使用（列表项本期不改，留待收敛）。
 * 归档不做二次确认（顶部菜单直接执行；归档可恢复）。
 */
export function useThreadActions(threadId: string) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const togglePin = async (): Promise<void> => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    try {
      await sidecarCall('agent:toggle-pin-thread', { threadId: thread.id })
      setThreads((prev) =>
        prev.map((item) => (item.id === thread.id ? { ...item, pinned: !item.pinned } : item)),
      )
    } catch (error) {
      console.error('[useThreadActions] 置顶失败:', error)
      toast.error('操作失败')
    }
  }

  const rename = async (title: string): Promise<void> => {
    const thread = threads.find((item) => item.id === threadId)
    const trimmed = title.trim()
    if (!thread || !trimmed || trimmed === thread.title) return
    try {
      await sidecarCall('agent:update-thread-title', { threadId: thread.id, title: trimmed })
      setThreads((prev) =>
        prev.map((item) => (item.id === thread.id ? { ...item, title: trimmed } : item)),
      )
      setTabs((prev) => prev.map((tab) => (tab.id === thread.id ? { ...tab, title: trimmed } : tab)))
    } catch (error) {
      console.error('[useThreadActions] 重命名失败:', error)
      toast.error('重命名失败')
    }
  }

  const archive = async (): Promise<void> => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    try {
      await sidecarCall('agent:archive-thread', { threadId: thread.id })
      setThreads((prev) => prev.filter((item) => item.id !== thread.id))
      setTabs((prev) => prev.filter((tab) => tab.id !== thread.id))
      setActiveTabId((prev) => (prev === thread.id ? null : prev))
      toast.success('已归档')
    } catch (error) {
      console.error('[useThreadActions] 归档失败:', error)
      toast.error('归档失败')
    }
  }

  return { togglePin, rename, archive }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `rtk bun test apps/web/src/components/agent/use-thread-actions.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 提交（经用户确认）**

```bash
rtk git add apps/web/src/components/agent/use-thread-actions.ts apps/web/src/components/agent/use-thread-actions.test.ts
rtk git commit -m "✨ feat(web): 新增 useThreadActions 会话写操作共享 hook"
```

---

### Task 3: `dropdown-menu.tsx` 加 SubMenu 封装

base-ui 已支持子菜单（`Menu.SubmenuRoot` / `Menu.SubmenuTrigger`），项目 `dropdown-menu.tsx` 未封装。本任务加 3 个封装组件，供 Task 4 使用。

**Files:**
- Modify: `apps/web/src/components/ui/dropdown-menu.tsx`

**Interfaces:**
- Produces: `DropdownMenuSub`（= `Menu.SubmenuRoot`）、`DropdownMenuSubTrigger`（= `Menu.SubmenuTrigger`）、`DropdownMenuSubContent`（= 嵌套 `Menu.Portal`/`Menu.Positioner`/`Menu.Popup`，结构与 `DropdownMenuContent` 一致）

- [ ] **Step 1: 加 3 个封装组件**

在 `apps/web/src/components/ui/dropdown-menu.tsx` 的 `DropdownMenuSeparator` 函数**之后**、`export { ... }` **之前**插入：

```tsx
function DropdownMenuSub({ ...props }: Menu.SubmenuRoot.Props) {
  return <Menu.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({ className, ...props }: Menu.SubmenuTrigger.Props) {
  return (
    <Menu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)] transition-colors cursor-default',
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSubContent({ className, children, ...props }: Menu.Popup.Props & { className?: string }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} align="start" className="z-[9999]">
        <Menu.Popup
          data-slot="dropdown-menu-sub-content"
          className={cn(
            'min-w-[140px] overflow-hidden rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_80%,transparent)] bg-[var(--surface-1)] p-1 shadow-[0_24px_48px_-32px_hsl(var(--shadow-panel)/0.5)] animate-in fade-in-0 zoom-in-95',
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
```

- [ ] **Step 2: 更新 export 语句**

把文件末尾的 export 行：

```tsx
export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator }
```

改为：

```tsx
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
```

- [ ] **Step 3: 类型检查**

Run: `rtk tsc`
Expected: 无新增错误（仅可能出现本任务无关的既有错误，确认 dropdown-menu 相关无报错即可）

- [ ] **Step 4: 提交（经用户确认）**

```bash
rtk git add apps/web/src/components/ui/dropdown-menu.tsx
rtk git commit -m "✨ feat(web): dropdown-menu 新增 SubMenu 三件套封装"
```

---

### Task 4: `ThreadMoreActions` 组件

**Files:**
- Create: `apps/web/src/components/agent/ThreadMoreActions.tsx`
- Test: `apps/web/src/components/agent/ThreadMoreActions.test.tsx`

**Interfaces:**
- Consumes: `useThreadActions(threadId)`（Task 2）、`threadToMarkdown`（Task 1）、`DropdownMenuSub/SubTrigger/SubContent`（Task 3）、`agentThreadsAtom`/`agentWorkspacesAtom`/`currentWorkspaceIdAtom`（`@/atoms`）、`getThreadMessages`/`writeClipboardText`/`sidecarCall`（`@/lib/desktop-api`）、`AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH` / `FORK_THREAD`（`@lume/shared`）、`Dialog*`（`@/components/ui/dialog`）
- Produces: `ThreadMoreActions({ threadId: string; readOnly?: boolean }): JSX.Element`（供 Task 5 的 `AgentHeader` 使用）

- [ ] **Step 1: 写渲染冒烟测试**

创建 `apps/web/src/components/agent/ThreadMoreActions.test.tsx`（菜单展开态在 SSR 下不渲染 popup，故只测触发按钮渲染冒烟；交互由 Task 2 的 hook 测试 + 手验覆盖）：

```tsx
import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ThreadMoreActions } from './ThreadMoreActions'
import { agentThreadsAtom } from '@/atoms'

describe('ThreadMoreActions', () => {
  test('渲染「更多操作」触发按钮', () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: '我的会话', pinned: false }])
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <ThreadMoreActions threadId="t1" />
      </Provider>,
    )
    expect(html).toContain('更多操作')
  })

  test('readOnly 模式渲染不抛错', () => {
    const store = createStore()
    store.set(agentThreadsAtom, [{ id: 't1', title: 'T', pinned: false }])
    expect(() =>
      renderToStaticMarkup(
        <Provider store={store}>
          <ThreadMoreActions threadId="t1" readOnly />
        </Provider>,
      ),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk bun test apps/web/src/components/agent/ThreadMoreActions.test.tsx`
Expected: FAIL（`ThreadMoreActions` 不存在）

- [ ] **Step 3: 写实现**

创建 `apps/web/src/components/agent/ThreadMoreActions.tsx`：

```tsx
import { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Archive,
  Check,
  FolderTree,
  Copy,
  FileText,
  GitBranch,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall, writeClipboardText, getThreadMessages } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { useThreadActions } from './use-thread-actions'
import { threadToMarkdown } from './thread-to-markdown'

interface ThreadMoreActionsProps {
  threadId: string
  readOnly?: boolean
}

/** 会话顶部「更多操作」菜单：工作区切换 / 置顶·重命名·归档 / 复制 / Fork。 */
export function ThreadMoreActions({ threadId, readOnly = false }: ThreadMoreActionsProps) {
  const thread = useAtomValue(agentThreadsAtom).find((t) => t.id === threadId)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const actions = useThreadActions(threadId)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const currentWorkspace = workspaces.find((w) => w.id === currentId) ?? workspaces[0]
  const pinned = thread?.pinned ?? false

  // 复制当前工作区绝对路径（复用现有 GET_WORKSPACE_ROOT_PATH IPC）
  const handleCopyPath = async (): Promise<void> => {
    if (!currentWorkspace?.slug) {
      toast.error('当前无工作区')
      return
    }
    try {
      const path = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH, {
        workspaceSlug: currentWorkspace.slug,
      })
      await writeClipboardText(path)
      toast.success('已复制工作目录')
    } catch (error) {
      console.error('[ThreadMoreActions] 复制工作目录失败:', error)
      toast.error('复制失败')
    }
  }

  const handleCopyThreadId = async (): Promise<void> => {
    try {
      await writeClipboardText(threadId)
      toast.success('已复制会话 ID')
    } catch (error) {
      console.error('[ThreadMoreActions] 复制会话 ID 失败:', error)
      toast.error('复制失败')
    }
  }

  const handleCopyMarkdown = async (): Promise<void> => {
    try {
      const messages = await getThreadMessages(threadId)
      const md = threadToMarkdown(thread?.title ?? '未命名会话', messages)
      await writeClipboardText(md)
      toast.success('已复制为 Markdown')
    } catch (error) {
      console.error('[ThreadMoreActions] 复制 Markdown 失败:', error)
      toast.error('复制失败')
    }
  }

  // Fork：整体分叉（取最后一条消息 id），本期不自动跳转（见技术债）
  const handleFork = async (): Promise<void> => {
    try {
      const messages = await getThreadMessages(threadId)
      const last = messages[messages.length - 1]
      if (!last) {
        toast.error('空会话无法 Fork')
        return
      }
      await sidecarCall<{ newThreadId: string }>(AGENT_IPC_CHANNELS.FORK_THREAD, {
        threadId,
        upToMessageId: last.id,
      })
      toast.success('已创建分叉，请在侧栏查看')
    } catch (error) {
      console.error('[ThreadMoreActions] Fork 失败:', error)
      toast.error('Fork 失败')
    }
  }

  const openRename = (): void => {
    setRenameValue(thread?.title ?? '')
    setRenameOpen(true)
  }

  const confirmRename = async (): Promise<void> => {
    setRenameOpen(false)
    await actions.rename(renameValue)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="更多操作"
              className="flex-shrink-0 p-0.5 rounded text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)] transition-colors"
            >
              <MoreHorizontal size={16} />
            </button>
          }
        />
        <DropdownMenuContent>
          {/* 切换工作区（全局当前工作区，沿用 WorkspacePicker 语义） */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderTree size={14} />
              切换工作区
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {workspaces.map((w) => (
                <DropdownMenuItem key={w.id} onClick={() => setCurrentId(w.id)}>
                  <span className="flex-1 truncate">{w.name}</span>
                  {currentId === w.id && <Check size={12} className="text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* 会话管理（readOnly 下禁用） */}
          <DropdownMenuItem disabled={readOnly} onClick={() => actions.togglePin()}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onClick={openRename}>
            <Pencil size={14} />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onClick={() => actions.archive()}>
            <Archive size={14} />
            归档
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* 复制（readOnly 下仍启用） */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Copy size={14} />
              复制
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={handleCopyPath}>
                <FolderTree size={14} />
                复制工作目录
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyThreadId}>
                <FileText size={14} />
                复制会话 ID
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyMarkdown}>
                <FileText size={14} />
                复制为 Markdown
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* Fork（readOnly 下禁用） */}
          <DropdownMenuItem disabled={readOnly} onClick={handleFork}>
            <GitBranch size={14} />
            Fork 分支
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 重命名弹窗：与菜单外置，避免 base-ui 焦点冲突 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmRename()
            }}
            autoFocus
            className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary"
          />
          <DialogFooter>
            <button
              type="button"
              onClick={() => setRenameOpen(false)}
              className="px-3 py-1.5 rounded-md text-[12px] text-foreground/70 hover:bg-muted/50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void confirmRename()}
              className="px-3 py-1.5 rounded-md text-[12px] bg-primary text-primary-foreground hover:bg-primary/90"
            >
              确认
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `rtk bun test apps/web/src/components/agent/ThreadMoreActions.test.tsx`
Expected: PASS（2 个用例：触发按钮渲染、readOnly 不抛错）

- [ ] **Step 5: 类型检查**

Run: `rtk tsc`
Expected: 无 `ThreadMoreActions` 相关错误

- [ ] **Step 6: 提交（经用户确认）**

```bash
rtk git add apps/web/src/components/agent/ThreadMoreActions.tsx apps/web/src/components/agent/ThreadMoreActions.test.tsx
rtk git commit -m "✨ feat(web): 新增会话顶部更多操作菜单 ThreadMoreActions"
```

---

### Task 5: `AgentHeader` 接线 + 删除 `WorkspacePicker`

**Files:**
- Modify: `apps/web/src/components/agent/AgentHeader.tsx`（替换 `WorkspacePicker` → `ThreadMoreActions`，调整布局把菜单移到最右侧）
- Delete: `apps/web/src/components/agent/WorkspacePicker.tsx`
- Cleanup: 检查并删除仅被 `WorkspacePicker` 使用的 `agentWorkspaceCapabilitiesAtom`（若存在孤儿引用）

**Interfaces:**
- Consumes: `ThreadMoreActions`（Task 4）

- [ ] **Step 1: 改 `AgentHeader.tsx` 的 import**

把第 4 行：

```tsx
import { WorkspacePicker } from './WorkspacePicker'
```

改为：

```tsx
import { ThreadMoreActions } from './ThreadMoreActions'
```

- [ ] **Step 2: 改 `AgentHeader.tsx` 的 render**

把 `return (` 内的结构（当前把 `WorkspacePicker` 夹在标题与状态徽章之间）：

```tsx
    <div className="flex items-center px-4 py-3 border-b border-border/50 gap-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground truncate">
          {thread?.title ?? '新会话'}
        </span>
        {!readOnly && <WorkspacePicker />}
        {phaseStyle && (
          <span
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-foreground/[0.04] text-[11px] font-medium flex-shrink-0',
              phaseStyle.text
            )}
          >
            <span className={cn('size-1.5 rounded-full', phaseStyle.dot)} />
            {isStreaming && toolName
              ? `第 ${toolStepCount} 步 · ${toolName}`
              : phaseStyle.label}
            {runtimeStatus?.queuedCount ? ` · 队列 ${runtimeStatus.queuedCount}` : ''}
          </span>
        )}
      </div>
    </div>
```

改为（移除 `WorkspacePicker`，把 `ThreadMoreActions` 放到外层容器最右侧）：

```tsx
    <div className="flex items-center px-4 py-3 border-b border-border/50 gap-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[14px] font-medium text-foreground truncate">
          {thread?.title ?? '新会话'}
        </span>
        {phaseStyle && (
          <span
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-foreground/[0.04] text-[11px] font-medium flex-shrink-0',
              phaseStyle.text
            )}
          >
            <span className={cn('size-1.5 rounded-full', phaseStyle.dot)} />
            {isStreaming && toolName
              ? `第 ${toolStepCount} 步 · ${toolName}`
              : phaseStyle.label}
            {runtimeStatus?.queuedCount ? ` · 队列 ${runtimeStatus.queuedCount}` : ''}
          </span>
        )}
      </div>
      <ThreadMoreActions threadId={threadId} readOnly={readOnly} />
    </div>
```

> **实施修正（用户反馈，2026-07-03）**：「⋯」位置应为**紧挨标题右侧**（原 `WorkspacePicker` 位：标题后、状态徽章前），**非**外层最右。Step 2 的代码示例是最初设计（最右），实际实现已改为「标题后、状态徽章前」——以 `AgentHeader.tsx` 实际代码为准。

- [ ] **Step 3: 删除 `WorkspacePicker.tsx`**

```bash
rtk git rm apps/web/src/components/agent/WorkspacePicker.tsx
```

- [ ] **Step 4: 检查并清理孤儿 atom**

Run: `rtk grep "agentWorkspaceCapabilitiesAtom" apps/web/src`
- 若仅剩 `apps/web/src/atoms/...` 的定义处、且无其他消费方 → 从其定义文件删除该 atom 及其 import。
- 若仍有其他消费方 → 保留（surgical，不动）。

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `rtk tsc`
Expected: 无 `WorkspacePicker` 残留引用错误（`AgentHeader`、`McpSettings.tsx:285` 的注释提及不影响编译）

Run: `rtk bun test apps/web/src/components/agent`
Expected: Task 1/2/4 的测试全绿，无回归

- [ ] **Step 6: 手验（开发环境实跑）**

启动开发环境（`rtk pnpm dev` 或项目对应脚本），逐项验证：
- 点击顶部 `⋯` → 菜单展开，分组顺序：切换工作区 / 置顶·重命名·归档 / 复制 / Fork。
- 切换工作区子菜单：列出工作区，当前项打勾，点击切换。
- 置顶：标题区状态变化（侧栏同步打勾）。
- 重命名：弹窗输入 → 确认 → 顶部标题与侧栏更新。
- 归档：当前会话 tab 关闭、激活切走、侧栏移除。
- 复制工作目录 / 会话 ID / Markdown：剪贴板内容正确、toast 成功。
- Fork：toast「已创建分叉」，侧栏出现新分叉会话。
- readOnly 会话：置顶/重命名/归档/Fork 禁用，切换工作区/复制可用。

- [ ] **Step 7: 提交（经用户确认）**

```bash
rtk git add apps/web/src/components/agent/AgentHeader.tsx
rtk git commit -m "🔧 refactor(web): AgentHeader 用更多操作菜单替换 WorkspacePicker"
```

---

## 技术债（本计划产生，记入设计规范 §14）

- Fork 后**不自动跳转**到新会话（本期仅 toast）；跳转需打通 tab 创建 + thread 列表刷新链路。
- `LeftSidebar` 顶层 `togglePin`/`renameThread`/`deleteThread` 未迁移到 `useThreadActions`，存在两套调用同一 IPC 的路径——未来收敛。
- 「复制为 Markdown」的工具调用/结果仅为角色标签 + content 简述，未做完整还原。
