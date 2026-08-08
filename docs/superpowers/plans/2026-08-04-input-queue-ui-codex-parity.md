# 输入队列 UI/交互对齐 Codex 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 composer 上方的消息队列从「折叠面板 + 原生 HTML5 拖拽」升级为 Codex 式「平铺浮层 + @dnd-kit + framer-motion」，顺带修「关闭排队」菜单 bug。

**Architecture:** 在 PR #7 分支（`origin/worktree-input-queue-codex-parity`，语义层已齐）基础上做纯 UI 层改造。重写 `AgentMessageQueueList`：折叠→平铺浮层（`max-h-[30dvh]` 滚动）、原生拖拽→@dnd-kit（PointerSensor distance:6 + KeyboardSensor + restrictToVertical）、无动画→framer-motion（height+opacity）。`onReorder` 签名从 `(draggedId,targetId,placement)` 改为 `(orderedIds)`，配套新增 `applyOrderByIds` 纯函数；sidecar reorder IPC 早已是 `orderedMessageIds`，零改动。

**Tech Stack:** React 18.3.1、@dnd-kit/core+sortable+modifiers+utilities、framer-motion、Tailwind、bun:test、bun@1.3.13

## Global Constraints

- **起点分支**：`origin/worktree-input-queue-codex-parity`（PR #7，含三态/Resume/Retry/`summarizeQueuedMessage`/富 steer）。**不要在 main 上做**（main 是旧版 + 有浏览器注释 WIP）。
- **隔离**：用独立 git worktree（`superpowers:using-git-worktrees`）。
- **包管理器**：仓库用 **bun@1.3.13**（非 pnpm）。装依赖 `bun install`/`bun add`。
- **React 版本**：**18.3.1**。@dnd-kit 与 framer-motion 均兼容 18。
- **测试**：**bun:test**（非 vitest）。组件契约测试用 `renderToStaticMarkup`（react-dom/server，SSR，不依赖 DOM）。
- **不主动 git 提交/推送**：提交粒度按主题合并（~5-7 commit），由用户在主题边界决定时机。本计划 task **不含 commit step**。
- **文案**：中文硬编码（不引 i18n）。
- **不动语义层**：三态路由/kernel/interrupted 暂停语义本期不改（属 PR #7 follow-up）。

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `apps/web/src/components/agent/agent-message-queue-state.ts` | 队列纯函数 | 新增 `applyOrderByIds`（保留旧 `reorderQueuedMessages`，不删） |
| `apps/web/src/components/agent/agent-message-queue-state.test.ts` | 纯函数测试 | 新增 `applyOrderByIds` 测试 |
| `apps/web/src/components/agent/AgentMessageQueueList.tsx` | 队列 UI 组件 | **重写**：平铺浮层 + @dnd-kit + framer-motion + `onReorder(orderedIds)` + 移除 `defaultExpanded` + blocked 行首警告 tooltip + 修「关闭排队」bug |
| `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx` | 组件契约测试 | 更新：删 `defaultExpanded`、SSR 直渲染、`onReorder(orderedIds)` 断言 |
| `apps/web/src/components/agent/AgentInput.tsx` | 输入框（唯一调用方） | `handleQueueReorder` 改 `(orderedIds)` + 用 `applyOrderByIds`；import 调整 |
| `apps/web/package.json` | 依赖 | +`@dnd-kit/core` `@dnd-kit/sortable` `@dnd-kit/modifiers` `@dnd-kit/utilities` `framer-motion` |

---

### Task 1: 开 worktree + 装依赖

**Files:**
- Create: `.claude/worktrees/input-queue-ui-parity`（worktree 目录，由 worktree skill 管理）
- Modify: `apps/web/package.json`

- [ ] **Step 1: 基于 PR #7 分支开 worktree**

用 `superpowers:using-git-worktrees` skill，基于 `origin/worktree-input-queue-codex-parity` 创建 worktree（名称如 `input-queue-ui-parity`）。后续所有 task 在该 worktree 内执行。

- [ ] **Step 2: 确认起点正确**

Run: `git -C <worktree> log --oneline -1 && git -C <worktree> grep -l followUpQueueMode -- apps packages | head`
Expected: HEAD 在 `worktree-input-queue-codex-parity`；grep 命中 `apps/web/src/components/agent/AgentInput.tsx` 等（确认是 PR7 分支而非 main 旧版）。

- [ ] **Step 3: 装 5 个依赖**

Run（在 worktree 根）: `cd apps/web && bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/modifiers @dnd-kit/utilities framer-motion`
Expected: `apps/web/package.json` dependencies 出现这 5 个；`bun install` 成功无错。

- [ ] **Step 4: 冒烟验证依赖可 import**

Run: `cd apps/web && bun build ./src/main.tsx --external '*' --outdir /tmp/lume-smoke 2>&1 | tail -5`（或直接跑现有 build/测试，确认无 resolve 报错）
Expected: 无 `Could not resolve "@dnd-kit/..."` / `"framer-motion"` 错误。

---

### Task 2: `applyOrderByIds` 纯函数（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/agent-message-queue-state.ts`（新增导出）
- Test: `apps/web/src/components/agent/agent-message-queue-state.test.ts`

**Interfaces:**
- Consumes: `AgentMessageQueueSnapshot`（`@lume/shared`，已有）
- Produces: `applyOrderByIds(snapshot, orderedIds): AgentMessageQueueSnapshot` —— 按 `orderedIds`（仅 visible 项的新顺序）重排 `queuedMessages`，**保留 `internal` 项原相对位置**；`orderedIds` 不含的 id 忽略，长度不足/含未知 id 时安全降级。

- [ ] **Step 1: 写失败的测试**

在 `agent-message-queue-state.test.ts` 末尾追加：
```ts
describe('applyOrderByIds', () => {
  const snap = (items: Array<{ id: string; internal?: boolean }>): AgentMessageQueueSnapshot => ({
    threadId: 't1', revision: 1,
    queuedMessages: items.map((it) => ({ id: it.id, threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued', internal: it.internal } as never)),
    pendingGuidance: [],
  })

  test('按 orderedIds 重排 visible 项', () => {
    const out = applyOrderByIds(snap([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), ['c', 'a', 'b'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })

  test('保留 internal 项原相对位置', () => {
    const out = applyOrderByIds(snap([{ id: 'a' }, { id: 'i1', internal: true }, { id: 'b' }]), ['b', 'a'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['b', 'i1', 'a'])
  })

  test('orderedIds 不变时返回等价顺序', () => {
    const s = snap([{ id: 'a' }, { id: 'b' }])
    const out = applyOrderByIds(s, ['a', 'b'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['a', 'b'])
  })

  test('未知 id 安全忽略', () => {
    const out = applyOrderByIds(snap([{ id: 'a' }, { id: 'b' }]), ['a', 'x', 'b'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
```
（文件顶部若未 import `applyOrderByIds`，加上：`import { applyOrderByIds, ... } from './agent-message-queue-state'`，按现有 import 风格合并。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test src/components/agent/agent-message-queue-state.test.ts`
Expected: FAIL —— `applyOrderByIds is not defined`（或 import 报错）。

- [ ] **Step 3: 实现 `applyOrderByIds`**

在 `agent-message-queue-state.ts` 追加（`reorderQueuedMessages` 之后，**不删旧函数**）：
```ts
/**
 * 按 orderedIds 重排 queuedMessages 中的 visible(非 internal)项;
 * internal 项保留原相对位置。orderedIds 中不存在于快照的 id 被忽略。
 * 供 @dnd-kit onDragEnd 产出新顺序后做乐观更新。
 */
export function applyOrderByIds(
  snapshot: AgentMessageQueueSnapshot,
  orderedIds: string[],
): AgentMessageQueueSnapshot {
  const orderedSet = new Set(orderedIds)
  const byId = new Map(snapshot.queuedMessages.map((m) => [m.id, m]))
  let visIdx = 0
  const queuedMessages = snapshot.queuedMessages.map((m) => {
    if (!orderedSet.has(m.id)) return m // internal 或未参与拖拽：原位
    const next = byId.get(orderedIds[visIdx])
    visIdx += 1
    return next ?? m
  })
  if (queuedMessages.every((m, i) => m.id === snapshot.queuedMessages[i]?.id)) return snapshot
  return { ...snapshot, queuedMessages }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && bun test src/components/agent/agent-message-queue-state.test.ts`
Expected: PASS（全部 `applyOrderByIds` 用例 + 原有 `reorderQueuedMessages` 用例都过）。

---

### Task 3: 重写 `AgentMessageQueueList` + `AgentInput` 适配 + 契约测试

> 这是核心 task。组件重写与其唯一调用方 `AgentInput` 的 `onReorder` 签名适配必须同 task（否则中间状态类型断裂）。步骤按「先测试 → 重写组件 → 适配父级 → 跑测试」。

**Files:**
- Modify: `apps/web/src/components/agent/AgentMessageQueueList.tsx`（重写）
- Modify: `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`（更新）
- Modify: `apps/web/src/components/agent/AgentInput.tsx`（`handleQueueReorder` + import）

**Interfaces:**
- Consumes: `applyOrderByIds`（Task 2）、`summarizeQueuedMessage`（已有，`./agent-message-queue-summary`）、`AgentFollowUpMode`/`AgentQueuedMessage`/`AgentMessageQueueSnapshot`（`@lume/shared`）
- Produces: `AgentMessageQueueList` props 中 `onReorder: (orderedIds: string[]) => void`（破坏性变更，去掉 `defaultExpanded`）

- [ ] **Step 1: 重写契约测试（先写期望）**

整文件替换 `AgentMessageQueueList.contract.test.tsx`：
```tsx
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentMessageQueueSnapshot } from '@lume/shared'
import { AgentMessageQueueList } from './AgentMessageQueueList'

function snapshotWith(items: Array<Partial<AgentMessageQueueSnapshot['queuedMessages'][number]>>): AgentMessageQueueSnapshot {
  return {
    threadId: 't1', revision: 1,
    queuedMessages: items.map((item, i) => ({
      id: `q${i}`, threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued',
      ...item,
    })) as never,
    pendingGuidance: [],
  }
}

// onReorder 新签名:orderedIds。SSR 下无真实拖拽,断言渲染即可。
const noopReorder = () => undefined

describe('AgentMessageQueueList 契约(平铺浮层)', () => {
  test('平铺:无需展开直接渲染行文本', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q1', text: '排队中' }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toContain('排队中')
    expect(html).not.toContain('ChevronRight') // 无折叠头部
  })

  test('blocked 行渲染重试按钮 + 警告图标', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-b', text: '失败的消息', status: 'blocked', blockedReason: '校验失败' }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toContain('重试')
  })

  test('无文本的浏览器附件行显示附件摘要', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '', browserAttachments: [{ id: 'b1' } as never] }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toContain('浏览器注释')
  })

  test('interrupted 时渲染 Resume 横幅', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q1', text: '排队中' }])}
        interrupted onResume={() => undefined}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toContain('队列已暂停')
    expect(html).toContain('继续')
  })

  test('富 steer:带浏览器附件的行引导按钮可点(非 disabled)', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '改这里', browserAttachments: [{ id: 'b1' } as never] }])}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    const m = html.match(/<button[^>]*>[\s\S]*?引导<\/button>/)
    expect(m, '应渲染引导按钮').toBeTruthy()
    expect(m![0]).not.toMatch(/\sdisabled=/)
  })

  test('空队列(无 queued 无 guidance)不渲染', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={{ threadId: 't1', revision: 1, queuedMessages: [], pendingGuidance: [] }}
        onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
      />,
    )
    expect(html).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: FAIL（旧组件仍折叠，SSR 不含行文本；`onReorder` 仍要 3 参；平铺/空队列断言不过）。

- [ ] **Step 3: 重写 `AgentMessageQueueList.tsx`（平铺 + dnd-kit + framer-motion）**

整文件替换为：
```tsx
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, CornerDownRight, Edit3, GripVertical, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import type { AgentFollowUpMode, AgentMessageQueueSnapshot, AgentQueuedMessage } from '@lume/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { summarizeQueuedMessage } from './agent-message-queue-summary'

interface AgentMessageQueueListProps {
  snapshot: AgentMessageQueueSnapshot
  /** 拖拽结束产出新的 visible 项 id 顺序;父级做乐观更新 + IPC。 */
  onReorder: (orderedIds: string[]) => void
  onRemove: (queuedMessageId: string) => void
  onEdit: (queuedMessageId: string) => void
  onPromoteToGuidance: (queuedMessageId: string) => void
  onRetry?: (queuedMessageId: string) => void
  interrupted?: boolean
  onResume?: () => void
  followUpMode?: AgentFollowUpMode
  onFollowUpModeChange?: (mode: AgentFollowUpMode) => void
}

export function AgentMessageQueueList({
  snapshot,
  onReorder,
  onRemove,
  onEdit,
  onPromoteToGuidance,
  onRetry,
  interrupted = false,
  onResume,
  followUpMode,
  onFollowUpModeChange,
}: AgentMessageQueueListProps) {
  const visibleQueuedMessages = snapshot.queuedMessages.filter((item) => !item.internal)
  const hasQueue = visibleQueuedMessages.length > 0
  const hasGuidance = snapshot.pendingGuidance.length > 0
  const itemIds = visibleQueuedMessages.map((m) => m.id)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  if (!hasQueue && !hasGuidance) return null

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = itemIds.indexOf(String(active.id))
    const newIndex = itemIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = [...itemIds]
    const [moved] = next.splice(oldIndex, 1)
    next.splice(newIndex, 0, moved!)
    onReorder(next)
  }

  return (
    <div className="-mx-4 -mt-3 mb-3 max-h-[30dvh] overflow-y-auto border-b border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {interrupted && hasQueue && (
        <div className="flex items-center justify-between gap-2 border-b border-[color:color-mix(in_oklab,var(--lume-warning)_30%,transparent)] px-4 py-2 text-[12px] text-[var(--lume-warning)]">
          <span>队列已暂停(你中断了当前输出)</span>
          <Button variant="ghost" type="button" onClick={onResume} className="h-7 px-2 text-[12px] text-[var(--lume-warning)]">
            继续
          </Button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {visibleQueuedMessages.map((item) => (
              <QueuedMessageRow
                key={item.id}
                item={item}
                onRemove={onRemove}
                onEdit={onEdit}
                onPromoteToGuidance={onPromoteToGuidance}
                onRetry={onRetry}
                followUpMode={followUpMode}
                onFollowUpModeChange={onFollowUpModeChange}
              />
            ))}
          </AnimatePresence>
        </SortableContext>
      </DndContext>
      {hasGuidance && snapshot.pendingGuidance.map((item) => (
        <div
          key={item.id}
          className="flex h-11 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_28%,transparent)] px-4 text-[13px] text-[var(--text-2)]"
        >
          <CornerDownRight size={15} strokeWidth={2} className="shrink-0 text-[var(--text-3)]" />
          <span className="shrink-0 font-medium text-[var(--text-2)]">引导</span>
          <span className="min-w-0 truncate">{item.text}</span>
        </div>
      ))}
    </div>
  )
}

function QueuedMessageRow({
  item,
  onRemove,
  onEdit,
  onPromoteToGuidance,
  onRetry,
  followUpMode,
  onFollowUpModeChange,
}: {
  item: AgentQueuedMessage
  onRemove: (id: string) => void
  onEdit: (id: string) => void
  onPromoteToGuidance: (id: string) => void
  onRetry?: (id: string) => void
  followUpMode?: AgentFollowUpMode
  onFollowUpModeChange?: (mode: AgentFollowUpMode) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const [menuOpen, setMenuOpen] = useState(false)
  const canPromote = item.status === 'queued' && item.text.trim().length > 0
  const blocked = item.status === 'blocked'

  return (
    <motion.div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'group relative flex h-11 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_28%,transparent)] px-4 text-[14px] text-[var(--text-2)] transition-colors last:border-b-0 hover:bg-[color:color-mix(in_oklab,var(--surface-2)_62%,transparent)]',
        isDragging && 'z-10 opacity-60',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab text-[var(--text-3)] active:cursor-grabbing"
      >
        <GripVertical size={15} strokeWidth={2} />
      </button>
      {blocked && (
        <span
          className="shrink-0 text-[var(--lume-warning)]"
          title={item.blockedReason ? `发送失败:${item.blockedReason}。重试、编辑或删除以继续队列。` : '重试、编辑或删除以继续队列'}
        >
          <AlertTriangle size={14} strokeWidth={2} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-2)]">{summarizeQueuedMessage(item)}</span>
      {blocked && (
        <Button
          variant="ghost"
          type="button"
          onClick={() => onRetry?.(item.id)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)] px-3 text-[12px] font-medium text-[var(--lume-warning)] transition-colors hover:text-[var(--lume-warning)]"
          title={item.blockedReason ? `发送失败:${item.blockedReason}` : '重试发送'}
        >
          <RotateCcw size={13} strokeWidth={2} />
          重试
        </Button>
      )}
      <Button
        variant="ghost"
        type="button"
        onClick={() => onPromoteToGuidance(item.id)}
        disabled={!canPromote}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_76%,transparent)] px-3 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:text-[var(--text-1)]"
        title={canPromote ? '在下次工具调用前发送(引导)' : '请先输入消息文本'}
      >
        <CornerDownRight size={14} strokeWidth={2} />
        引导
      </Button>
      <Button
        variant="ghost"
        type="button"
        onClick={() => onRemove(item.id)}
        disabled={item.status === 'validating'}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_70%,transparent)] hover:text-[var(--text-1)]"
        title="删除排队消息"
      >
        <Trash2 size={14} strokeWidth={2} />
      </Button>
      <Button
        variant="ghost"
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        disabled={item.status === 'validating'}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
        title="更多"
      >
        <MoreHorizontal size={15} strokeWidth={2.1} />
      </Button>
      {menuOpen && (
        <>
          <Button
            variant="ghost"
            type="button"
            aria-label="关闭菜单"
            className="fixed inset-0 z-10 h-auto w-auto cursor-default bg-transparent p-0 hover:bg-transparent"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute right-4 top-9 z-20 min-w-[132px] overflow-hidden rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] py-1 shadow-[0_14px_42px_rgba(28,32,58,0.16)]">
            <Button
              variant="ghost"
              type="button"
              onClick={() => { setMenuOpen(false); onEdit(item.id) }}
              className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
            >
              <Edit3 size={14} strokeWidth={2} className="text-[var(--text-3)]" />
              编辑消息
            </Button>
            {onFollowUpModeChange && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => { setMenuOpen(false); onFollowUpModeChange('steer') }}
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
              >
                <CornerDownRight size={14} strokeWidth={2} className="text-[var(--text-3)]" />
                关闭排队
              </Button>
            )}
            {onFollowUpModeChange && (
              <>
                <div className="my-1 border-t border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)]" />
                {(['queue', 'steer', 'interrupt'] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant="ghost"
                    type="button"
                    onClick={() => { setMenuOpen(false); onFollowUpModeChange(mode) }}
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
                  >
                    {followUpMode === mode ? '●' : '○'} {mode === 'queue' ? '排队模式' : mode === 'steer' ? '引导模式' : '中断模式'}
                  </Button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </motion.div>
  )
}
```

关键变更点（对照旧版）：
- 移除 `expanded`/`defaultExpanded`/折叠头部 `Button`
- `onReorder: (orderedIds) => void`（去掉 `draggedId/targetId/placement`）
- 容器 `max-h-[30dvh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`
- `DndContext` + `SortableContext`（`restrictToVerticalAxis` + `restrictToParentElement`）+ `useSortable`（手柄作 activator）
- `AnimatePresence` + `motion.div`（height+opacity, 0.18s）
- blocked：行首 `AlertTriangle` + tooltip（替代行尾红色徽章），重试按钮图标改 `RotateCcw`
- **bug 修复**：「关闭排队」`onClick` 从 `onRemove()` → `onFollowUpModeChange('steer')`

- [ ] **Step 4: 适配 `AgentInput.tsx` 的 `handleQueueReorder`**

定位 `AgentInput.tsx` 中 `handleQueueReorder`（分支版约 line 1510），整段替换：
```ts
const handleQueueReorder = useCallback((orderedIds: string[]) => {
  const previousSnapshot = messageQueueSnapshot
  const optimisticSnapshot = applyOrderByIds(previousSnapshot, orderedIds)
  if (optimisticSnapshot === previousSnapshot) return
  setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, optimisticSnapshot))
  reorderAgentMessageQueue({
    threadId,
    orderedMessageIds: orderedIds,
    expectedRevision: previousSnapshot.revision,
    queueOperationId: crypto.randomUUID(),
  })
    .then((result) => {
      setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
      if (!result.ok) toast.error('队列已发生变化，已刷新最新顺序')
    })
    .catch((error) => {
      console.error('[AgentInput] 消息队列排序失败:', error)
      setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, previousSnapshot))
      toast.error('队列排序失败')
    })
}, [messageQueueSnapshot, setMessageQueues, threadId])
```
变更：参数 `(draggedId, targetId, placement)` → `(orderedIds)`；`reorderQueuedMessages(...)` → `applyOrderByIds(...)`；IPC `orderedMessageIds` 直接用 `orderedIds`（不再 `.map(i=>i.id)`）。

- [ ] **Step 5: 调整 `AgentInput.tsx` import**

把 `import { ... reorderQueuedMessages ... } from './agent-message-queue-state'`（约 line 84-88 一带的具名 import）中的 `reorderQueuedMessages` 替换为 `applyOrderByIds`。若 `reorderQueuedMessages` 在 `AgentInput` 他处仍被引用则保留；否则只换成 `applyOrderByIds`。

- [ ] **Step 6: 跑契约测试确认通过**

Run: `cd apps/web && bun test src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: PASS（全部 6 个用例）。

- [ ] **Step 7: 跑 web 全量测试确认无回归**

Run: `cd apps/web && bun test`
Expected: 全绿（含 `agent-message-queue-state.test.ts`、`agent-input-state.test.ts`、`agent-message-queue-summary.test.ts` 等）。若有 React 18 + framer-motion/dnd-kit 的 SSR 相关报错，见 Task 4 排查。

- [ ] **Step 8: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`（或仓库既有 typecheck 脚本）
Expected: 无 `onReorder` 签名 / `defaultExpanded` / `applyOrderByIds` 相关报错。

---

### Task 4: 视觉与交互走查 + 边界处理

**Files:** 无新文件；验证性 task。

- [ ] **Step 1: 手动走查清单（在 desktop/web dev 跑起来）**

启动 dev，构造队列场景，逐项验证：
- [ ] 多条排队消息以**平铺**显示在 composer 上方，`max-h-[30dvh]` 超出滚动，滚动条隐藏
- [ ] **拖拽手柄**重排：6px 激活、transform 平移动画、锁垂直、键盘可达（Tab 聚焦手柄 + 空格/方向键）
- [ ] 入队/删除有 **height+opacity 动画**（0.18s）
- [ ] 中断（STOP）后顶部 **Resume 横幅** + 继续按钮（注：继续当前为 dismiss 语义，见 follow-up）
- [ ] blocked 行：行首⚠图标 + tooltip「发送失败:...。重试、编辑或删除以继续队列」+ 重试按钮
- [ ] 正常行引导按钮（=Steer 语义）
- [ ] 更多菜单：「编辑消息」/「关闭排队」(切 steer)/三态切换；**「关闭排队」不再删消息**
- [ ] 空队列不占位（无 queued 无 guidance 时列表消失）
- [ ] guidance 行在列表底部正常显示

- [ ] **Step 2: 边界验证**

- [ ] 拖拽到自身（不变序）：无 IPC、无乐观更新
- [ ] 队列含 `internal` 项：拖拽 visible 不影响 internal 位置
- [ ] 并发：拖拽中收到队列推送（revision 不符）→ toast「队列已发生变化，已刷新最新顺序」

- [ ] **Step 3: SSR/构建冒烟**

Run: `cd apps/web && bun run build`（或仓库 web build 脚本）
Expected: 构建成功，无 `framer-motion`/`@dnd-kit` resolve 或 SSR 报错。若 framer-motion 在 SSR 报 `window is not defined`，确认 `AnimatePresence`/`motion` 用法为纯声明式（本组件未直接访问 window）。

---

## Self-Review

**1. Spec coverage**（对照 design doc）：
- 平铺浮层 `max-h-[30dvh]` + hide-scrollbar → Task 3 Step 3 容器类名 ✅
- interrupted 横幅（列表顶部一等）→ Task 3 Step 3 ✅
- @dnd-kit（PointerSensor distance:6 + KeyboardSensor + closestCenter + restrictToVertical + 手柄 activator）→ Task 3 Step 3 ✅
- framer-motion（AnimatePresence + motion.div height+opacity 0.18s）→ Task 3 Step 3 ✅
- onReorder(orderedIds) + applyOrderByIds → Task 2 + Task 3 Step 4 ✅
- 移除 defaultExpanded → Task 3 Step 3（props 删除）✅
- blocked 行首警告 tooltip（替代徽章）→ Task 3 Step 3 ✅
- 修「关闭排队」bug → Task 3 Step 3 ✅
- 契约测试更新 → Task 3 Step 1 ✅
- 依赖 → Task 1 ✅
- guidance 置列表底部 → Task 3 Step 3 ✅
- 图片预览/i18n = follow-up（不在本期）✅

**2. Placeholder scan**：所有代码 step 含实际代码；无 TBD/TODO/"适当处理"。✅

**3. Type consistency**：
- `onReorder: (orderedIds: string[]) => void` —— 组件 props（Task 3 Step 3）、契约测试 `noopReorder`（Step 1）、`AgentInput.handleQueueReorder`（Step 4）三处签名一致 ✅
- `applyOrderByIds(snapshot, orderedIds): AgentMessageQueueSnapshot` —— Task 2 定义与 Task 3 Step 4 调用一致 ✅
- `useSortable({ id })` 返回的 `transform` → `CSS.Transform.toString` ✅
- `DragEndEvent` 的 `active.id`/`over.id` 用 `String()` 转 id（dnd-kit UniqueIdentifier 是 string|number）✅

## 风险与备注

- **framer-motion 与 React 18.3.1**：framer-motion v11 支持 React 18。`bun add framer-motion` 会装最新 v11/12；若装到 v12 需确认 18 兼容（v12 仍支持 18）。若 build 期报 peer 警告但能跑，可忽略。
- **@dnd-kit SSR**：`renderToStaticMarkup` 下 `useSortable` 会渲染但无交互；契约测试不断言拖拽行为，只断言静态 HTML。若 SSR 报错，可在测试用 `DndContext` 的 props 无副作用特性排查。
- **不删 `reorderQueuedMessages`**：保留旧纯函数（surgical，可能有其他引用/测试）。仅 `AgentInput` 改用 `applyOrderByIds`。
- **`handleResumeFromInterrupt` 不改**：Resume 横幅仍是 dismiss 语义（kernel 无暂停队列语义，属 follow-up）。UI 对齐不涉及。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-input-queue-ui-codex-parity.md`.（**注：当前在 main 工作区，实施前需按 Task 1 切到 PR #7 分支 worktree**）
