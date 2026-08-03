# 浏览器注释 Overlay EditorCard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 Codex 实现 EditorCard——网页内 React overlay 评论编辑器卡片（与 marker/preview 同层），由 overlayReducer 的 target.mode 状态机驱动（create/edit），复刻现有 BrowserAnnotationPopup 的交互（单输入 + Enter=添加 / Ctrl+Enter=发送 / Esc=取消 / 删除），提交经现有 `lume:browser-annotation-guest` channel 走 manager 的 saveAttachment/clearDraft/delete，emit `browser:annotation-direct-submit`/`browser:annotation-added` 喂 agent。

**Architecture:** EditorCard 是 overlay 内纯展示组件（Shadow DOM 内原生 HTML + overlay.css.ts 样式，不用 apps/web 的 UI 库）。AnnotationOverlay 接 overlayReducer（Plan 1 已实例化但未接线）：检测 GuestState.activeDraft → dispatch restore-editor（target 从 activeDraft.id 推导 edit/create）→ 渲染 EditorCard；提交/取消/删除通过 bridge.send 发 editor-* 消息；manager onGuestMessage 新增 editor-submit/cancel/delete 分支（复用既有 saveAttachment/clearDraft/delete），反馈经 syncGuest 推送的 activeDraft 变化回流（清空 → overlay close-editor）。**延续 Plan 1-3 并行重写：不切 preload、不动 popup 链路、overlay 休眠**。

**Tech Stack:** React 18.3.1、TypeScript、bun:test + happy-dom、Vite lib mode CJS preload。

## Global Constraints

> 每个任务的实现都隐含遵守本节。偏离任一条需在 task 内显式说明理由。

1. **按 Codex 实现 EditorCard**：网页内 overlay 卡片（非 BrowserWindow）；target.mode 状态机（create/edit，design 留 Plan 5）；handleOverlaySubmit 语义（submit → 喂 agent）。
2. **延续并行重写（零倒退）**：**不切生产 preload**（`main.ts:1119` 仍 `browser-guest-preload.cjs`）；**不动 popup 链路**（openPopup/positionPopup/closePopup/handlePopupCommand/popups Map/BrowserAnnotationPopup.tsx/browser-annotation-preload.ts/main.ts:2653 IPC handler/annotationPopupPreloadPath 全部保留）；overlay preload 仍休眠。preload 合并 + 切 preload + 退役 popup 留 Plan 8（spec §10 未决项）。
3. **editor 提交用现有 channel**：`bridge.send({ type: 'editor-submit'|'editor-cancel'|'editor-delete', ... })` 走 `lume:browser-annotation-guest`（fire-and-forget）。**不新增 IPC channel、不新增 invoke、不改 main.ts/browser-runtime.ts**。反馈经 syncGuest 的 activeDraft 变化回流。
4. **仓库用 bun**（非 pnpm）；测试 **bun:test + happy-dom**（非 vitest）；**React 18.3.1**。
5. **无 commit 工作流**：subagent 只改工作区，不 git add/commit。task 末尾用 verify（typecheck + test + build）替代。
6. **代码注释中文**（对齐 `browser-overlay/` 现有）；**LF 行尾**。
7. **测试基建**（Plan 3 验证）：test 文件 `.tsx`（JSX）；`bun-test.d.ts` mock() 已可用；happy-dom globals 由 `scripts/test-dom-preload.ts` 注入；`renderHook` 已 unmount 旧 root（无 listener 泄漏）；验证 document capture listener 的测试 dispatch 目标必须连入 document。React 组件测试参照 `apps/web/src/components/agent/AgentView.test.tsx`（act + createRoot）。
8. **定位模型**（延续 Plan 3）：EditorCard 是偏移跟随定位（`left/top` = anchorRect 下方，无 transform）。
9. **body 截断 20_000 + trim**（对齐 BrowserAnnotationPopup L83/L63 + manager saveAttachment L411）。
10. **Plan 3 follow-up 顺手补**：在 Task 42（reducer 接线的 useEffect 区）补 preview 定时器卸载 cleanup（Plan 3 final review #3，1 行）。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `apps/desktop/src/browser-overlay/EditorCard.tsx` | 纯展示：输入 + 键盘（Esc/Ctrl+Enter/Enter）+ add/send/delete 按钮；偏移跟随定位 | **新建** |
| `apps/desktop/src/browser-overlay/EditorCard.test.tsx` | 渲染 + 键盘 + 提交回调 TDD | **新建** |
| `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx` | reducer 接线：activeDraft → restore-editor；editor.editing 渲染 EditorCard；preview 定时器 cleanup | **改** |
| `apps/desktop/src/browser-overlay/overlay.css.ts` | 加 `.editor-card`/`.editor-input`/`.editor-actions`/`.editor-btn` 样式 | **改** |
| `apps/desktop/src/browser-overlay/overlayReducer.ts` | （已就绪）OverlayTarget/OverlayEditorState/overlayAction 复用，本 plan 不改 | 不变 |
| `apps/desktop/src/browser-annotation-manager.ts` | onGuestMessage 加 editor-submit/cancel/delete 分支（复用 saveAttachment/clearDraft/delete） | **改** |
| `apps/desktop/src/browser-annotation-manager.test.ts`（若不存在则新建） | manager editor 命令 TDD（mock store/options） | **新建/改** |

---

## Task 41: EditorCard 组件 + 样式

**目标**：纯展示 EditorCard（Shadow DOM 内原生 HTML），复刻 BrowserAnnotationPopup 交互：单输入、Enter=添加、Ctrl+Enter=发送、Esc=取消、删除按钮；偏移跟随定位（anchorRect 下方）；body 20K 截断 + trim。

**Files:**
- Create: `apps/desktop/src/browser-overlay/EditorCard.tsx`
- Create: `apps/desktop/src/browser-overlay/EditorCard.test.tsx`
- Modify: `apps/desktop/src/browser-overlay/overlay.css.ts`

**Interfaces:**
- Consumes: `OverlayTarget`（`./overlayReducer`，已有 `{mode:'create'}|{mode:'edit';commentId}|{mode:'design'}`）、`Rect`（`./useAnnotationInteraction`，已有）
- Produces: `EditorCard({ target, initialBody, anchorRect, canDelete, onSubmit, onCancel, onDelete }: EditorCardProps): ReactNode`，其中 `onSubmit: (action: 'add'|'send', body: string) => void`

- [ ] **Step 1: 写失败测试**

创建 `EditorCard.test.tsx`：

```tsx
import { describe, test, expect, mock } from 'bun:test'
await mock.module('electron', () => ({ ipcRenderer: { on() {}, send() {}, off() {} } }))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { EditorCard } = await import('./EditorCard')
import type { OverlayTarget } from './overlayReducer'

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  act(() => { createRoot(container).render(node) })
  return container
}

const baseProps = {
  target: { mode: 'create' } as OverlayTarget,
  initialBody: '',
  anchorRect: { x: 100, y: 200, width: 40, height: 24 },
  canDelete: false,
}

describe('EditorCard', () => {
  test('渲染输入框，初始 body 来自 initialBody，自动聚焦', () => {
    const container = render(<EditorCard {...baseProps} initialBody="hello" onSubmit={() => {}} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('hello')
    expect(document.activeElement).toBe(input)
    document.body.innerHTML = ''
  })

  test('Enter（无修饰键）→ onSubmit add + trim body', () => {
    const onSubmit = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="  hi  " onSubmit={onSubmit} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]).toEqual(['add', 'hi'])
    document.body.innerHTML = ''
  })

  test('Ctrl+Enter → onSubmit send', () => {
    const onSubmit = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="x" onSubmit={onSubmit} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(onSubmit.mock.calls[0]?.[0]).toBe('send')
    document.body.innerHTML = ''
  })

  test('Esc → onCancel', () => {
    const onCancel = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="x" onSubmit={() => {}} onCancel={onCancel} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onCancel).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  test('空 body 时 Enter 不提交', () => {
    const onSubmit = mock(() => {})
    const container = render(<EditorCard {...baseProps} initialBody="   " onSubmit={onSubmit} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSubmit).toHaveBeenCalledTimes(0)
    document.body.innerHTML = ''
  })

  test('canDelete 时渲染删除按钮 → onDelete', () => {
    const onDelete = mock(() => {})
    const container = render(<EditorCard {...baseProps} canDelete initialBody="x" onSubmit={() => {}} onCancel={() => {}} onDelete={onDelete} />)
    const delBtn = container.querySelector('button.editor-delete') as HTMLButtonElement
    expect(delBtn).toBeTruthy()
    act(() => delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onDelete).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
  })

  test('body 截断 20_000', () => {
    const container = render(<EditorCard {...baseProps} initialBody={''} onSubmit={() => {}} onCancel={() => {}} onDelete={() => {}} />)
    const input = container.querySelector('input.editor-input') as HTMLInputElement
    act(() => { input.value = 'a'.repeat(21_000); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect((container.querySelector('input.editor-input') as HTMLInputElement).value.length).toBe(20_000)
    document.body.innerHTML = ''
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/EditorCard.test.tsx`
Expected: FAIL — `Cannot find module './EditorCard'`

- [ ] **Step 3: 实现 EditorCard**

创建 `EditorCard.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import type { OverlayTarget } from './overlayReducer'

export type EditorCardProps = {
  target: OverlayTarget
  initialBody: string
  anchorRect: { x: number; y: number; width: number; height: number }
  canDelete: boolean
  onSubmit: (action: 'add' | 'send', body: string) => void
  onCancel: () => void
  onDelete: () => void
}

// 网页内评论编辑器卡片（对齐 Codex comment 卡片 + 复刻 BrowserAnnotationPopup 交互）。
// 偏移跟随定位（anchorRect 下方），无 transform。Enter=添加，Ctrl/Cmd+Enter=发送，Esc=取消。
export function EditorCard({ target, initialBody, anchorRect, canDelete, onSubmit, onCancel, onDelete }: EditorCardProps) {
  const [body, setBody] = useState(initialBody)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  void target
  const hasBody = body.trim().length > 0
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (hasBody) onSubmit('send', body.trim()); return }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); if (hasBody) onSubmit('add', body.trim()) }
  }
  return (
    <div className="editor-card" style={{ left: anchorRect.x, top: anchorRect.y + anchorRect.height + 8 }}>
      <input
        ref={inputRef}
        className="editor-input"
        value={body}
        placeholder="添加评论…"
        onChange={(event) => setBody(event.target.value.slice(0, 20_000))}
        onKeyDown={onKeyDown}
      />
      <div className="editor-actions">
        <button type="button" className="editor-btn" disabled={!hasBody} onClick={() => onSubmit('add', body.trim())}>添加</button>
        <button type="button" className="editor-btn" disabled={!hasBody} onClick={() => onSubmit('send', body.trim())}>发送</button>
        {canDelete && <button type="button" className="editor-btn editor-delete" onClick={onDelete}>删除</button>}
      </div>
    </div>
  )
}
```

> 注：React 的 `onChange` 在受控 input 上对应 DOM `input` 事件（React 合成），测试用 `new Event('input')` 触发。`disabled` 按钮的 click 仍可在 happy-dom 触发——测试用 canDelete 删除按钮（无 disabled）验证 onDelete；add/send 按钮的 disabled 仅视觉，键盘路径是主交互。

- [ ] **Step 4: 加 overlay.css.ts 样式**

在 `overlayStyles` 字符串末尾（`.region-box{...}` 之后）追加：

```css
.editor-card{position:fixed;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #ffffff33;border-radius:10px;background:#17181c;color:#f5f5f5;box-shadow:0 12px 32px #0006;pointer-events:auto;min-width:240px;z-index:3}
.editor-input{background:transparent;border:0;color:#f5f5f5;font:13px system-ui,-apple-system,sans-serif;outline:none;padding:4px 2px;min-width:200px}
.editor-actions{display:flex;gap:6px;align-items:center}
.editor-btn{background:#ffffff1a;border:0;border-radius:6px;color:#f5f5f5;cursor:pointer;font:12px system-ui,sans-serif;padding:4px 10px}
.editor-btn:disabled{opacity:.4;cursor:default}
.editor-delete{color:#f87171}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/EditorCard.test.tsx`
Expected: PASS（7/7）

- [ ] **Step 6: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

---

## Task 42: reducer 接线 + activeDraft 恢复 + preview 定时器 cleanup

**目标**：AnnotationOverlay 接 overlayReducer——检测 GuestState.activeDraft → dispatch restore-editor（target 从 activeDraft.id 推导 edit/create）；editor.editing 时渲染 EditorCard；activeDraft 消失 → close-editor。顺手补 Plan 3 follow-up #3（preview 定时器卸载 cleanup）。

**Files:**
- Modify: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`
- Modify: `apps/desktop/src/browser-overlay/useAnnotationInteraction.ts`（暴露 preview 定时器 ref 供 cleanup，或在本组件 effect 清）
- Test: `apps/desktop/src/browser-overlay/AnnotationOverlay.test.tsx`（新建）或扩展 `useAnnotationInteraction.test.tsx`

**Interfaces:**
- Consumes: `overlayReducer`/`OverlayTarget`/`OverlayEditorState`（`./overlayReducer`）、`EditorCard`（Task 41）、`GuestState.activeDraft`（`./guest-state`，已有）、`Rect`（`./useAnnotationInteraction`）
- Produces: AnnotationOverlay 在 editor.editing + activeDraft 存在时渲染 `<EditorCard/>`，回调 `bridge.send({type:'editor-submit'|'editor-cancel'|'editor-delete'})`

- [ ] **Step 1: 写失败测试（activeDraft → EditorCard 渲染）**

创建 `AnnotationOverlay.test.tsx`：

```tsx
import { describe, test, expect, mock } from 'bun:test'
await mock.module('electron', () => ({ ipcRenderer: { on() {}, send() {}, off() {} } }))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { AnnotationOverlay } = await import('./AnnotationOverlay')
const { createGuestBridge } = await import('./guest-state')

// 模拟主进程 sync 推送 activeDraft
function pushSync(payload: Record<string, unknown>): void {
  const handler = (globalThis as unknown as { __lumeGuestHandler?: (e: unknown, raw: unknown) => void }).__lumeGuestHandler
  handler?.({}, payload)
}

function mount(host: HTMLElement): { unmount: () => void; send: ReturnType<typeof mock> } {
  const send = mock(() => {})
  const bridge = createGuestBridge()
  bridge.send = send
  act(() => { createRoot(host).render(<AnnotationOverlay bridge={bridge} host={host} /> as ReactNode) })
  return { unmount: () => {}, send }
}

describe('AnnotationOverlay EditorCard 接线', () => {
  test('activeDraft 到达 → 渲染 EditorCard；target=create（无 id）', () => {
    const host = document.createElement('div'); document.body.append(host)
    const { send } = mount(host)
    act(() => {
      // 捕获 ipcRenderer.on handler
      ;(globalThis as unknown as { __lumeGuestHandler?: unknown }).__lumeGuestHandler = undefined
    })
    // createGuestBridge 内部已注册 ipcRenderer.on；通过其 subscribe 机制推送
    // 简化：直接用 bridge.subscribe 已连接，dispatch 一个含 activeDraft 的 sync
    pushSync({ type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation', comments: [], activeDraft: { anchor: { rect: { x: 10, y: 20, width: 30, height: 40 } }, body: 'draft' } })
    const input = host.querySelector('input.editor-input') as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input?.value).toBe('draft')
    document.body.innerHTML = ''
  })

  test('activeDraft 消失 → EditorCard 卸载', () => {
    const host = document.createElement('div'); document.body.append(host)
    mount(host)
    pushSync({ type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation', comments: [], activeDraft: { anchor: { rect: { x: 10, y: 20, width: 30, height: 40 } }, body: 'd' } })
    expect(host.querySelector('input.editor-input')).toBeTruthy()
    pushSync({ type: 'sync', tabId: 't1', generation: 1, threadId: 'th1', mode: 'comment', purpose: 'annotation', comments: [] })
    expect(host.querySelector('input.editor-input')).toBeFalsy()
    document.body.innerHTML = ''
  })
})
```

> 注：测试通过 `createGuestBridge` 的 ipcRenderer.on handler 推送 sync。需在 test-dom-preload 或测试里桥接 ipcRenderer.on 到 `__lumeGuestHandler`。若 createGuestBridge 的 ipcRenderer.on 不易捕获，改为直接渲染一个传 `bridge` 的测试（bridge.getState 返预设 activeDraft）。**实施时按可测性调整测试 harness**，核心断言不变（activeDraft→EditorCard 渲染、消失→卸载）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/AnnotationOverlay.test.tsx`
Expected: FAIL — EditorCard 未渲染（reducer 未接线）

- [ ] **Step 3: 改 AnnotationOverlay.tsx —— reducer 接线 + EditorCard 渲染**

在 `AnnotationOverlay.tsx`：
(1) 顶部加 import：
```tsx
import { EditorCard } from './EditorCard'
import { overlayReducer, type OverlayTarget, type OverlayEditorState } from './overlayReducer'
```
（`overlayReducer`/`OverlayEditorState` 已 import；补 `OverlayTarget`、`EditorCard`）

(2) 把 `void editor; void dispatch` 替换为接线逻辑：
```tsx
  // activeDraft → restore-editor（target 从 activeDraft.id 推导 edit/create）；消失 → close-editor
  useEffect(() => {
    const draft = state?.activeDraft as { id?: string; anchor?: { rect?: { x: number; y: number; width: number; height: number } } } | undefined
    if (draft) {
      const target: OverlayTarget = draft.id ? { mode: 'edit', commentId: draft.id } : { mode: 'create' }
      dispatch({ type: 'restore-editor', target })
    } else {
      dispatch({ type: 'close-editor' })
    }
  }, [state?.activeDraft])
```

(3) 在 `interaction-layer` 内（或 markers-layer 后）渲染 EditorCard：
```tsx
      {editor.type === 'editing' && state?.activeDraft ? (
        <EditorCard
          target={editor.target}
          initialBody={String((state.activeDraft as { body?: unknown }).body ?? '')}
          anchorRect={editorRect(state.activeDraft)}
          canDelete={editor.target.mode === 'edit'}
          onSubmit={(action, body) => bridge.send({ type: 'editor-submit', action, body })}
          onCancel={() => bridge.send({ type: 'editor-cancel' })}
          onDelete={() => bridge.send({ type: 'editor-delete' })}
        />
      ) : null}
```

(4) 加 `editorRect` 辅助（从 activeDraft.anchor.rect 取，fallback 默认）：
```tsx
function editorRect(draft: unknown): { x: number; y: number; width: number; height: number } {
  const anchor = (draft as { anchor?: { rect?: { x?: number; y?: number; width?: number; height?: number }; markerPoint?: { x?: number; y?: number } } }).anchor
  const rect = anchor?.rect
  if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') return { x: rect.x, y: rect.y, width: rect.width ?? 1, height: rect.height ?? 1 }
  const point = anchor?.markerPoint
  return { x: point?.x ?? 8, y: point?.y ?? 8, width: 1, height: 1 }
}
```

- [ ] **Step 4: 补 preview 定时器卸载 cleanup（Plan 3 follow-up #3）**

在 `AnnotationOverlay.tsx` 加一个清 useAnnotationInteraction 内部 preview 定时器的 effect。由于定时器 ref 在 hook 内部，最简方案是在 `useAnnotationInteraction` 的 `useEffect` cleanup 里清两个 timer ref。

在 `useAnnotationInteraction.ts` 的主 effect（注册 document listener 的那个）的 cleanup return 里，追加清定时器（Task 37 引入的 `previewTimerRef`/`previewHideTimerRef`）：
```ts
    return () => {
      // ... 现有 removeEventListener ...
      if (previewTimerRef.current) win.clearTimeout(previewTimerRef.current)
      if (previewHideTimerRef.current) win.clearTimeout(previewHideTimerRef.current)
    }
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/AnnotationOverlay.test.tsx`
Expected: PASS（2/2）

Run: `cd apps/desktop && bun test src/browser-overlay/`
Expected: 全绿（Plan 3 的 68 + EditorCard 7 + 本 task 2 + 无回归）

- [ ] **Step 6: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

---

## Task 43: manager onGuestMessage 加 editor 命令

**目标**：manager `onGuestMessage` 新增 `editor-submit`/`editor-cancel`/`editor-delete` 分支，复用既有 `saveAttachment`/`store.clearDraft`/`delete`。anchor 从 store activeDraft 取（overlay 不传 anchor，来源单一）。submit 后 emit `browser:annotation-direct-submit`(send)/`browser:annotation-added`(add)，与现有 popup 提交链路一致（AgentInput 已监听 direct-submit）。

**Files:**
- Modify: `apps/desktop/src/browser-annotation-manager.ts`（onGuestMessage 加 3 分支）
- Create/Modify: `apps/desktop/src/browser-annotation-manager.test.ts`（editor 命令 TDD）

**Interfaces:**
- Consumes: `saveAttachment`（L419，同类 private 可调）、`store.clearDraft`、`delete`（L78）、`syncGuest`/`emitSnapshot`、`options.emit`
- Produces: onGuestMessage 处理 `{type:'editor-submit',action:'add'|'send',body}` / `{type:'editor-cancel'}` / `{type:'editor-delete'}`

- [ ] **Step 1: 写失败测试**

创建/扩展 `browser-annotation-manager.test.ts`（若不存在，参照现有 manager 测试模式；需 mock store/options/tab）：

```ts
import { describe, test, expect, mock } from 'bun:test'
// manager 依赖 electron（BrowserWindow/screen 等），需 mock；参照仓库现有 manager 测试的 mock 模式
// ... mock electron + store + options ...

describe('BrowserAnnotationManager editor 命令', () => {
  test('editor-submit add：从 activeDraft 取 anchor → saveComment → emit annotation-added', () => {
    // 构造 manager，store 预设 activeDraft（{id?, anchor, body}）
    // 调 onGuestMessage(tab, {type:'editor-submit', action:'add', body:'hi', tabId, generation, threadId})
    // 断言：store.saveComment 被调（attachment.anchor === activeDraft.anchor, body==='hi'）
    //       emit 'browser:annotation-added' with {threadId, tabId, attachment, snapshot}
    expect(true).toBe(true) // 占位——实施时按 manager 可测性补全 mock + 断言
  })

  test('editor-submit send：emit annotation-direct-submit', () => {
    // 同上，action:'send' → emit 'browser:annotation-direct-submit'
    expect(true).toBe(true)
  })

  test('editor-submit 无 activeDraft：不保存（return）', () => {
    // store 无 activeDraft → onGuestMessage editor-submit 不调 saveComment
    expect(true).toBe(true)
  })

  test('editor-cancel：store.clearDraft + syncGuest + emitSnapshot', () => {
    // 断言 clearDraft 被调
    expect(true).toBe(true)
  })

  test('editor-delete：activeDraft.id 存在 → this.delete(tab, threadId, id)', () => {
    // 断言 delete 被调 with activeDraft.id
    expect(true).toBe(true)
  })
})
```

> **实施注**：manager 测试需 mock electron（BrowserWindow/screen）、store、options.emit、tab。仓库若已有 `browser-annotation-manager.test.ts` 或类似（如 `-session.test.ts`），参照其 mock 模式。若 manager 不可单元测试（依赖重），改为：抽出 `handleEditorMessage(tab, payload)` 为可测方法（纯逻辑，调 store/emit），测试它。**核心断言**：editor-submit→saveAttachment+emit、cancel→clearDraft、delete→delete、无 activeDraft→no-op。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-annotation-manager.test.ts`
Expected: FAIL — editor 命令未处理

- [ ] **Step 3: 改 onGuestMessage 加 editor 分支**

在 `browser-annotation-manager.ts` 的 `onGuestMessage`（L118-184），在 `open-editor` 分支**之前**（或 preview 分支之后）加：

```ts
    if (payload.type === 'editor-submit') {
      const action = payload.action === 'send' ? 'send' : 'add'
      const body = text(payload.body, 20_000)
      if (!body) return
      const session = this.store.get(payload.threadId, tab.tabId, tab.url, tab.generation)
      const draft = session.activeDraft
      if (!draft?.anchor) return
      const saved = this.saveAttachment(tab, payload.threadId, draft.id, draft.anchor, body)
      this.options.emit(action === 'send' ? 'browser:annotation-direct-submit' : 'browser:annotation-added', { threadId: payload.threadId, tabId: tab.tabId, attachment: saved.attachment, snapshot: saved.snapshot })
      return
    }
    if (payload.type === 'editor-cancel') {
      const snapshot = this.store.clearDraft(payload.threadId, tab.tabId, tab.url, tab.generation)
      this.syncGuest(tab, snapshot)
      this.emitSnapshot(snapshot)
      return
    }
    if (payload.type === 'editor-delete') {
      const session = this.store.get(payload.threadId, tab.tabId, tab.url, tab.generation)
      const id = session.activeDraft?.id
      if (id) this.delete(tab, payload.threadId, id)
      return
    }
```

> 注：`draft.anchor` 类型为 `AgentBrowserAnchor`（store activeDraft 已是强类型）。`saveAttachment(tab, threadId, annotationId, anchor, body)` 签名匹配 L419。emit 事件名 + payload 对齐 handlePopupCommand L415（AgentInput 已监听 `browser:annotation-direct-submit` L503）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-annotation-manager.test.ts`
Expected: PASS

- [ ] **Step 5: verify（typecheck + 既有测试不退化）**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

Run: `cd apps/desktop && bun test`
Expected: 既有测试全绿（browser-overlay 68+ + session/security/position 既有 + 新 manager editor 测试）

---

## Task 44: EditorCard 提交接线确认 + 整合 build

**目标**：确认 EditorCard 提交回调（Task 41）经 AnnotationOverlay（Task 42）→ bridge.send → manager（Task 43）端到端契约一致；补 editor-submit 缺失字段校验测试（tabId/generation/threadId 对齐，对齐 onGuestMessage L121）；跑全量 typecheck + build，确认 overlay preload 打包 + 零倒退（main.ts:1119 未改）。

**Files:**
- Verify: 上述 3 task 产物的端到端契约
- Modify: 视 verify 结果补测试或微调

**Interfaces:**
- Consumes: Task 41-43 产物
- Produces: 全量 typecheck/build 绿；契约一致性确认

- [ ] **Step 1: 契约一致性核对（读代码，无改动的核对用 verify）**

核对三点契约：
1. EditorCard.onSubmit `(action:'add'|'send', body)` → AnnotationOverlay `bridge.send({type:'editor-submit', action, body})` → manager `payload.action`/`payload.body`（type 字符串、字段名一致）
2. EditorCard.onCancel → `bridge.send({type:'editor-cancel'})` → manager `payload.type === 'editor-cancel'`
3. EditorCard.onDelete → `bridge.send({type:'editor-delete'})` → manager `payload.type === 'editor-delete'`

若发现字段名/type 字符串不一致，修正（优先改 overlay 侧匹配 manager，因 manager 事件名 direct-submit/added 对齐 AgentInput 已有监听）。

- [ ] **Step 2: 补 editor-submit 校验测试（若 Task 43 未覆盖 tabId/generation/threadId 对齐）**

在 `browser-annotation-manager.test.ts` 补：editor-submit 带错误 tabId/generation/threadId → onGuestMessage 提前 return（L121 guard）→ 不调 saveAttachment。

- [ ] **Step 3: 全量测试**

Run: `cd apps/desktop && bun test`
Expected: 全绿（browser-overlay 77+ + manager editor + 既有套件；1 pre-existing guest-state electron cache fail 若仍存在，确认非本 plan 引入）

- [ ] **Step 4: typecheck**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 仅 2 个 pre-existing sdk baseline 错误，无新增

- [ ] **Step 5: build**

Run: `cd apps/desktop && bun ./scripts/build.ts`
Expected: 构建成功，`dist/preload/browser-overlay-preload.cjs` 产出（bundle 较 Plan 3 的 1,251 kB 略增，因 EditorCard + 样式）。`main.ts:1119` 仍 `browser-guest-preload.cjs`（overlay 休眠）。

- [ ] **Step 6: 零倒退确认**

核对（读 main.ts:1119 + grep popup 链路未删）：
- `main.ts:1119` → `browser-guest-preload.cjs`（未改）✓
- `openPopup`/`handlePopupCommand`/`BrowserAnnotationPopup.tsx`/`browser-annotation-preload.ts`/main.ts:2653 IPC handler 全部保留 ✓
- overlay preload 仍无 webContents 引用（休眠）✓

---

## 完成判据（Plan 4 收尾）

1. EditorCard 组件就位（按 Codex 网页内卡片设计 + 复刻 popup 交互），happy-dom 测试全绿。
2. overlayReducer 接线：activeDraft → restore-editor → EditorCard 渲染；提交/取消/删除经 bridge.send。
3. manager onGuestMessage 处理 editor-submit/cancel/delete（复用 saveAttachment/clearDraft/delete，emit direct-submit/added），popup 链路完全不动。
4. **零倒退**：main.ts:1119 未改，popup 链路保留，overlay 休眠。
5. typecheck 干净、build 成功、既有测试全绿。
6. 顺手补 Plan 3 follow-up #3（preview 定时器 cleanup）。
7. 无 git commit；ledger 更新 Plan 4 进度。

## Self-Review

**1. Spec 覆盖**（对照 spec §4.1 EditorCard + §4.2 manager 改造）：
- EditorCard 网页内卡片（非 BrowserWindow）：Task 41 ✓
- open/close/cancel/focus/restore；Enter=添加，Ctrl+Enter=发送：Task 41（键盘 + 回调）✓；restore 经 activeDraft → restore-editor（Task 42）✓
- manager onGuestMessage open-editor 不再开 popup → 改 activeDraft 驱动：**本 plan 不改 open-editor**（延续并行重写，popup 保留）；open-editor 仍 openPopup（guest preload 用），editor-* 是 overlay 新增路径。Plan 8 切 preload 后改 open-editor 走 activeDraft。**这是有意的范围收敛**（preload 合并 §10 未决）。
- 退役 popup：**留 Plan 8**（耦合切 preload）。
- editor:* IPC：用现有 lume:browser-annotation-guest channel（editor-submit/cancel/delete type），不新增 channel（约束 3）✓

**2. 占位符扫描**：Task 43 测试有 `expect(true).toBe(true)` 占位（因 manager 可测性待实施时确认 mock 模式）——实施时必须补全真实断言（saveComment 调用、emit 事件名/payload、clearDraft、delete）。Task 42 测试 harness 标注"按可测性调整"。这两个是实施时需落实的测试细节，非永久占位。

**3. 类型一致性**：
- `EditorCardProps.target: OverlayTarget` 与 overlayReducer 的 OverlayTarget 一致。
- `bridge.send({type:'editor-submit', action, body})` 的 action 'add'|'send' 与 manager `payload.action === 'send' ? 'send' : 'add'` 一致。
- `saveAttachment(tab, threadId, draft.id, draft.anchor, body)` 签名匹配 L419（annotationId: string | undefined）。
- emit 事件名 `browser:annotation-direct-submit`/`browser:annotation-added` 与 handlePopupCommand L415 + AgentInput L503 监听一致。

**4. 范围决策透明**：Global Constraint 2 明确"延续并行重写，不切 preload/不动 popup"，与 spec"Plan 4 退役 popup"有偏差——因 preload 合并是 §10 未决项，贸然切 preload 致功能断裂。Plan 8 解决。EditorCard 按 Codex 设计（约束 1）。
