# 浏览器注释 React Overlay 渲染接管 — 实施计划（Plan 2/N）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** 让 React overlay preload 接收主进程 `sync` 消息并渲染真实评论 Marker 列表（对齐 Codex markers-layer 渲染管线），把注释「渲染」职责从 `browser-guest-preload`（原生 DOM）接管到 React overlay。

**Architecture:** 把 guest-preload 中已验证的 anchor 纯函数（domPath/selector/buildAnchor/locateAnchor）迁移到 `browser-overlay/anchor.ts`；新增 `guest-state.ts` 做 sync IPC bridge；Marker/AnnotationOverlay 改为消费真实 comments 渲染编号 pin。**不切生产 preload**（guest 继续工作，零倒退），用纯函数单测 + 手动冒烟验证。

**Tech Stack:** React 18（Plan 1 已引入）、TypeScript、bun:test、Electron ipcRenderer。

**参考：** spec `docs/superpowers/specs/2026-08-02-browser-annotation-codex-parity-design.md` §4.1 / 附录 A.3（marker 管线）；Codex 分析 §3.2 / 附录 A.2。

## Global Constraints

- **不切生产 preload**：本 plan 不改 `main.ts:1119`（仍指向 `browser-guest-preload.cjs`）。guest 继续生产，overlay 作并行重写。切换 + guest 退役在最后一个 plan。
- **不修改 `browser-guest-preload.ts`**：anchor 函数是「迁移」（复制到 `anchor.ts`），不是「移动」。guest 保持原样。
- anchor 语义必须与 guest 现有实现一致（`domPath`/`selectorFor`/`buildAnchor`/`locateAnchor` 逐字段对齐），否则 overlay 渲染的 marker 与 guest 不一致。
- 测试 `bun:test`（非 vitest）。纯函数用单测；React 渲染用手动冒烟（注入测试页）。
- 不 commit（用户策略）。仓库用 bun。
- React 18 + jsx react-jsx（Plan 1 已配）。

---

## File Structure

| 文件 | 职责 | 创建/修改 |
|---|---|---|
| `apps/desktop/src/browser-overlay/anchor.ts` | anchor 纯函数（domPath/selectorFor/buildAnchor/locateAnchor/rectOf 等，迁移自 guest） | 创建 |
| `apps/desktop/src/browser-overlay/anchor.test.ts` | anchor 纯函数单测 | 创建 |
| `apps/desktop/src/browser-overlay/guest-state.ts` | GuestState 类型 + sanitizeSync + createGuestBridge（ipcRenderer 监听/发送） | 创建 |
| `apps/desktop/src/browser-overlay/Marker.tsx` | 真实 Marker 组件（commentNumber + 定位 + attached/stale/detached） | 创建 |
| `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx` | 改：接 GuestState，渲染 Marker 列表 | 修改 |
| `apps/desktop/src/browser-overlay-preload.tsx` | 改：接 guest bridge，sync→React state | 修改 |

---

## Task 1: anchor 纯函数迁移 + 单测

**Files:**
- Create: `apps/desktop/src/browser-overlay/anchor.ts`
- Test: `apps/desktop/src/browser-overlay/anchor.test.ts`

**Interfaces:**
- Produces: `Rect`, `Located`, `domPath(element)`, `selectorFor(element)`, `buildAnchor(...)`, `locateAnchor(anchor, doc, win)`, `rectOf(...)`, `cssEscape(...)`, `boundedNumber/boundedText` 等（Task 3/4 的 Marker/AnnotationOverlay 消费）。

**来源**：`apps/desktop/src/browser-guest-preload.ts:414-527`（buildAnchor/locateAnchor/resolveRange/resolvePathNode/rangeDescriptor/domPath/selectorFor/rectOf/sanitizeRect/boundedNumber/boundedOffset/boundedText/cssEscape）。逐函数复制，保持签名与语义一致。

- [ ] **Step 1: 写失败测试 `anchor.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { domPath, selectorFor, buildAnchor, locateAnchor, rectOf, cssEscape } from './anchor'

test('domPath 生成 tag > nth-of-type 路径', () => {
  document.body.innerHTML = '<div><span></span><span></span></div>'
  const span = document.body.querySelector('span:last-child')!
  expect(domPath(span)).toBe('div > span:nth-of-type(2)')
})

test('selectorFor 优先 #id', () => {
  document.body.innerHTML = '<div id="x"></div>'
  expect(selectorFor(document.getElementById('x')!)).toBe('#x')
})

test('selectorFor 用 data-testid', () => {
  document.body.innerHTML = '<button data-testid="save"></button>'
  expect(selectorFor(document.querySelector('button')!)).toBe('[data-testid="save"]')
})

test('cssEscape 转义特殊字符', () => {
  expect(cssEscape('a.b')).toBe('a\\.b')
})

test('locateAnchor 用 selector 找回元素', () => {
  document.body.innerHTML = '<button id="save">Save</button>'
  const win = window as unknown as { location: { href: string } }
  win.location.href = location.href
  const anchor = { kind: 'element' as const, url: location.href, generation: 1, framePath: [], rect: { x: 0, y: 0, width: 10, height: 10 }, selector: '#save' }
  const located = locateAnchor(anchor as never, document, window)
  expect(located?.status).toBe('attached')
  expect(located?.target).toBe(document.getElementById('save'))
})

test('locateAnchor 无匹配回退 degraded rect', () => {
  const anchor = { kind: 'element', url: 'http://nonexistent.invalid', generation: 1, framePath: [], rect: { x: 5, y: 5, width: 10, height: 10 } }
  const located = locateAnchor(anchor as never, document, window)
  expect(located?.status).toBe('degraded')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/anchor.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `anchor.ts`（从 guest-preload:414-527 复制）**

把 `browser-guest-preload.ts` 的以下函数**逐字复制**到 `anchor.ts`（保持签名/实现一致）：`buildAnchor`、`locateAnchor`、`resolveRange`、`resolvePathNode`、`rangeDescriptor`、`domPath`、`selectorFor`、`topWindow`、`rectOf`、`sanitizeRect`、`boundedNumber`、`boundedOffset`、`boundedText`、`cssEscape`、`isRecord`。并 `export type Rect` 与 `export type Located = { rect: Rect; status: 'attached' | 'degraded'; target?: Element }`。

> 实现者：打开 `apps/desktop/src/browser-guest-preload.ts` 第 414-527 行，把这些函数（及它们依赖的 Rect/Located 类型和辅助函数）原样复制到 `anchor.ts` 并加上 `export`。**不要改逻辑**——guest 与 overlay 必须语义一致。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/anchor.test.ts`
Expected: PASS（6 测试）。

- [ ] **Step 5: 类型检查**

Run: `cd apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无新错误。

- [ ] **Step 6: Checkpoint**

anchor 纯函数迁移完成（与 guest 语义一致），6/6 单测通过。

---

## Task 2: GuestState + sync IPC bridge

**Files:**
- Create: `apps/desktop/src/browser-overlay/guest-state.ts`

**Interfaces:**
- Produces: `GuestState` 类型、`sanitizeSync(raw)`（校验+清洗 sync 消息）、`createGuestBridge({ onState })`（封装 ipcRenderer 监听 `lume:browser-annotation-guest` + 发送 `send(payload)`）。Task 4 的 AnnotationOverlay / Task 5 的 preload 消费。

**来源**：guest-preload 的 `GuestAnnotationRuntime.receive/send`（line 56-92）+ `AnnotationMessage`/`GuestState` 类型（line 3-25）。

- [ ] **Step 1: 实现 `guest-state.ts`**

```ts
import { ipcRenderer } from 'electron'

export type AnchorKind = 'element' | 'text' | 'region'
export type GuestComment = Record<string, unknown> // 上层按需读取 anchor/body/id

export type GuestState = {
  tabId: string
  generation: number
  threadId: string
  mode: 'browse' | 'comment'
  purpose: 'annotation' | 'tweaks'
  theme?: string
  comments: GuestComment[]
  activeDraft?: Record<string, unknown>
}

export type GuestBridge = {
  getState: () => GuestState | null
  send: (payload: Record<string, unknown>) => void
  subscribe: (listener: (state: GuestState | null) => void) => () => void
}

// 校验主进程发来的 sync/restore 消息，失败返回 null（消息来源不可信）
export function sanitizeSync(raw: unknown): GuestState | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.type !== 'sync' && m.type !== 'restore') return null
  if (typeof m.tabId !== 'string' || m.tabId.length < 1 || m.tabId.length > 256) return null
  if (typeof m.generation !== 'number' || !Number.isInteger(m.generation) || m.generation < 1 || m.generation > 2_000_000) return null
  if (typeof m.threadId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(m.threadId)) return null
  const theme = typeof m.theme === 'string' && m.theme.length <= 128 && (typeof CSS === 'undefined' || CSS.supports('color', m.theme)) ? m.theme : undefined
  return {
    tabId: m.tabId,
    generation: m.generation,
    threadId: m.threadId,
    mode: m.mode === 'comment' ? 'comment' : 'browse',
    purpose: m.purpose === 'tweaks' ? 'tweaks' : 'annotation',
    ...(theme ? { theme } : {}),
    comments: Array.isArray(m.comments) ? m.comments.slice(0, 100).filter((c): c is GuestComment => Boolean(c && typeof c === 'object')) : [],
    ...(m.activeDraft && typeof m.activeDraft === 'object' ? { activeDraft: m.activeDraft as GuestComment } : {}),
  }
}

// 封装 ipcRenderer：监听 lume:browser-annotation-guest，清洗后通知 listener；提供 send 回发主进程
export function createGuestBridge(initialListener?: (state: GuestState | null) => void): GuestBridge {
  let state: GuestState | null = null
  const listeners = new Set<(state: GuestState | null) => void>()
  if (initialListener) listeners.add(initialListener)

  const handler = (_e: Electron.IpcRendererEvent, raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    if (m.type === 'close') { state = null; listeners.forEach((l) => l(null)); return }
    const next = sanitizeSync(raw)
    if (!next) return
    state = next
    listeners.forEach((l) => l(next))
  }
  ipcRenderer.on('lume:browser-annotation-guest', handler)

  return {
    getState: () => state,
    send: (payload) => {
      if (!state || JSON.stringify(payload).length > 1_000_000) return
      ipcRenderer.send('lume:browser-annotation-guest', { ...payload, tabId: state.tabId, generation: state.generation, threadId: state.threadId })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      if (state) queueMicrotask(() => listener(state))
      return () => listeners.delete(listener)
    },
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无新错误。

- [ ] **Step 3: Checkpoint**

GuestState + IPC bridge 就位（对齐 guest receive/send 语义）。

---

## Task 3: Marker 组件（真实渲染）

**Files:**
- Create: `apps/desktop/src/browser-overlay/Marker.tsx`

**Interfaces:**
- Consumes: `rectOf`/`locateAnchor`（Task 1）
- Produces: `<Marker comment={} index={} viewportSize={} />`（Task 4 消费）。

- [ ] **Step 1: 实现 `Marker.tsx`（对齐 Codex `.marker` + guest `renderMarker`）**

```tsx
import { useMemo } from 'react'
import { locateAnchor, rectOf, type Rect } from './anchor'

type MarkerProps = {
  comment: Record<string, unknown>
  index: number
  viewportSize?: { width: number; height: number }
  win: Window
}

// 单个评论 pin。定位到 anchor markerPoint（element）或 rect 中心；状态：attached/stale/detached。
export function Marker({ comment, index, viewportSize, win }: MarkerProps) {
  const anchor = comment.anchor as Record<string, unknown> | undefined
  const located = useMemo(() => (anchor ? locateAnchor(anchor as never, document, win) : undefined), [anchor, win])

  if (!anchor) return null
  const fallback = (anchor.rect as Rect | undefined) ?? { x: 8, y: 8 + index * 28, width: 1, height: 1 }
  const rect = located?.rect ?? fallback
  // marker 定位：rect 右上角偏移（对齐 guest renderMarker）
  const left = Math.max(0, Math.min((viewportSize?.width ?? win.innerWidth) - 24, rect.x + rect.width - 12))
  const top = Math.max(0, Math.min((viewportSize?.height ?? win.innerHeight) - 24, rect.y - 12))

  const stateClass = located ? (located.status === 'degraded' ? 'detached' : '') : 'stale detached'
  return (
    <button
      type="button"
      className={`marker saved-marker${stateClass ? ` ${stateClass}` : ''}`}
      data-selected="false"
      style={{ left, top }}
      aria-label={located ? `批注 ${index + 1}` : `批注 ${index + 1} 已失效`}
    >
      <span className="marker-label">{index + 1}</span>
    </button>
  )
}

void rectOf // 占位引用（locateAnchor 内部已用）；后续交互任务用到 rectOf
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无新错误。

- [ ] **Step 3: Checkpoint**

Marker 组件就位（commentNumber + 定位 + 状态）。

---

## Task 4: AnnotationOverlay 渲染真实 Marker 列表

**Files:**
- Modify: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`

**Interfaces:**
- Consumes: `Marker`（Task 3）、`GuestState`/`GuestBridge`（Task 2）

- [ ] **Step 1: 改 `AnnotationOverlay.tsx` 接 GuestState 渲染 Marker 列表**

```tsx
import { useEffect, useReducer, useState } from 'react'
import { Marker } from './Marker'
import { overlayReducer, type OverlayEditorState } from './overlayReducer'
import type { GuestBridge, GuestState } from './guest-state'

// 接 bridge 同步 guest state，渲染真实 Marker 列表（comments）。
// 删除 Plan 1 的 hello marker 与空 <style>（样式由 preload Shadow DOM 注入，组件不重复）。
export function AnnotationOverlay({ bridge }: { bridge: GuestBridge }) {
  const [state, setState] = useState<GuestState | null>(() => bridge.getState())
  const [editor] = useReducer(overlayReducer, { type: 'idle' } as OverlayEditorState)
  useEffect(() => bridge.subscribe(setState), [bridge])
  void editor // 后续交互任务用到（编辑器状态机），本 task 仅渲染
  const comments = state?.comments ?? []
  return (
    <div className="markers-layer">
      {comments.map((comment, index) => (
        <Marker key={String(comment.id ?? index)} comment={comment} index={index} win={window} />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 构建验证**

Run: `cd apps/desktop && bun ./scripts/build.ts`
Expected: 成功（AnnotationOverlay 现在 import Marker + guest-state + overlayReducer，bundle 仍增长）。

- [ ] **Step 3: 类型检查**

Run: `cd apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无新错误。

- [ ] **Step 4: Checkpoint**

AnnotationOverlay 渲染真实 Marker 列表（接 GuestState）。

---

## Task 5: browser-overlay-preload 接 bridge 驱动 React

**Files:**
- Modify: `apps/desktop/src/browser-overlay-preload.tsx`

- [ ] **Step 1: 改 preload 用 createGuestBridge 驱动 AnnotationOverlay**

把 `browser-overlay-preload.tsx` 的 `start()` 改为：创建 bridge → 传给 AnnotationOverlay：

```tsx
import { createRoot } from 'react-dom/client'
import { ipcRenderer } from 'electron'
import { AnnotationOverlay } from './browser-overlay/AnnotationOverlay'
import { createGuestBridge } from './browser-overlay/guest-state'
import { overlayStyles } from './browser-overlay/overlay.css'

const bootstrapUrl = window.location.href
if (bootstrapUrl.startsWith('about:blank#lume-browser-mount=')) {
  ipcRenderer.send('lume:browser-guest-mounted', bootstrapUrl)
}

function start(): void {
  if (document.querySelector('div[data-lume-annotation-overlay]')) return
  const host = document.createElement('div')
  host.setAttribute('data-lume-annotation-overlay', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = overlayStyles
  shadow.append(style)
  document.documentElement.append(host)
  const bridge = createGuestBridge()
  createRoot(shadow).render(<AnnotationOverlay bridge={bridge} />)
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
else start()

export {}
```

- [ ] **Step 2: 构建验证**

Run: `cd apps/desktop && bun ./scripts/build.ts`
Expected: 成功；`browser-overlay-preload.cjs` 仍产出。

- [ ] **Step 3: 类型检查**

Run: `cd apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无新错误。

- [ ] **Step 4: 手动冒烟（若可跑 desktop dev）**

把测试页 webContents 的 preload 临时指向 `browser-overlay-preload.cjs`（**不改 main.ts:1119 生产配置**，仅 dev 测试），触发一条 sync（带 comments），确认：
- marker pin 按编号渲染到 anchor 位置
- 无 React/Shadow DOM 错误

> 若无法跑 dev，此步推迟到后续 e2e。本 plan 以「构建+类型+anchor 单测」为门禁。

- [ ] **Step 5: Checkpoint（Plan 2 完成）**

React overlay 能接收 sync 并渲染真实 Marker 列表（接管注释渲染职责）。交互捕获（click/text/region→open-editor）、Selection/Preview 视觉在 Plan 3。生产 preload 未切换（guest 继续工作，零倒退）。

---

## Self-Review

**1. Spec 覆盖**：本 plan 覆盖 spec §11 阶段 2 的「渲染接管」核心（sync 接入 + 真实 Marker）。交互捕获、Selection/Cursor/Preview、EditorCard、design、WebMcp 在 Plan 3+。

**2. 占位符**：Task 4 的代码块含「实现者注」说明 hooks 规则简化——这是必要的实现指引（避免 hooks 嵌套调用错误），非占位。其余 task 含完整代码。

**3. 类型一致性**：`GuestState`/`GuestBridge`/`GuestComment`（Task 2）在 Task 4/5 消费，命名一致。`Marker` props（Task 3）与 Task 4 调用一致。`anchor.ts` 导出（Task 1）与 Task 3 消费一致。

**4. 范围**：本 plan 自包含（overlay 接 sync 渲染真实 marker，anchor 单测验证），零倒退（不切生产 preload）。

**未覆盖（后续 plan）**：交互捕获（click/text/region→open-editor）、SelectionHighlight/CursorBadge/PreviewCard、FrameTarget 跨 frame、EditorCard、design-editor、Web MCP 注入、截图 cropRect、宿主面板对齐、生产 preload 切换 + guest 退役 + 全量回归。
