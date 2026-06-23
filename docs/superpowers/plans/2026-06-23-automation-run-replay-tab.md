# 自动化执行记录只读回放 tab 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自动化任务详情的运行历史记录中，点击某条执行记录可新开一个应用内只读 tab，回放该次自动化运行对应的 agent 会话（对话 + 工具调用流）。

**Architecture:** 以 `AutomationRun.threadId` 为 tab id，构造一个带 `readOnly: true` 标记的 agent tab（复用现有 `upsertTab` + `tabsAtom`/`activeTabIdAtom` 模式）。`AgentView` 接受 `readOnly` prop，为 true 时屏蔽输入区与交互浮层，复用 `AgentMessages` 的历史会话渲染能力。把"由运行记录构造并应用只读 tab"的逻辑抽成纯函数 `automation-run-replay.ts`，便于在 `bun:test` 中直接测试，绕开对 1590 行组件的渲染测试。后端（sidecar）零改动。

**Tech Stack:** React 18 + Jotai（状态管理）+ Tauri（桌面壳）+ Tailwind + bun:test（测试，SSR + 手写 fake DOM）。无 URL 路由，导航靠 `tabsAtom`/`activeTabIdAtom`。

## Global Constraints

- 测试运行器为 `bun:test`（**不是** vitest/jest）。运行单测：`cd apps/web && bun test <path>`。monorepo 用 **bun**（`bun@1.3.13`）。
- 路径别名：`@/*` → `apps/web/src/*`（`tsconfig.json` 与 `vite.config.ts` 一致，bun:test 认 tsconfig paths）。
- 仓库无共享日期格式化工具，时间格式化需内联（本计划提供 `formatRunTime`）。
- 后端（`apps/sidecar`、`packages/sdk`）**零改动**。
- 默认（非只读）`AgentView` 行为必须**完全不变**：`readOnly` 默认 `false`，现有渲染路径保持原样。
- 类型检查命令：`cd apps/web && bun run typecheck`。
- 提交信息风格：`<emoji> <type>(<scope>): <中文描述>`，与仓库现有提交一致（如 `✨ feat(web): ...`）。
- 遵循项目 CLAUDE.md：仅改动与请求直接相关的行；匹配既有风格；不重构无关代码。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `apps/web/src/atoms/tab-atoms.ts` | `Tab` 类型定义 | 修改：加 `readOnly?: boolean` |
| `apps/web/src/components/automation/automation-run-replay.ts` | 由运行记录构造/应用只读回放 tab 的纯函数 + 时间格式化 | 新建 |
| `apps/web/src/components/automation/automation-run-replay.test.ts` | 上述纯函数的 `bun:test` 单测 | 新建 |
| `apps/web/src/components/agent/AgentView.tsx` | 会话视图，加 `readOnly` 模式 | 修改 |
| `apps/web/src/components/agent/AgentHeader.tsx` | 会话头，加 `readOnly`（隐藏工作区选择器） | 修改 |
| `apps/web/src/components/agent/AgentView.test.tsx` | 既有测试，加只读渲染用例 | 修改 |
| `apps/web/src/components/agent/AgentHeader.test.tsx` | AgentHeader 只读行为 SSR 单测 | 新建 |
| `apps/web/src/components/tabs/TabContent.tsx` | tab 派发，透传 `readOnly` | 修改 |
| `apps/web/src/components/automation/AutomationManagementView.tsx` | 运行历史项可点击化 | 修改 |

**设计取舍（为何抽 `automation-run-replay.ts`）**：本仓库 97 个测试文件中只有 3 个做完整客户端交互渲染，绝大多数是"逻辑放 `.ts`、纯函数直接测"的范式。`AutomationManagementView` 是 1590 行且当前无测试的重型组件，对它做"渲染→点击→断言 atom"既脆弱又昂贵。因此把可验证的核心逻辑（构造 tab、应用到 tabs）抽成纯函数，组件里只留 4 行接线。

---

## Task 1: Tab 类型 + 回放 tab 纯函数 + 单测

**Files:**
- Modify: `apps/web/src/atoms/tab-atoms.ts:8-20`（`Tab` 接口）
- Create: `apps/web/src/components/automation/automation-run-replay.ts`
- Create: `apps/web/src/components/automation/automation-run-replay.test.ts`

**Interfaces:**
- Produces:
  - `Tab.readOnly?: boolean`（新增可选字段）
  - `formatRunTime(timestamp: number): string` — 形如 `MM-DD HH:mm`（本地时区）
  - `buildAutomationRunReplayTab(run: AutomationRun): Tab | null` — 有 `threadId` 返回 `{ id: threadId, type:'agent', title, threadId, readOnly:true }`；无则 `null`
  - `openAutomationRunReplay(run: AutomationRun, tabs: Tab[]): { tabs: Tab[]; activeTabId: string } | null` — 把回放 tab `upsertTab` 进 `tabs` 并返回新数组与应激活的 tabId；无 `threadId` 返回 `null`（无副作用）

- [ ] **Step 1: 写失败测试（`automation-run-replay.test.ts`）**

创建 `apps/web/src/components/automation/automation-run-replay.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import type { AutomationRun } from '@lume/shared'
import { formatRunTime, buildAutomationRunReplayTab, openAutomationRunReplay } from './automation-run-replay'

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    jobId: 'job-1',
    jobName: '每晚报告',
    threadId: 'thread-1',
    trigger: 'schedule',
    status: 'success',
    message: '',
    startedAt: new Date('2026-01-02T03:04:56').getTime(),
    finishedAt: new Date('2026-01-02T03:05:00').getTime(),
    ...overrides,
  }
}

describe('formatRunTime', () => {
  test('formats a timestamp as MM-DD HH:mm in local time', () => {
    // 输入为本地时间字符串（无 Z），输出也取本地分量，故与时区无关、稳定
    const ts = new Date('2026-03-04T05:06:00').getTime()
    expect(formatRunTime(ts)).toBe('03-04 05:06')
  })
})

describe('buildAutomationRunReplayTab', () => {
  test('builds a read-only agent tab keyed by threadId with composed title', () => {
    expect(buildAutomationRunReplayTab(makeRun())).toEqual({
      id: 'thread-1',
      type: 'agent',
      title: '自动化·每晚报告 · 01-02 03:04',
      threadId: 'thread-1',
      readOnly: true,
    })
  })

  test('returns null when the run has no threadId', () => {
    expect(buildAutomationRunReplayTab(makeRun({ threadId: undefined }))).toBeNull()
  })
})

describe('openAutomationRunReplay', () => {
  test('upserts the read-only tab and returns its id as active', () => {
    const existing = [{ id: 'other', type: 'agent' as const, title: '其它', threadId: 'other' }]
    const result = openAutomationRunReplay(makeRun(), existing)
    expect(result?.activeTabId).toBe('thread-1')
    expect(result?.tabs).toHaveLength(2)
    expect(result?.tabs.find((t) => t.id === 'thread-1')).toMatchObject({ readOnly: true })
  })

  test('dedupes by threadId (upserts in place instead of appending)', () => {
    const existing = [{ id: 'thread-1', type: 'agent' as const, title: '旧标题', threadId: 'thread-1' }]
    const result = openAutomationRunReplay(makeRun(), existing)
    expect(result?.tabs).toHaveLength(1)
    expect(result?.tabs[0]).toMatchObject({
      title: '自动化·每晚报告 · 01-02 03:04',
      readOnly: true,
    })
  })

  test('returns null (no-op) when the run has no threadId', () => {
    expect(openAutomationRunReplay(makeRun({ threadId: undefined }), [])).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/web && bun test src/components/automation/automation-run-replay.test.ts`
Expected: FAIL — 报错 `Cannot find module './automation-run-replay'`（文件尚未创建）。

- [ ] **Step 3: 在 `Tab` 接口加 `readOnly`**

修改 `apps/web/src/atoms/tab-atoms.ts`，在 `threadId?: string` 下一行加入：

```ts
export interface Tab {
  id: string
  type: TabType
  title: string
  threadId?: string
  readOnly?: boolean
  settingsTab?: SettingsTab
  workspaceId?: string
  filePath?: string
  fileSource?: FileTabSource
  workspaceSlug?: string
  sourcePath?: string
  browserUrl?: string
}
```

- [ ] **Step 4: 实现纯函数（`automation-run-replay.ts`）**

创建 `apps/web/src/components/automation/automation-run-replay.ts`：

```ts
import type { Tab } from '@/atoms'
import type { AutomationRun } from '@lume/shared'
import { upsertTab } from '@/components/tabs/file-tabs'

/** 把时间戳格式化为 MM-DD HH:mm（本地时区）。 */
export function formatRunTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 根据一次自动化运行构造只读回放 tab；运行无 threadId 时返回 null。 */
export function buildAutomationRunReplayTab(run: AutomationRun): Tab | null {
  if (!run.threadId) return null
  return {
    id: run.threadId,
    type: 'agent',
    title: `自动化·${run.jobName} · ${formatRunTime(run.startedAt)}`,
    threadId: run.threadId,
    readOnly: true,
  }
}

/** 把运行记录的只读回放 tab 应用到当前 tabs：返回新的 tabs 与应激活的 tabId；无可回放会话时返回 null。 */
export function openAutomationRunReplay(
  run: AutomationRun,
  tabs: Tab[],
): { tabs: Tab[]; activeTabId: string } | null {
  const tab = buildAutomationRunReplayTab(run)
  if (!tab) return null
  return { tabs: upsertTab(tabs, tab), activeTabId: tab.id }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd apps/web && bun test src/components/automation/automation-run-replay.test.ts`
Expected: PASS（6 个 test 全过）。

- [ ] **Step 6: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 无新增错误。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/atoms/tab-atoms.ts \
        apps/web/src/components/automation/automation-run-replay.ts \
        apps/web/src/components/automation/automation-run-replay.test.ts
git commit -m "✨ feat(web): 新增自动化运行记录只读回放 tab 构造纯函数"
```

---

## Task 2: AgentView / AgentHeader 只读模式 + 测试

**Files:**
- Modify: `apps/web/src/components/agent/AgentView.tsx`
- Modify: `apps/web/src/components/agent/AgentHeader.tsx`
- Modify: `apps/web/src/components/agent/AgentView.test.tsx`（在文件末尾、最后一个 `})` 之前新增一个 `describe` 块）
- Create: `apps/web/src/components/agent/AgentHeader.test.tsx`

**Interfaces:**
- Consumes: `Tab.readOnly?: boolean`（Task 1 产出）
- Produces:
  - `AgentViewProps` 增加 `readOnly?: boolean`
  - `AgentHeaderProps` 增加 `readOnly?: boolean`

- [ ] **Step 1: 在 `AgentView.test.tsx` 末尾加只读失败测试**

在 `apps/web/src/components/agent/AgentView.test.tsx` 文件**最末尾**（最后一个 `})` 之后追加一个新的 `describe` 块，复用文件顶部已有的 mock 与 `installFakeDom`：

```tsx
describe('AgentView readOnly replay mode', () => {
  test('hides the input composer when readOnly', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [
      { id: 'thread-1', type: 'agent', title: 'Replay', threadId: 'thread-1' },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Replay',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      { id: 'workspace-1', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(agentPendingInteractiveAtom, {})

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView threadId="thread-1" readOnly />
          </Provider>,
        )
        await flush()
      })

      // AgentInput 被 mock 成 <div>agent-input</div>；只读时不应渲染
      expect(container.textContent).not.toContain('agent-input')
      // 消息流仍应渲染
      expect(container.textContent).toContain('agent-messages')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })

  test('renders the input composer by default (regression guard)', async () => {
    const { container, cleanup } = installFakeDom()
    const store = createStore()
    store.set(tabsAtom, [
      { id: 'thread-1', type: 'agent', title: 'Chat', threadId: 'thread-1' },
    ])
    store.set(activeTabIdAtom, 'thread-1')
    store.set(agentThreadsAtom, [
      {
        id: 'thread-1',
        title: 'Chat',
        workspaceId: 'workspace-1',
        pinned: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    store.set(agentWorkspacesAtom, [
      { id: 'workspace-1', name: 'Workspace', slug: 'workspace', createdAt: 1, updatedAt: 2 },
    ])
    store.set(currentWorkspaceIdAtom, 'workspace-1')
    store.set(agentStreamingStatesAtom, { 'thread-1': 'idle' })
    store.set(rightPanelWorkspacesAtom, {})
    store.set(agentPendingInteractiveAtom, {})

    let root: Root | null = createRoot(container as never)
    try {
      await act(async () => {
        root!.render(
          <Provider store={store}>
            <AgentView threadId="thread-1" />
          </Provider>,
        )
        await flush()
      })

      // 默认（非只读）仍渲染输入框
      expect(container.textContent).toContain('agent-input')
    } finally {
      await act(async () => {
        root?.unmount()
        root = null
        await flush()
      })
      cleanup()
    }
  })
})
```

- [ ] **Step 2: 运行测试，确认只读用例失败**

Run: `cd apps/web && bun test src/components/agent/AgentView.test.tsx`
Expected: 新增的 `hides the input composer when readOnly` **FAIL**（当前 `readOnly` prop 不存在，输入框仍渲染 → `toContain('agent-input')` 成立，`.not` 断言失败）。`renders the input composer by default` 应通过（回归）。

- [ ] **Step 3: 实现 AgentView 只读模式**

修改 `apps/web/src/components/agent/AgentView.tsx`：

3a. 修改 props 接口与函数签名（`:36-40`）：

```tsx
interface AgentViewProps {
  threadId: string
  readOnly?: boolean
}

export function AgentView({ threadId, readOnly }: AgentViewProps) {
```

3b. 修改桌面拖拽 effect（`:153-188`），在函数体最前加 `readOnly` 守卫，并把 `readOnly` 加入依赖数组：

```tsx
  useEffect(() => {
    if (readOnly) return
    let disposed = false
    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        unlisten = await getCurrentWindow().onDragDropEvent(async (event) => {
          if (disposed) return
          const payload = event.payload as DragDropPayload

          if (isFileDragPayload(payload)) {
            setIsDragOver(payload.type === 'enter')
          } else if (payload.type === 'leave') {
            setIsDragOver(false)
          }

          if (payload.type !== 'drop') return
          setIsDragOver(false)
          try {
            const attachments = await createPendingAttachmentsFromSourcePaths(payload.paths)
            if (attachments.length === 0) return
            addPendingAttachments(attachments)
            toast.success(`已添加 ${attachments.length} 个文件`)
          } catch (error) {
            console.error('[AgentView] 桌面文件拖拽读取失败:', error)
            toast.error('文件读取失败')
          }
        })
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [addPendingAttachments, threadId, readOnly])
```

3c. 修改 `AgentHeader` 调用（`:199`），透传 `readOnly`：

```tsx
          <AgentHeader threadId={threadId} readOnly={readOnly} />
```

3d. 修改输入区整块（`:208-243`），用 `{!readOnly && ( ...)}` 包裹整块输入区与交互浮层。把原：

```tsx
          <div className="relative">
            <div
              aria-hidden={hasComposerOverlay && (!activeTaskApproval || approvalOverlayVisible)}
              className={cn(
                hasComposerOverlay && (!activeTaskApproval || approvalOverlayVisible) && 'pointer-events-none select-none opacity-0',
              )}
            >
              <AgentInput
                threadId={threadId}
                streaming={streamingState === 'streaming'}
                pendingAttachments={pendingAttachments}
                onAddPendingAttachments={addPendingAttachments}
                onRemovePendingAttachment={removePendingAttachment}
                onClearPendingAttachments={clearPendingAttachments}
              />
            </div>
            {activeTaskApproval && (
              <div className="absolute inset-x-0 bottom-0 z-30">
                <PlanApprovalOverlay
                  threadId={threadId}
                  request={activeTaskApproval}
                  onVisibilityChange={setApprovalOverlayVisible}
                />
              </div>
            )}
            {activeToolPermission && (
              <div className="absolute inset-x-0 bottom-0 z-30">
                <PermissionBanner threadId={threadId} request={activeToolPermission} />
              </div>
            )}
            {activeAskUserQuestion && (
              <div className="absolute inset-x-0 bottom-0 z-30">
                <AskUserBanner threadId={threadId} request={activeAskUserQuestion} />
              </div>
            )}
          </div>
```

替换为：

```tsx
          {!readOnly && (
            <div className="relative">
              <div
                aria-hidden={hasComposerOverlay && (!activeTaskApproval || approvalOverlayVisible)}
                className={cn(
                  hasComposerOverlay && (!activeTaskApproval || approvalOverlayVisible) && 'pointer-events-none select-none opacity-0',
                )}
              >
                <AgentInput
                  threadId={threadId}
                  streaming={streamingState === 'streaming'}
                  pendingAttachments={pendingAttachments}
                  onAddPendingAttachments={addPendingAttachments}
                  onRemovePendingAttachment={removePendingAttachment}
                  onClearPendingAttachments={clearPendingAttachments}
                />
              </div>
              {activeTaskApproval && (
                <div className="absolute inset-x-0 bottom-0 z-30">
                  <PlanApprovalOverlay
                    threadId={threadId}
                    request={activeTaskApproval}
                    onVisibilityChange={setApprovalOverlayVisible}
                  />
                </div>
              )}
              {activeToolPermission && (
                <div className="absolute inset-x-0 bottom-0 z-30">
                  <PermissionBanner threadId={threadId} request={activeToolPermission} />
                </div>
              )}
              {activeAskUserQuestion && (
                <div className="absolute inset-x-0 bottom-0 z-30">
                  <AskUserBanner threadId={threadId} request={activeAskUserQuestion} />
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 4: 运行 AgentView 测试，确认通过**

Run: `cd apps/web && bun test src/components/agent/AgentView.test.tsx`
Expected: 全部 PASS（含原有 2 个 + 新增 2 个只读用例）。

- [ ] **Step 5: 写 AgentHeader 只读失败测试**

创建 `apps/web/src/components/agent/AgentHeader.test.tsx`：

```tsx
import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'

mock.module('./WorkspacePicker', () => ({
  WorkspacePicker: () => <div>workspace-picker</div>,
}))

const { AgentHeader } = await import('./AgentHeader')

describe('AgentHeader readOnly', () => {
  test('hides the workspace picker when readOnly', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentHeader threadId="thread-1" readOnly />
      </Provider>,
    )
    expect(html).not.toContain('workspace-picker')
  })

  test('shows the workspace picker by default', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentHeader threadId="thread-1" />
      </Provider>,
    )
    expect(html).toContain('workspace-picker')
  })
})
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `cd apps/web && bun test src/components/agent/AgentHeader.test.tsx`
Expected: `hides the workspace picker when readOnly` **FAIL**（当前 `readOnly` 不生效，picker 仍渲染）。

- [ ] **Step 7: 实现 AgentHeader 只读模式**

修改 `apps/web/src/components/agent/AgentHeader.tsx`：

7a. props 接口与签名（`:7-9`、`:21`）：

```tsx
interface AgentHeaderProps {
  threadId: string
  readOnly?: boolean
}

export function AgentHeader({ threadId, readOnly }: AgentHeaderProps) {
```

7b. 隐藏工作区选择器（`:41`），把：

```tsx
        <WorkspacePicker />
```

替换为：

```tsx
        {!readOnly && <WorkspacePicker />}
```

- [ ] **Step 8: 运行 AgentHeader 测试，确认通过**

Run: `cd apps/web && bun test src/components/agent/AgentHeader.test.tsx`
Expected: PASS（2 个用例）。

- [ ] **Step 9: 全量类型检查 + 相关测试回归**

Run: `cd apps/web && bun run typecheck && bun test src/components/agent/AgentView.test.tsx src/components/agent/AgentHeader.test.tsx`
Expected: 类型检查无新增错误；4 个用例全过。

- [ ] **Step 10: 提交**

```bash
git add apps/web/src/components/agent/AgentView.tsx \
        apps/web/src/components/agent/AgentHeader.tsx \
        apps/web/src/components/agent/AgentView.test.tsx \
        apps/web/src/components/agent/AgentHeader.test.tsx
git commit -m "✨ feat(web): AgentView/AgentHeader 新增只读回放模式"
```

---

## Task 3: 端到端接线（TabContent 透传 + 运行历史项可点击）

**Files:**
- Modify: `apps/web/src/components/tabs/TabContent.tsx:28-30`
- Modify: `apps/web/src/components/automation/AutomationManagementView.tsx`（imports + `AutomationJobDetail` 内新增 atom 接线 + 运行历史块 `:1019-1031`）

**Interfaces:**
- Consumes: `openAutomationRunReplay`（Task 1 产出）、`AgentView` 的 `readOnly` prop（Task 2 产出）

**说明**：本任务的逻辑核心（构造并应用只读 tab）已在 Task 1 以纯函数测试覆盖；`TabContent` 的透传是一行 prop；运行历史项的点击只是调用已测函数 + 两个 atom setter。因此本任务以**类型检查 + 手动验收**为验证手段，不做重型组件渲染测试（与仓库测试范式一致）。

- [ ] **Step 1: TabContent 透传 readOnly**

修改 `apps/web/src/components/tabs/TabContent.tsx:28-30`：

```tsx
  if (activeTab.type === 'agent' && activeTab.threadId) {
    return <AgentView threadId={activeTab.threadId} readOnly={activeTab.readOnly} />
  }
```

- [ ] **Step 2: AutomationManagementView 增加 import**

在 `apps/web/src/components/automation/AutomationManagementView.tsx` 现有 automation 相关 import 之后（`import type { AutomationJob, AutomationRun, ... } from '@lume/shared'` 附近）加入：

```tsx
import { openAutomationRunReplay } from './automation-run-replay'
```

（`tabsAtom`、`activeTabIdAtom` 已在 `:39` 从 `@/atoms` 导入；`useAtomValue`/`useSetAtom` 已在 `:2` 导入；`useCallback` 已在 `:1` 导入；`AutomationRun` 类型已在 `:53` 导入。）

- [ ] **Step 3: AutomationJobDetail 内增加 atom 接线与点击处理**

在 `AutomationJobDetail` 组件内（`apps/web/src/components/automation/AutomationManagementView.tsx`，紧接 `:761-771` 的 `const [draft, setDraft] = useState(...)` 之前或之后均可），加入：

```tsx
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const handleOpenRunReplay = useCallback((run: AutomationRun) => {
    const result = openAutomationRunReplay(run, tabs)
    if (!result) return
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
  }, [tabs, setTabs, setActiveTabId])
```

- [ ] **Step 4: 运行历史项可点击化**

修改 `apps/web/src/components/automation/AutomationManagementView.tsx:1019-1032`，把原：

```tsx
              <div className="flex flex-col gap-3">
                {runs.slice(0, 10).map((run) => (
                  <div key={run.id} className="flex items-center gap-2.5">
                    <span className={`size-2 shrink-0 rounded-full ${
                      run.status === 'success' ? 'bg-emerald-500'
                        : run.status === 'failed' ? 'bg-red-500'
                          : 'bg-amber-500'
                    }`} />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-1)]">{run.jobName}</span>
                    <span className="shrink-0 text-[14px] text-[var(--text-3)]">{formatDuration(run.startedAt, run.finishedAt)}</span>
                  </div>
                ))}
              </div>
```

替换为：

```tsx
              <div className="flex flex-col gap-1">
                {runs.slice(0, 10).map((run) => {
                  const clickable = Boolean(run.threadId)
                  return (
                    <div
                      key={run.id}
                      onClick={clickable ? () => handleOpenRunReplay(run) : undefined}
                      title={clickable ? '查看会话回放' : '无可查看的会话'}
                      className={`flex items-center gap-2.5 rounded-[6px] px-1.5 py-1 ${
                        clickable ? 'cursor-pointer transition-colors hover:bg-[var(--surface-2)]' : ''
                      }`}
                    >
                      <span className={`size-2 shrink-0 rounded-full ${
                        run.status === 'success' ? 'bg-emerald-500'
                          : run.status === 'failed' ? 'bg-red-500'
                            : 'bg-amber-500'
                      }`} />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-1)]">{run.jobName}</span>
                      <span className="shrink-0 text-[14px] text-[var(--text-3)]">{formatDuration(run.startedAt, run.finishedAt)}</span>
                    </div>
                  )
                })}
              </div>
```

（注意：外层 gap 由 `gap-3` 改为 `gap-1`，因为每行现在带 `py-1` 内边距；如视觉上偏挤可调回 `gap-2`，属微调。）

- [ ] **Step 5: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 无新增错误。

- [ ] **Step 6: 全量测试回归**

Run: `cd apps/web && bun test`
Expected: 全部既有测试 + Task 1/2 新增测试通过，无回归。

- [ ] **Step 7: 手动验收（对应规格验收标准 1/3/4/5）**

运行应用（可用项目的 `run` 技能或 `cd apps/web && bun run dev` + Tauri 壳），逐一核对：

1. 进入「自动化」→ 点开一个有运行记录的任务详情 → 右侧"运行历史记录"中**带 threadId**（即真实执行过）的记录整行可点击（hover 有底色、指针手型）。
2. 点击后**新开一个 tab**，标题为 `自动化·{任务名} · {MM-DD HH:mm}`，内容为该次运行的完整对话与工具调用流；**无输入框、无工作区选择器**；消息/工具调用/文件与图片预览可正常查看。
3. 重复点击**同一条**记录 → 复用已开 tab（聚焦而非新开）。
4. 若存在**无 threadId** 的记录（线程创建前即失败的运行）→ 该行不可点击，hover 显示"无可查看的会话"。
5. 从侧栏正常打开一个普通会话 → 仍可输入、交互完全正常（只读改动无回归）。

如某条无法在当前环境手动验证（例如无真实自动化运行数据），明确记录"未验证项"并说明原因，**不要**谎报通过。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/tabs/TabContent.tsx \
        apps/web/src/components/automation/AutomationManagementView.tsx
git commit -m "✨ feat(web): 自动化运行记录点击新开只读会话回放 tab"
```

---

## Self-Review（计划自检）

**1. 规格覆盖**：逐条对照 `docs/superpowers/specs/2026-06-23-automation-run-replay-tab-design.md`：
- 改动点 1（Tab.readOnly）→ Task 1 Step 3 ✓
- 改动点 2（TabContent 透传）→ Task 3 Step 1 ✓
- 改动点 3（AgentView readOnly：屏蔽输入块、跳过拖拽、透传 header）→ Task 2 Step 3 ✓
- 改动点 4（AgentHeader 隐藏 WorkspacePicker）→ Task 2 Step 7 ✓
- 改动点 5（运行历史可点击）→ Task 3 Step 4 ✓
- 验收标准 1/2/3/4/5/6 → Task 1 测试（6）+ Task 2 测试 + Task 3 手动（1/3/4/5）全覆盖 ✓
- 后端零改动 ✓（计划无 sidecar/sdk 改动）

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤都给出完整代码；测试代码可直接运行。

**3. 类型一致性**：
- `buildAutomationRunReplayTab` / `openAutomationRunReplay`（Task 1 定义）↔ Task 3 调用 `openAutomationRunReplay(run, tabs)` 签名一致 ✓
- `AgentView`/`AgentHeader` 的 `readOnly?: boolean`（Task 2 定义）↔ Task 3 `TabContent` 透传 `readOnly={activeTab.readOnly}`、`Tab.readOnly?: boolean`（Task 1）类型一致 ✓
- `formatRunTime(timestamp: number)` 与 `AutomationRun.startedAt: number` 一致 ✓
- `upsertTab(tabs, tab)` 签名与 `file-tabs.ts:44` 既有定义一致 ✓

无遗留问题。
