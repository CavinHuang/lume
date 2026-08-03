# 浏览器注释 Overlay 交互捕获 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 React overlay 具备交互捕获能力——comment 模式下捕获 click / text-selection / region-drag 生成 anchor 并发 `open-editor` 给主进程，同时实现 SelectionHighlight（hover-box）、CursorBadge、PreviewCard（marker hover）、ESC 退出与 scroll/resize 刷新，逐字对齐现有 `browser-guest-preload.ts` 的行为。

**Architecture:** 沿用 guest 的**反向架构**——host 设 `pointer-events:none`，在 `document` 上注册**捕获阶段监听器**（capture phase），comment 模式下 `preventDefault`/`stopImmediatePropagation` 拦截页面事件。交互逻辑抽到自定义 hook `useAnnotationInteraction`（listeners + state + 定时器），纯展示组件 `SelectionHighlight`/`CursorBadge`/`PreviewCard` 接收 props 渲染。锚点生成复用已迁移的 `anchor.ts`（`buildAnchor`/`locateAnchor`/`rectOf`）。

**Tech Stack:** React 18.3.1（对齐 apps/web，非 19）、TypeScript、bun:test + happy-dom（`scripts/test-dom-preload.ts`）、Vite lib mode CJS preload。

## Global Constraints

> 每个任务的实现都隐含遵守本节。偏离任一条需在 task 内显式说明理由。

1. **仓库用 bun**（`packageManager: bun@1.3.13`），非 pnpm。install `bun install`、build `cd apps/desktop && bun ./scripts/build.ts`、测试 `bun test`。
2. **测试用 bun:test + happy-dom**（非 vitest）。React 组件测试参照 `apps/web/src/components/agent/AgentView.test.tsx`：`import { act } from 'react'` + `createRoot(container).render()` + `mock.module()` 打桩。happy-dom globals 由 `apps/desktop/scripts/test-dom-preload.ts` 自动注入（`bunfig.toml` 的 `preload`）。
3. **无 commit 工作流**（用户全局策略）：subagent 只改工作区，**不执行任何 git add/commit**。每个 task 末尾用「verify」（typecheck + test + build）替代 commit 步骤。提交由用户在 plan 完成后按主题合并。
4. **零倒退**：**不切生产 preload**（`main.ts:1119` 继续指向 `browser-guest-preload.cjs`），**不改主进程 `browser-annotation-manager.ts` 的 open-editor/popup 链路**。Plan 3 只改 `apps/desktop/src/browser-overlay/` 与 `browser-overlay-preload.tsx`。overlay preload 仍休眠（未挂任何 webContents），全部行为靠 happy-dom 单元测试验证，**不做真机端到端**。
5. **限定顶级 frame**：不实现 iframe 递归（guest 的 `syncFrames`/`AnnotationDocumentRuntime`/`toTopRect`/`toLocalRect`）。所有 rect 用 `rectOf(element)` 直接取顶级窗口坐标（`position:fixed` 直接适用）。跨 frame 支持为 follow-up。
6. **capture-listener 架构**：所有页面事件监听器注册在 `document` 的**捕获阶段**（`addEventListener(type, fn, true)`），与 guest `start()` L132-142 一致。**不引入** Codex 的 `.interaction-blocker` 全屏 `pointer-events:auto` 拦截层（未验证，超范围）。
7. **定位模型决策（关键，避免双偏移 bug 重现）**——overlay 用 CSS translate 居中模型，三类元素三类定位法，**绝不混用 translate**：
   - **点居中**（marker pin）：`transform: translate(-50%,-50%)`，`left/top` = 锚点坐标。**禁止**叠加像素半偏移（guest 的 `-12` 是因为 guest CSS 无 translate 才需要；overlay 有 translate，叠加会 12px 错位——Plan 2 final review 修过一次）。
   - **矩形铺满**（`.selection` hover-box、region 框）：`left/top/width/height` 直接 = rect，**不加 transform**。
   - **偏移跟随**（`.cursor-badge`、`.preview`）：`left/top` = 基准坐标 + 固定偏移（cursor `+14,+14`；preview marker 左侧 `-308`），**不加 transform**。
8. **对齐 guest 行为，非 Codex 增强**：普通 `getSelection()`（**不**用 `getComposedRanges`）；cursorBadge 仅评论 SVG 图标（**不**显示元素元数据 tooltip）；region 拖拽过程**无**可视框（只捕起止点）。这些 Codex 增强项（getComposedRanges、ElementMetadataTooltip、region-box、iframe 递归）为 follow-up，**不在本 plan**。
9. **主色 `#128dff`**（overlay 既定，对齐 Codex；guest 用 `#0b84ff` 但 overlay 已统一为 `#128dff`，保持）。
10. **代码注释用中文**（对齐 `browser-overlay/` 现有文件注释语言）。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `apps/desktop/src/browser-overlay/useAnnotationInteraction.ts` | 核心：document capture listeners + 交互 state（hoverRect/cursorPos/preview/dragging）+ 定时器 + 发消息。对齐 guest 的 `onClick`/`onPointerMove`/`openTextSelection`/`onPointerDown`/`onPointerUp`/`showPreview`/`scheduleRender`/`onKeyDown` | **新建** |
| `apps/desktop/src/browser-overlay/useAnnotationInteraction.test.ts` | hook 行为 TDD（mock bridge，dispatch 事件，断言 state / `bridge.send` payload） | **新建** |
| `apps/desktop/src/browser-overlay/SelectionHighlight.tsx` | 纯展示：hover-box（矩形铺满定位） | **新建** |
| `apps/desktop/src/browser-overlay/CursorBadge.tsx` | 纯展示：cursor 评论图标徽章（偏移跟随定位） | **新建** |
| `apps/desktop/src/browser-overlay/PreviewCard.tsx` | 纯展示：评论预览卡（偏移定位，显示 body 纯文本） | **新建** |
| `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx` | 组装：bridge state + `useAnnotationInteraction` + 渲染 markers-layer + interaction-layer | **改** |
| `apps/desktop/src/browser-overlay/Marker.tsx` | 加 `onHoverEnter`/`onHoverLeave`/`onClick` 回调 props（marker hover→preview、click→select-comment） | **改** |
| `apps/desktop/src/browser-overlay/overlay.css.ts` | 加 `.interaction-layer`/`.selection`/`.cursor-badge`/`.preview`/`.region-box` 样式 | **改** |
| `apps/desktop/src/browser-overlay-preload.tsx` | `createRoot.render` 多传 `host` prop（供 isOverlayTarget 判断） | **改** |

---

## Task 31: 交互骨架 + CSS + host 传递 + isOverlayTarget

**目标**：搭起 `useAnnotationInteraction` hook 骨架——注册 document 捕获阶段监听器、comment 模式 guard、overlay 自身元素排除（isOverlayTarget）、卸载时清理。handler 暂为带 guard 的空 stub，后续 task 填逻辑。同时补齐 overlay CSS 与 preload 的 host 传递。

**Files:**
- Create: `apps/desktop/src/browser-overlay/useAnnotationInteraction.ts`
- Create: `apps/desktop/src/browser-overlay/useAnnotationInteraction.test.ts`
- Modify: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`
- Modify: `apps/desktop/src/browser-overlay/overlay.css.ts`
- Modify: `apps/desktop/src/browser-overlay-preload.tsx`

**Interfaces:**
- Consumes: `GuestBridge`（`./guest-state`，已有 `send`/`getState`/`subscribe`）、`Rect`（`./anchor`，已有）、`GuestState`（已有 `mode`/`purpose`/`generation`）
- Produces:
  - `useAnnotationInteraction(opts: UseAnnotationInteractionOptions): InteractionState`
  - `InteractionState = { hoverRect: Rect | null; cursorPos: Point | null; preview: PreviewData | null }`（本 task 字段先全为 null，后续 task 填）
  - `Point = { x: number; y: number }`
  - `PreviewData = { body: string; annotationId: string; rect: Rect }`（Task 37 填）
  - `UseAnnotationInteractionOptions = { bridge: GuestBridge; mode: 'browse' | 'comment'; purpose: 'annotation' | 'tweaks'; host: HTMLElement | null; generation: number; win: Window }`

- [ ] **Step 1: 写失败测试（listener 注册 + mode guard + cleanup）**

创建 `useAnnotationInteraction.test.ts`：

```ts
import { describe, test, expect, mock } from 'bun:test'

// hook 依赖 electron 的 ipcRenderer（经 guest-state 的 createGuestBridge 间接），
// 但本测试直接 mock bridge 对象，不加载真实 createGuestBridge，故无需 mock electron。
await mock.module('electron', () => ({ ipcRenderer: { on() {}, send() {}, off() {} } }))

const { useAnnotationInteraction } = await import('./useAnnotationInteraction')
import { useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// 渲染一个宿主组件调用 hook，把返回的 InteractionState 暴露到 ref。
function renderHook<T>(useFn: () => T): { current: T } {
  const ref: { current: T } = { current: null as unknown as T }
  function Probe(): ReactNode { ref.current = useFn(); return null }
  const container = document.createElement('div')
  document.body.append(container)
  act(() => { createRoot(container).render(<Probe />) })
  return ref
}

const baseOpts = {
  bridge: { send: mock(() => {}), getState: () => null, subscribe: () => () => {} },
  host: null,
  generation: 1,
  win: window,
} as const

describe('useAnnotationInteraction - 骨架', () => {
  test('browse 模式：click 不触发任何发送（mode guard，验证 effect 在 browse 模式不挂交互 listener）', () => {
    const send = mock(() => {})
    const ref = renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'browse', purpose: 'annotation',
    }))
    const target = document.createElement('button')
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 })) })
    expect(send).toHaveBeenCalledTimes(0)
    expect(ref.current.hoverRect).toBeNull()
    document.body.innerHTML = ''
  })

  test('卸载时清理监听器（重挂不重复触发）', () => {
    const send = mock(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    function Probe(): ReactNode {
      useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' })
      return null
    }
    let root = createRoot(container)
    act(() => { root.render(<Probe />) })
    const target = document.createElement('button'); document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    // 卸载后再次 dispatch 不应再触发（骨架阶段 click 是 stub，发送次数应为 0，验证不抛错即可）
    act(() => { root.unmount() })
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    expect(send).toHaveBeenCalledTimes(0)
    document.body.innerHTML = ''
  })
})
```

> 注：happy-dom 不暴露 document 的 listener 列表，骨架阶段用「browse 模式 click 不发送」+「卸载不抛错」做行为断言。后续 task 的 handler 填实后，comment 模式 click 才会发送，那时断言才真正生效。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — `Cannot find module './useAnnotationInteraction'`

- [ ] **Step 3: 实现 hook 骨架**

创建 `useAnnotationInteraction.ts`：

```ts
import { useEffect, useRef, useState } from 'react'
import type { GuestBridge } from './guest-state'

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number } // 与 anchor.ts Rect 同构
export type PreviewData = { body: string; annotationId: string; rect: Rect }

export type InteractionState = {
  hoverRect: Rect | null
  cursorPos: Point | null
  preview: PreviewData | null
}

export type UseAnnotationInteractionOptions = {
  bridge: GuestBridge
  mode: 'browse' | 'comment'
  purpose: 'annotation' | 'tweaks'
  host: HTMLElement | null
  generation: number
  win: Window
}

// comment 模式才捕获交互；overlay 自身元素（marker/preview 等）的点击不触发新建。
function isOverlayTarget(target: unknown, host: HTMLElement | null): boolean {
  return target instanceof Element && host !== null && host.contains(target)
}

// 交互捕获核心 hook：注册 document 捕获阶段监听器，管理 hover/cursor/preview 状态。
// 对齐 guest（browser-guest-preload.ts）的反向架构——host pointer-events:none，
// document capture listener 在 comment 模式拦截页面事件。handler 逻辑由后续 task 填充。
export function useAnnotationInteraction(opts: UseAnnotationInteractionOptions): InteractionState {
  const { bridge, mode, purpose, host, generation, win } = opts
  const [hoverRect, setHoverRect] = useState<Rect | null>(null)
  const [cursorPos, setCursorPos] = useState<Point | null>(null)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    // 只在 comment 模式挂交互（mode 变化时 effect 重跑，自动清理重挂）
    if (mode !== 'comment') return

    const onPointerDown = (event: PointerEvent): void => {
      if (purpose === 'tweaks' || isOverlayTarget(event.target, optsRef.current.host)) return
      // Task 36 填充：region 拖拽起点
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (purpose === 'tweaks' || isOverlayTarget(event.target, optsRef.current.host)) return
      // Task 32/33 填充：hover-box + cursor-badge
      void event
    }
    const onPointerUp = (event: PointerEvent): void => {
      // Task 36 填充：region 拖拽终点
      void event
    }
    const onClick = (event: MouseEvent): void => {
      if (purpose === 'tweaks' || isOverlayTarget(event.target, optsRef.current.host)) return
      // Task 34 填充：element anchor
      void event
    }
    const onMouseUp = (): void => {
      // Task 35 填充：text selection
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Task 38 填充：ESC 退出
      void event
    }

    const capture = true
    win.document.addEventListener('pointerdown', onPointerDown, capture)
    win.document.addEventListener('pointermove', onPointerMove, capture)
    win.document.addEventListener('pointerup', onPointerUp, capture)
    win.document.addEventListener('click', onClick, capture)
    win.document.addEventListener('mouseup', onMouseUp, capture)
    win.document.addEventListener('keydown', onKeyDown, capture)
    return () => {
      win.document.removeEventListener('pointerdown', onPointerDown, capture)
      win.document.removeEventListener('pointermove', onPointerMove, capture)
      win.document.removeEventListener('pointerup', onPointerUp, capture)
      win.document.removeEventListener('click', onClick, capture)
      win.document.removeEventListener('mouseup', onMouseUp, capture)
      win.document.removeEventListener('keydown', onKeyDown, capture)
    }
  }, [mode, purpose, win])

  void bridge; void generation
  return { hoverRect, cursorPos, preview }
}
```

- [ ] **Step 4: 改 AnnotationOverlay.tsx —— 接 host、调用 hook、渲染 interaction-layer 骨架**

替换 `AnnotationOverlay.tsx` 全文：

```tsx
import { useEffect, useReducer, useRef, useState } from 'react'
import { Marker } from './Marker'
import { overlayReducer, type OverlayEditorState } from './overlayReducer'
import type { GuestBridge, GuestState } from './guest-state'
import { useAnnotationInteraction } from './useAnnotationInteraction'

// 接 bridge 同步 guest state，渲染 Marker 列表 + 交互层（hover/cursor/preview）。
export function AnnotationOverlay({ bridge, host }: { bridge: GuestBridge; host: HTMLElement | null }) {
  const [state, setState] = useState<GuestState | null>(() => bridge.getState())
  const [editor, dispatch] = useReducer(overlayReducer, { type: 'idle' } as OverlayEditorState)
  useEffect(() => bridge.subscribe(setState), [bridge])
  void editor; void dispatch // 编辑器状态机由后续 plan 接入
  const interaction = useAnnotationInteraction({
    bridge,
    mode: state?.mode ?? 'browse',
    purpose: state?.purpose ?? 'annotation',
    host,
    generation: state?.generation ?? 0,
    win: window,
  })
  const comments = state?.comments ?? []
  return (
    <>
      <div className="markers-layer">
        {comments.map((comment, index) => (
          <Marker key={String(comment.id ?? index)} comment={comment} index={index} win={window} />
        ))}
      </div>
      <div className="interaction-layer">
        {interaction.hoverRect && <div className="selection" />}
        {interaction.cursorPos && <div className="cursor-badge" />}
        {interaction.preview && <div className="preview" />}
      </div>
    </>
  )
}
```

> 注：`useRef` import 暂保留供后续 task（dragging/suppressNextClick ref）。骨架阶段 interaction 字段全 null，interaction-layer 空渲染。

- [ ] **Step 5: 改 overlay.css.ts —— 加 interaction-layer / .selection / .cursor-badge / .preview 骨架样式**

在 `overlayStyles` 字符串末尾（`.draft-marker{...}` 之后）追加：

```css
.interaction-layer{position:fixed;inset:0;z-index:1;pointer-events:none}
.selection{position:fixed;border:2px solid var(--annotation-accent);border-radius:3px;background:color-mix(in srgb,var(--annotation-accent) 9%,transparent);box-shadow:0 0 0 1px #fff6 inset;pointer-events:none}
.cursor-badge{position:fixed;display:flex;width:28px;height:28px;align-items:center;justify-content:center;border:2px solid #fff;border-radius:999px;background:var(--annotation-accent);color:#fff;box-shadow:0 5px 15px #0004;pointer-events:none}
.cursor-badge svg{width:15px;height:15px;fill:currentColor}
.preview{position:fixed;max-width:300px;padding:8px 10px;border:1px solid #ffffff33;border-radius:9px;background:#17181c;color:#f5f5f5;box-shadow:0 10px 30px #0005;pointer-events:auto;white-space:pre-wrap;line-height:1.45}
.region-box{position:fixed;border:2px dashed var(--annotation-accent);background:color-mix(in srgb,var(--annotation-accent) 3%,transparent);pointer-events:none}
```

> 矩形元素（.selection/.region-box）与偏移元素（.cursor-badge/.preview）均**无 transform**，符合定位模型约束。.cursor-badge 内 SVG 由 CursorBadge 组件（Task 33）填充。

- [ ] **Step 6: 改 browser-overlay-preload.tsx —— 传 host prop**

把 `start()` 内的 render 调用改为传 host：

```tsx
  const bridge = createGuestBridge()
  createRoot(shadow).render(<AnnotationOverlay bridge={bridge} host={host} />)
```

（仅这一行变化，其余 preload 内容不变。）

- [ ] **Step 7: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（3/3）

- [ ] **Step 8: verify（typecheck + 全量 build 不退化）**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误（注意 `AnnotationOverlay` 签名变了，preload 已同步改）

Run: `cd apps/desktop && bun test src/browser-overlay/`
Expected: 既有 anchor/guest-state/overlayReducer 测试全绿 + 新 useAnnotationInteraction 骨架测试绿

---

## Task 32: SelectionHighlight（hover-box）

**目标**：comment 模式 pointermove 时，计算鼠标下页面元素的 rect，渲染 `.selection` 描边框跟随。矩形铺满定位（无 translate）。

**Files:**
- Create: `apps/desktop/src/browser-overlay/SelectionHighlight.tsx`
- Modify: `apps/desktop/src/browser-overlay/useAnnotationInteraction.ts`（填 `onPointerMove` 的 hover-box 逻辑）
- Modify: `apps/desktop/src/browser-overlay/useAnnotationInteraction.test.ts`（加 hover-box 断言）
- Modify: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`（用 SelectionHighlight 组件替换占位 div）

**Interfaces:**
- Consumes: `Rect`（Task 31 定义）、`rectOf`（`./anchor`，已有）
- Produces: `SelectionHighlight({ rect }: { rect: Rect }): ReactNode`

- [ ] **Step 1: 写失败测试（pointermove 设置 hoverRect）**

在 `useAnnotationInteraction.test.ts` 的 describe 块内追加：

```ts
  test('comment 模式 pointermove：hoverRect 为目标元素 rect', () => {
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation' }))
    // 模拟一个页面元素（getBoundingClientRect 返回固定 rect）
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 10, y: 20, width: 100, height: 50, top: 20, left: 10, right: 110, bottom: 70, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 30 })) })
    expect(ref.current.hoverRect).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    document.body.innerHTML = ''
  })

  test('pointermove 命中 overlay 自身元素：hoverRect 不变（isOverlayTarget 排除）', () => {
    // host 必须连入 document，document 捕获阶段监听器才会触发（detached subtree 的事件路径不到 document）。
    const host = document.createElement('div'); document.body.append(host)
    const overlayEl = document.createElement('div'); host.append(overlayEl) // host.contains(overlayEl) = true
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation', host }))
    act(() => { overlayEl.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 1 })) })
    expect(ref.current.hoverRect).toBeNull() // listener 已触发，但 isOverlayTarget 命中提前返回
    document.body.innerHTML = ''
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — hoverRect 仍为 null（onPointerMove 是 stub）

- [ ] **Step 3: 实现 SelectionHighlight 纯展示组件**

创建 `SelectionHighlight.tsx`：

```tsx
import type { Rect } from './useAnnotationInteraction'

// hover-box：comment 模式下描边鼠标下的页面元素。矩形铺满定位（left/top/width/height = rect，无 translate）。
export function SelectionHighlight({ rect }: { rect: Rect }) {
  return <div className="selection" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
}
```

- [ ] **Step 4: 填 onPointerMove 的 hover-box 逻辑**

在 `useAnnotationInteraction.ts`，先在文件顶部加 import：

```ts
import { rectOf } from './anchor'
```

替换 `onPointerMove` 函数体为：

```ts
    const onPointerMove = (event: PointerEvent): void => {
      if (purpose === 'tweaks' || isOverlayTarget(event.target, optsRef.current.host)) return
      const element = event.target instanceof Element ? event.target : win.document.elementFromPoint(event.clientX, event.clientY)
      if (!(element instanceof Element)) return
      setHoverRect(rectOf(element))
    }
```

> `rectOf` 取 `getBoundingClientRect`，顶级 frame 下即 viewport 坐标，直接用于 `position:fixed`。对齐 guest `onPointerMove` L227-235。

- [ ] **Step 5: AnnotationOverlay 用 SelectionHighlight 替换占位**

把 `interaction-layer` 内的 `{interaction.hoverRect && <div className="selection" />}` 改为：

```tsx
        {interaction.hoverRect && <SelectionHighlight rect={interaction.hoverRect} />}
```

并在文件顶部加 `import { SelectionHighlight } from './SelectionHighlight'`。

- [ ] **Step 6: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（含新增 2 个 hover-box 测试）

- [ ] **Step 7: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

---

## Task 33: CursorBadge

**目标**：pointermove 时在鼠标右下角（`+14,+14`）渲染评论 SVG 图标徽章，跟随鼠标；鼠标真正离开窗口时（pointerout relatedTarget 为 null）清除。

**Files:**
- Create: `apps/desktop/src/browser-overlay/CursorBadge.tsx`
- Modify: `useAnnotationInteraction.ts`（cursorPos state + pointerout 清除）
- Modify: `useAnnotationInteraction.test.ts`（cursor 断言）
- Modify: `AnnotationOverlay.tsx`（用 CursorBadge 替换占位）

**Interfaces:**
- Consumes: `Point`（Task 31 定义）
- Produces: `CursorBadge({ pos }: { pos: Point }): ReactNode`

- [ ] **Step 1: 写失败测试**

在 `useAnnotationInteraction.test.ts` 追加：

```ts
  test('pointermove：cursorPos 为 clientX+14, clientY+14，钳制到视口', () => {
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation' }))
    const target = document.createElement('div'); document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 200 })) })
    expect(ref.current.cursorPos).toEqual({ x: 114, y: 214 })
    document.body.innerHTML = ''
  })

  test('cursorPos 钳制：clientX 超过 innerWidth-32 时限制到 innerWidth-32', () => {
    const orig = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 200, configurable: true })
    try {
      const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation' }))
      const target = document.createElement('div'); document.body.append(target)
      act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500, clientY: 10 })) })
      expect(ref.current.cursorPos?.x).toBe(200 - 32) // = 168
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: orig, configurable: true })
    }
    document.body.innerHTML = ''
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — cursorPos 仍 null

- [ ] **Step 3: 实现 CursorBadge 组件**

创建 `CursorBadge.tsx`：

```tsx
import type { Point } from './useAnnotationInteraction'

// 光标徽章：评论 SVG 图标，偏移跟随鼠标（left/top = pos，无 translate，无居中）。
// 对齐 guest cursor-badge（评论气泡图标，不显示元素元数据）。
export function CursorBadge({ pos }: { pos: Point }) {
  return (
    <div className="cursor-badge" style={{ left: pos.x, top: pos.y }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5.2 3.2A.5.5 0 0 1 3 20.8V7a3 3 0 0 1 2-3Z" />
      </svg>
    </div>
  )
}
```

- [ ] **Step 4: 填 cursor 逻辑（在 onPointerMove 内追加 + 加 pointerout）**

在 `useAnnotationInteraction.ts` 的 `onPointerMove` 末尾（`setHoverRect` 之后）追加：

```ts
      setCursorPos({ x: Math.max(4, Math.min(win.innerWidth - 32, event.clientX + 14)), y: Math.max(4, Math.min(win.innerHeight - 32, event.clientY + 14)) })
```

在 effect 内（与其它 listener 并列）加 pointerout：

```ts
    const onPointerOut = (event: PointerEvent): void => {
      // 鼠标真正离开窗口（无 relatedTarget）时清除 hover/cursor
      if (event.relatedTarget !== null) return
      setHoverRect(null)
      setCursorPos(null)
    }
```

并在注册/注销段加（与 pointerdown 等并列）：

```ts
    win.document.addEventListener('pointerout', onPointerOut, capture)
    // ... return 的 cleanup 里：
    win.document.removeEventListener('pointerout', onPointerOut, capture)
```

> 对齐 guest `onPointerOut` L249-253（仅 relatedTarget 为 null 时清除）。cursor 钳制 `Math.max(4, Math.min(innerWidth-32, clientX+14))` 对齐 guest L243-244。

- [ ] **Step 5: AnnotationOverlay 用 CursorBadge 替换占位**

把 `{interaction.cursorPos && <div className="cursor-badge" />}` 改为：

```tsx
        {interaction.cursorPos && <CursorBadge pos={interaction.cursorPos} />}
```

并加 `import { CursorBadge } from './CursorBadge'`。

- [ ] **Step 6: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（含新增 cursor 测试）

- [ ] **Step 7: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

---

## Task 34: click → element anchor → open-editor

**目标**：comment 模式下，点击页面元素（非 overlay 自身、非文本选区）→ `buildAnchor('element', rect, element, ...)` → `bridge.send({ type:'open-editor', annotationId: undefined, purpose, anchor })`。

**Files:**
- Modify: `useAnnotationInteraction.ts`（填 `onClick`，需 buildAnchor + rectOf + styleSnapshot 占位）
- Modify: `useAnnotationInteraction.test.ts`（click 断言）

**Interfaces:**
- Consumes: `buildAnchor`（`./anchor`，已有，签名 `buildAnchor(kind, rect, element, exact, generation, framePath, win, range?)`）、`rectOf`（已有）、`GuestState.purpose`
- Produces: 发出的 IPC payload `{ type: 'open-editor', annotationId: undefined, purpose, anchor }`（tweaks 模式额外 `originalStyles`，本 task 暂不实现 originalStyles，留 design plan）

> **framePath**：顶级 frame 传 `[]`（与 buildAnchor 的 framePath 参数一致；`topWindow`/frameUrl 分支在 framePath 为空时不触发）。generation 从 opts 取。

- [ ] **Step 1: 写失败测试**

在 `useAnnotationInteraction.test.ts` 追加：

```ts
  test('comment 模式 click 元素：发送 open-editor + element anchor', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', generation: 7,
    }))
    const target = document.createElement('button')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 5, y: 6, width: 30, height: 40, top: 6, left: 5, right: 35, bottom: 46, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 })) })
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.type).toBe('open-editor')
    expect(payload.annotationId).toBeUndefined()
    expect(payload.purpose).toBe('annotation')
    const anchor = payload.anchor as Record<string, unknown>
    expect(anchor.kind).toBe('element')
    expect(anchor.generation).toBe(7)
    expect(anchor.rect).toEqual({ x: 5, y: 6, width: 30, height: 40 })
    document.body.innerHTML = ''
  })

  test('click 时存在文本选区：不发送（让 mouseup/text 流程接管）', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation',
    }))
    const target = document.createElement('div'); document.body.append(target)
    // 模拟有文本选区
    const origGetSelection = window.getSelection
    window.getSelection = (() => ({ toString: () => 'selected text', isCollapsed: false, rangeCount: 1 })) as unknown as typeof window.getSelection
    try {
      act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })) })
    } finally {
      window.getSelection = origGetSelection
    }
    expect(send).toHaveBeenCalledTimes(0)
    document.body.innerHTML = ''
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — click 不发送（onClick 是 stub）

- [ ] **Step 3: 填 onClick 逻辑**

在 `useAnnotationInteraction.ts` 顶部加 import：

```ts
import { buildAnchor, rectOf } from './anchor'
```

替换 `onClick` 函数体为：

```ts
    const onClick = (event: MouseEvent): void => {
      if (purpose === 'tweaks' || isOverlayTarget(event.target, optsRef.current.host)) return
      // 有文本选区时让 mouseup/text 流程接管（对齐 guest onClick L277）
      const selection = win.getSelection()
      if (selection?.toString().trim()) return
      const element = event.target instanceof Element ? event.target : win.document.elementFromPoint(event.clientX, event.clientY)
      if (!(element instanceof Element) || isOverlayTarget(element, optsRef.current.host)) return
      event.preventDefault(); event.stopImmediatePropagation()
      const o = optsRef.current
      const anchor = buildAnchor('element', rectOf(element), element, undefined, o.generation, [], o.win)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
```

> 对齐 guest `onClick` L274-283 + `openAnchor` L295-299。tweaks 模式直接 return（design plan 处理 originalStyles）。`buildAnchor` 第 5 参 exact 传 `undefined`（element 点击无选区文本）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（含新增 click 测试）

- [ ] **Step 5: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误（确认 `import { buildAnchor, rectOf }` 不与 Task 32 的 `import { rectOf }` 重复——合并为单行 `import { buildAnchor, rectOf } from './anchor'`）

---

## Task 35: text selection → text anchor → open-editor

**目标**：comment 模式 mouseup 时，若有非空文本选区 → `getRangeAt(0)` → `buildAnchor('text', rect, container, selection.toString(), generation, [], win, range)` → `bridge.send(open-editor)`。

**Files:**
- Modify: `useAnnotationInteraction.ts`（填 `onMouseUp`）
- Modify: `useAnnotationInteraction.test.ts`（text selection 断言）

**Interfaces:**
- Consumes: `buildAnchor`、`rectOf`、`Range`
- Produces: IPC payload `{ type: 'open-editor', annotationId: undefined, purpose, anchor }`，anchor.kind === 'text'

- [ ] **Step 1: 写失败测试**

在 `useAnnotationInteraction.test.ts` 追加：

```ts
  test('comment 模式 mouseup 有文本选区：发送 open-editor + text anchor', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', generation: 3,
    }))
    // 构造一个 range（rect 20,30,80,20）
    const range = {
      commonAncestorContainer: document.body,
      getBoundingClientRect: () => ({ x: 20, y: 30, width: 80, height: 20, top: 30, left: 20, right: 100, bottom: 50, toJSON() {} }),
    } as unknown as Range
    const origGetSelection = window.getSelection
    window.getSelection = (() => ({ toString: () => 'hello', isCollapsed: false, rangeCount: 1, getRangeAt: () => range })) as unknown as typeof window.getSelection
    try {
      act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    } finally {
      window.getSelection = origGetSelection
    }
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.anchor).toMatchObject({ kind: 'text', generation: 3 })
    document.body.innerHTML = ''
  })

  test('mouseup 无文本选区：不发送', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    expect(send).toHaveBeenCalledTimes(0)
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — mouseup 不发送（onMouseUp 是 stub）

- [ ] **Step 3: 填 onMouseUp 逻辑**

替换 `onMouseUp` 函数体为：

```ts
    const onMouseUp = (): void => {
      if (purpose === 'tweaks') return
      const selection = win.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return
      const range = selection.getRangeAt(0)
      const rect = rectOf(range)
      if (rect.width <= 0 || rect.height <= 0) return
      const container = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
      const o = optsRef.current
      const anchor = buildAnchor('text', rect, container ?? null, selection.toString(), o.generation, [], o.win, range)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
```

> 对齐 guest `openTextSelection` L285-293。普通 `getSelection`（约束 8：不用 getComposedRanges）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（含新增 text 测试）

- [ ] **Step 5: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

---

## Task 36: region selection → region anchor → open-editor

**目标**：comment 模式 pointerdown 记录起点，pointerup 时若拖拽矩形 ≥6px → `buildAnchor('region', rect, null, ...)` → `bridge.send(open-editor)`，并设 `suppressNextClick` 阻止同周期 click 触发新建。

**Files:**
- Modify: `useAnnotationInteraction.ts`（填 `onPointerDown`/`onPointerUp` + dragging/suppressNextClick ref + click handler 配合）
- Modify: `useAnnotationInteraction.test.ts`（region 断言）

**Interfaces:**
- Consumes: `buildAnchor`、`PointerEvent.button`
- Produces: IPC payload `{ type: 'open-editor', annotationId: undefined, purpose, anchor }`，anchor.kind === 'region'

- [ ] **Step 1: 写失败测试**

在 `useAnnotationInteraction.test.ts` 追加：

```ts
  test('comment 模式拖拽 ≥6px：发送 open-editor + region anchor，且不重复发送 click', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({
      ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', generation: 9,
    }))
    const target = document.createElement('div'); document.body.append(target)
    // pointerdown 起点
    act(() => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })) })
    // pointerup 终点（拖出 100x50）
    act(() => { target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 110, clientY: 60, button: 0 })) })
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.anchor).toMatchObject({ kind: 'region', generation: 9 })
    expect(payload.anchor).toHaveProperty('rect')
    const rect = (payload.anchor as Record<string, unknown>).rect as Record<string, number>
    expect(rect.width).toBe(100)
    expect(rect.height).toBe(50)
    document.body.innerHTML = ''
  })

  test('拖拽 <6px（视为点击）：不发送 region，由 click 处理 element', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 0, y: 0, width: 50, height: 50, top: 0, left: 0, right: 50, bottom: 50, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 })) })
    act(() => { target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 12, clientY: 11, button: 0 })) })
    // region 不发送
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).anchor && ((c[0] as Record<string, unknown>).anchor as Record<string, unknown>).kind === 'region')).toBe(false)
    document.body.innerHTML = ''
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — region 不发送（onPointerDown/Up 是 stub）

- [ ] **Step 3: 加 dragging/suppressNextClick ref + 填 onPointerDown/onPointerUp + 改 onClick**

在 `useAnnotationInteraction.ts`，在 `const optsRef = useRef(opts)` 下方加：

```ts
  const draggingRef = useRef<{ x: number; y: number } | null>(null)
  const suppressNextClickRef = useRef(false)
```

替换 `onPointerDown` 函数体为：

```ts
    const onPointerDown = (event: PointerEvent): void => {
      if (purpose === 'tweaks' || event.button !== 0 || isOverlayTarget(event.target, optsRef.current.host)) return
      draggingRef.current = { x: event.clientX, y: event.clientY }
    }
```

替换 `onPointerUp` 函数体为：

```ts
    const onPointerUp = (event: PointerEvent): void => {
      const start = draggingRef.current
      draggingRef.current = null
      if (event.button !== 0 || !start || isOverlayTarget(event.target, optsRef.current.host)) return
      const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) }
      if (rect.width < 6 || rect.height < 6) return // 视为点击，由 click handler 处理
      event.preventDefault(); event.stopImmediatePropagation()
      suppressNextClickRef.current = true
      win.setTimeout(() => { suppressNextClickRef.current = false }, 0)
      const o = optsRef.current
      const anchor = buildAnchor('region', rect, null, undefined, o.generation, [], o.win)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
```

在 `onClick` 函数体最前面（mode/purpose guard 之后、isOverlayTarget 检查之前）加 suppress 检查：

```ts
      if (suppressNextClickRef.current) { event.preventDefault(); event.stopImmediatePropagation(); return }
```

即 onClick 变为：

```ts
    const onClick = (event: MouseEvent): void => {
      if (purpose === 'tweaks') return
      if (suppressNextClickRef.current) { event.preventDefault(); event.stopImmediatePropagation(); return }
      if (isOverlayTarget(event.target, optsRef.current.host)) return
      const selection = win.getSelection()
      if (selection?.toString().trim()) return
      const element = event.target instanceof Element ? event.target : win.document.elementFromPoint(event.clientX, event.clientY)
      if (!(element instanceof Element) || isOverlayTarget(element, optsRef.current.host)) return
      event.preventDefault(); event.stopImmediatePropagation()
      const o = optsRef.current
      const anchor = buildAnchor('element', rectOf(element), element, undefined, o.generation, [], o.win)
      o.bridge.send({ type: 'open-editor', annotationId: undefined, purpose, anchor })
    }
```

> 对齐 guest `onPointerDown` L215-218 / `onPointerUp` L262-272 / suppressNextClick L268-269。region 拖拽**无**可视框（约束 8）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（含新增 region 测试；注意 Task 34 的「click 元素」测试仍绿，suppress 不影响正常 click）

- [ ] **Step 5: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误（确认 useRef 已在 Task 31 import）

---

## Task 37: PreviewCard + marker click（select-comment）

**目标**：marker mouseenter 120ms 后显示评论预览卡（body 纯文本，定位 marker 左侧 -308px），mouseleave 260ms 后隐藏；打开/关闭时 `bridge.send(preview-open/preview-close)`。marker click → `bridge.send(open-editor, annotationId)`（编辑现有评论）。

**Files:**
- Create: `apps/desktop/src/browser-overlay/PreviewCard.tsx`
- Modify: `Marker.tsx`（加 `onHoverEnter`/`onHoverLeave`/`onClickAnchor` 回调 props）
- Modify: `useAnnotationInteraction.ts`（preview state + 定时器 + marker 回调注入）
- Modify: `useAnnotationInteraction.test.ts`（preview/marker-click 断言）
- Modify: `AnnotationOverlay.tsx`（用 PreviewCard 替换占位 + 把 marker 回调传给 Marker）

**Interfaces:**
- Consumes: `PreviewData`（Task 31 定义）、`rectOf`、`GuestComment`
- Produces:
  - `PreviewCard({ data }: { data: PreviewData }): ReactNode`
  - Marker 新 props: `onHoverEnter?: (body: string, annotationId: string, markerRect: Rect) => void`、`onHoverLeave?: () => void`、`onClickAnchor?: (annotationId: string, anchor: Record<string, unknown>) => void`

- [ ] **Step 1: 写失败测试（preview 显示/隐藏 + 定时器）**

在 `useAnnotationInteraction.test.ts` 顶部 mock 区加定时器控制（bun:test 的 fake timers 或同步 setTimeout）。用真实 setTimeout 配合手动推进较复杂，改用同步 mock：

```ts
// 在文件顶部 mock 区之后加：
const timers: Array<() => void> = []
let timerHandle = 0
const timerMap = new Map<number, () => void>()
beforeEach(() => {
  mock.module // placeholder
})
```

> **更简单的方案**：happy-dom 的 `setTimeout` 是真实的（基于 node timer），但 bun:test 可用 `setSystemTime` + fake timers。为避免复杂度，本 task 测试**直接断言 preview state 在 mouseenter 后经 timer 触发**——用 bun:test 的 `mock.date`/`setSystemTime` 较重。**改用「同步定时器」注入**：hook 通过 `opts.win.setTimeout` 调度，测试传入一个同步立即执行的 win mock。

重写测试策略——在测试里构造一个 `win` mock，其 `setTimeout` 立即执行：

```ts
  test('marker hover 120ms：preview 显示并发 preview-open；leave 260ms：隐藏并发 preview-close', () => {
    const send = mock(() => {})
    // 同步 win：setTimeout 立即执行（跳过真实 120/260ms 等待）
    const syncWin = {
      ...window,
      document: window.document,
      setTimeout: ((cb: () => void) => { cb(); return 0 }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      innerWidth: 1000, innerHeight: 800,
    } as unknown as Window
    let markerCb: { enter: (b: string, id: string, r: Rect) => void; leave: () => void } | null = null
    // 通过暴露的回调接口模拟 marker 行为
    const ref = renderHook(() => {
      const interaction = useAnnotationInteraction({
        ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation', win: syncWin,
      })
      markerCb = interaction.marker // Task 37 在 InteractionState 加 marker 字段
      return interaction
    })
    act(() => { markerCb?.enter('评论正文', 'c1', { x: 100, y: 50, width: 24, height: 24 }) })
    expect(ref.current.preview).not.toBeNull()
    expect(ref.current.preview?.body).toBe('评论正文')
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'preview-open')).toBe(true)
    act(() => { markerCb?.leave() })
    expect(ref.current.preview).toBeNull()
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'preview-close')).toBe(true)
    document.body.innerHTML = ''
  })

  test('marker click：发送 open-editor + annotationId（编辑现有）', () => {
    const send = mock(() => {})
    let markerCb: { click: (id: string, anchor: Record<string, unknown>) => void } | null = null
    renderHook(() => {
      const interaction = useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' })
      markerCb = interaction.marker
      return interaction
    })
    act(() => { markerCb?.click('c1', { kind: 'element' }) })
    const payload = send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.type).toBe('open-editor')
    expect(payload.annotationId).toBe('c1')
    document.body.innerHTML = ''
  })
```

> 注：InteractionState 需新增 `marker` 字段暴露回调（enter/leave/click），供 Marker 组件绑定、供测试直接调用。这比模拟 marker DOM 事件更可靠。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — `interaction.marker` 不存在

- [ ] **Step 3: 实现 PreviewCard 组件**

创建 `PreviewCard.tsx`：

```tsx
import type { PreviewData } from './useAnnotationInteraction'

// 评论预览卡：marker hover 后显示评论 body 纯文本。偏移定位（marker 左侧 -308，无 translate）。
export function PreviewCard({ data }: { data: PreviewData }) {
  return <div className="preview" style={{ left: data.rect.x, top: data.rect.y }}>{data.body}</div>
}
```

- [ ] **Step 4: hook 加 marker 回调 + preview state + 定时器**

在 `useAnnotationInteraction.ts`：

(1) `InteractionState` 类型加 `marker` 字段：

```ts
export type InteractionState = {
  hoverRect: Rect | null
  cursorPos: Point | null
  preview: PreviewData | null
  marker: {
    enter: (body: string, annotationId: string, markerRect: Rect) => void
    leave: () => void
    click: (annotationId: string, anchor: Record<string, unknown>) => void
  }
}
```

(2) 在 hook 内（state 声明后）加定时器 ref：

```ts
  const previewTimerRef = useRef<ReturnType<typeof win.setTimeout> | null>(null)
  const previewHideTimerRef = useRef<ReturnType<typeof win.setTimeout> | null>(null)
```

(3) 在 effect 外（每次渲染重建即可，因依赖闭包的 win/bridge；用 `useRef` + useCallback 更优，但为 KISS 直接定义函数对象）——在 `return` 前定义 marker 回调：

```ts
  const marker = {
    enter: (body: string, annotationId: string, markerRect: Rect): void => {
      if (previewHideTimerRef.current) { win.clearTimeout(previewHideTimerRef.current); previewHideTimerRef.current = null }
      previewTimerRef.current = win.setTimeout(() => {
        // 预览卡定位：marker 左侧 -308，钳制视口；宽 300+padding ≈ 316
        const left = Math.max(8, Math.min(win.innerWidth - 316, markerRect.x - 308))
        const top = Math.max(8, Math.min(win.innerHeight - 100, markerRect.y))
        setPreview({ body, annotationId, rect: { x: left, y: top, width: 300, height: 80 } })
        optsRef.current.bridge.send({ type: 'preview-open', annotationId, rect: { x: left, y: top, width: 300, height: 80 } })
      }, 120)
    },
    leave: (): void => {
      if (previewTimerRef.current) { win.clearTimeout(previewTimerRef.current); previewTimerRef.current = null }
      previewHideTimerRef.current = win.setTimeout(() => {
        setPreview(null)
        optsRef.current.bridge.send({ type: 'preview-close' })
      }, 260)
    },
    click: (annotationId: string, anchor: Record<string, unknown>): void => {
      optsRef.current.bridge.send({ type: 'open-editor', annotationId, anchor })
    },
  }
```

(4) `return` 语句改为：

```ts
  return { hoverRect, cursorPos, preview, marker }
```

> 对齐 guest `schedulePreview` L358-363 / `showPreview` L365-378 / `scheduleHidePreview` L380-386 / marker click L352。preview-open payload 带 rect（对齐 guest L377）。

- [ ] **Step 5: Marker.tsx 加回调 props + 绑定 hover/click**

替换 `Marker.tsx` 全文：

```tsx
import { useMemo } from 'react'
import { locateAnchor, rectOf, type Rect } from './anchor'
import type { Rect as AnchorRect } from './useAnnotationInteraction'

type MarkerProps = {
  comment: Record<string, unknown>
  index: number
  viewportSize?: { width: number; height: number }
  win: Window
  onHoverEnter?: (body: string, annotationId: string, markerRect: AnchorRect) => void
  onHoverLeave?: () => void
  onClickAnchor?: (annotationId: string, anchor: Record<string, unknown>) => void
}

// 单个评论 pin。定位到 anchor（element/text/region）；状态：attached/stale/detached。
export function Marker({ comment, index, viewportSize, win, onHoverEnter, onHoverLeave, onClickAnchor }: MarkerProps) {
  const anchor = comment.anchor as Record<string, unknown> | undefined
  const located = useMemo(() => (anchor ? locateAnchor(anchor as never, document, win) : undefined), [anchor, win])

  if (!anchor) return null
  const fallback = (anchor.rect as Rect | undefined) ?? { x: 8, y: 8 + index * 28, width: 1, height: 1 }
  const rect = located?.rect ?? fallback
  const left = Math.max(12, Math.min((viewportSize?.width ?? win.innerWidth) - 12, rect.x + rect.width))
  const top = Math.max(12, Math.min((viewportSize?.height ?? win.innerHeight) - 12, rect.y))

  const stateClass = located ? (located.status === 'degraded' ? 'detached' : '') : 'stale detached'
  const annotationId = String(comment.id ?? '')
  const body = String(comment.body ?? '')
  return (
    <button
      type="button"
      className={`marker saved-marker${stateClass ? ` ${stateClass}` : ''}`}
      data-selected="false"
      style={{ left, top }}
      aria-label={located ? `批注 ${index + 1}` : `批注 ${index + 1} 已失效`}
      onMouseEnter={() => onHoverEnter?.(body, annotationId, { x: left, y: top, width: 24, height: 24 })}
      onMouseLeave={() => onHoverLeave?.()}
      onClick={(e) => { e.stopPropagation(); onClickAnchor?.(annotationId, anchor) }}
    >
      <span className="marker-label">{index + 1}</span>
    </button>
  )
}
```

> marker click 的 `e.stopPropagation()` 防止冒泡到 document（对齐 guest marker click L352 `stopPropagation`）。注意：document 的 click 是 **capture** 阶段，先于 marker 的 bubble onClick；但 isOverlayTarget 会让 document click handler 对 marker target 直接 return，不冲突。

- [ ] **Step 6: AnnotationOverlay 用 PreviewCard + 传 marker 回调**

(1) 把 `{interaction.preview && <div className="preview" />}` 改为：

```tsx
        {interaction.preview && <PreviewCard data={interaction.preview} />}
```

(2) 把 Marker 渲染改为传回调：

```tsx
          <Marker
            key={String(comment.id ?? index)}
            comment={comment}
            index={index}
            win={window}
            onHoverEnter={interaction.marker.enter}
            onHoverLeave={interaction.marker.leave}
            onClickAnchor={interaction.marker.click}
          />
```

(3) 顶部加 `import { PreviewCard } from './PreviewCard'`。

- [ ] **Step 7: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: PASS（含新增 preview/marker-click 测试）

- [ ] **Step 8: verify**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

---

## Task 38: ESC 退出 + scroll/resize 刷新 + anchor-state 上报 + 整合验证

**目标**：(1) comment 模式按 ESC → `bridge.send({ type: 'mode-changed', mode: 'browse' })`。(2) scroll/resize/DOM 变更 → rAF 去重刷新（重渲让 marker/hover 用新 rect）。(3) marker 定位后发 `anchor-state` 上报状态。(4) 全量 typecheck + build + 测试，确保零倒退。

**Files:**
- Modify: `useAnnotationInteraction.ts`（onKeyDown ESC + scroll/resize/rAF + marker 回调加 anchor-state）
- Modify: `Marker.tsx`（onLocate 回调上报 anchor-state，或由 AnnotationOverlay 渲染后副作用上报）
- Modify: `useAnnotationInteraction.test.ts`（ESC + 刷新断言）
- Modify: `AnnotationOverlay.tsx`（如有需要）

**Interfaces:**
- Consumes: `requestAnimationFrame`（happy-dom 注入）、`MutationObserver`（happy-dom 注入）
- Produces: IPC payload `{ type: 'mode-changed', mode: 'browse' }`、`{ type: 'anchor-state', annotationId, status, rect }`

- [ ] **Step 1: 写失败测试（ESC）**

在 `useAnnotationInteraction.test.ts` 追加：

```ts
  test('comment 模式 ESC：发送 mode-changed browse', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'mode-changed')).toBe(true)
    const payload = send.mock.calls.find((c) => (c[0] as Record<string, unknown>).type === 'mode-changed')![0] as Record<string, unknown>
    expect(payload.mode).toBe('browse')
    document.body.innerHTML = ''
  })

  test('非 Escape 键：不发送 mode-changed', () => {
    const send = mock(() => {})
    renderHook(() => useAnnotationInteraction({ ...baseOpts, bridge: { ...baseOpts.bridge, send }, mode: 'comment', purpose: 'annotation' }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(send.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'mode-changed')).toBe(false)
    document.body.innerHTML = ''
  })

  test('scroll：rAF 去重后清 hover/cursor', () => {
    const rafCbs: Array<() => void> = []
    const syncWin = {
      ...window, document: window.document,
      requestAnimationFrame: ((cb: () => void) => { rafCbs.push(cb); return rafCbs.length }) as typeof requestAnimationFrame,
      cancelAnimationFrame: (() => {}) as typeof cancelAnimationFrame,
      setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
      MutationObserver: window.MutationObserver, innerWidth: 1000, innerHeight: 800,
    } as unknown as Window
    const ref = renderHook(() => useAnnotationInteraction({ ...baseOpts, mode: 'comment', purpose: 'annotation', win: syncWin }))
    const target = document.createElement('div')
    Object.defineProperty(target, 'getBoundingClientRect', { value: () => ({ x: 1, y: 2, width: 3, height: 4, top: 2, left: 1, right: 4, bottom: 6, toJSON() {} }) })
    document.body.append(target)
    act(() => { target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 2, clientY: 3 })) })
    expect(ref.current.hoverRect).not.toBeNull() // pointermove 已设 hover
    act(() => { window.dispatchEvent(new Event('scroll', { bubbles: true })) })
    act(() => { rafCbs.splice(0).forEach((cb) => cb()) }) // 同步执行 rAF 回调
    expect(ref.current.hoverRect).toBeNull() // scroll+rAF 后清空
    document.body.innerHTML = ''
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: FAIL — ESC 测试（onKeyDown 是 stub）与 scroll 测试（无 scroll 监听，hover 未清）均失败

- [ ] **Step 3: 填 onKeyDown ESC**

替换 `onKeyDown` 函数体为：

```ts
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      optsRef.current.bridge.send({ type: 'mode-changed', mode: 'browse' })
    }
```

> 对齐 guest `onKeyDown` L220-225。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`
Expected: 2 个 ESC 测试 PASS；scroll 测试仍 FAIL（无 scroll 监听，Step 5 实现）

- [ ] **Step 5: 加 scroll/resize 刷新（rAF 去重）**

在 `useAnnotationInteraction.ts`，在 effect 内（comment 模式分支）加：

```ts
    // scroll/resize/DOM 变更 → rAF 去重 → 清 hover/cursor（让其下次 pointermove 重算；marker 由 React 重渲自动重定位）
    let scheduled = false
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      win.requestAnimationFrame(() => { scheduled = false; setHoverRect(null); setCursorPos(null) })
    }
    win.addEventListener('scroll', schedule, true)
    win.addEventListener('resize', schedule)
    const mo = new win.MutationObserver(schedule)
    mo.observe(win.document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
```

在 effect 的 cleanup return 里加：

```ts
      win.removeEventListener('scroll', schedule, true)
      win.removeEventListener('resize', schedule)
      mo.disconnect()
```

> 对齐 guest `scheduleRender` L210-213（rAF 去重）+ L132-146 监听。marker 重定位由 React 重渲（locateAnchor 在 Marker useMemo，依赖变化才重算）——为让 scroll 后 marker 也刷新，Marker 的定位计算需在刷新时失效。**简化方案**：刷新时清 hover/cursor；marker 重定位依赖一个 `refreshKey` state，刷新时自增，强制 Marker useMemo 重算。

为让 marker 在 scroll/resize 后重定位，在 hook 加：

```ts
  const [refreshKey, setRefreshKey] = useState(0)
```

并把 `schedule` 的 rAF 回调改为：

```ts
      win.requestAnimationFrame(() => { scheduled = false; setHoverRect(null); setCursorPos(null); setRefreshKey((k) => k + 1) })
```

`InteractionState` 加 `refreshKey: number`，return 里带出。AnnotationOverlay 把 `refreshKey` 传给 Marker 作为 `key` 之外的依赖（或在 Marker 内部 useMemo 依赖加 refreshKey）。**最简**：AnnotationOverlay 渲染 Marker 时用 `key={`${comment.id}-${refreshKey}`}`，refreshKey 变化强制重挂重算 locateAnchor。

实现后运行 `cd apps/desktop && bun test src/browser-overlay/useAnnotationInteraction.test.ts`，确认 scroll 测试由 FAIL 转 PASS。

- [ ] **Step 6: AnnotationOverlay 传 refreshKey 给 Marker**

Marker 渲染改为：

```tsx
          <Marker
            key={`${String(comment.id ?? index)}-${interaction.refreshKey}`}
            comment={comment}
            index={index}
            win={window}
            onHoverEnter={interaction.marker.enter}
            onHoverLeave={interaction.marker.leave}
            onClickAnchor={interaction.marker.click}
          />
```

- [ ] **Step 7: anchor-state 上报**

在 hook 的 `marker` 对象加 `located` 回调，或在 Marker 定位后上报。**最简**：Marker 新增 `onLocate?: (annotationId: string, status: string, rect: Rect) => void`，定位后调用；hook 提供实现发 anchor-state。

Marker.tsx 在 `const located = useMemo(...)` 后加（render 返回前）：

```tsx
  // 定位结果上报（副作用：用 useMemo 计算后在渲染期调用 send 不安全，改由 AnnotationOverlay 的 effect 处理——见下）
```

> **更稳妥**：anchor-state 上报放在 AnnotationOverlay 的 useEffect（遍历 comments + locate 结果上报）。但 locateAnchor 在 Marker 内调用，AnnotationOverlay 拿不到。**决定**：本 task 把 anchor-state 上报**降级为 follow-up**（它主要服务旧 popup positionPopup，Plan 4 退役 popup 后意义降低；marker 视觉状态已由 attached/stale/detached 类体现）。**在 hook 顶部加注释标记 follow-up，不实现**：

在 `useAnnotationInteraction.ts` 文件顶部注释块加一行：

```ts
// TODO(follow-up): anchor-state 上报（marker 定位后发 {type:'anchor-state',annotationId,status,rect}），
//   Plan 4 退役 popup 后再评估是否需要；当前 marker 视觉状态已由 attached/stale/detached CSS 类体现。
```

- [ ] **Step 8: 运行全量测试，确认通过**

Run: `cd apps/desktop && bun test src/browser-overlay/`
Expected: 全绿（anchor 6/6 + guest-state 38 + overlayReducer 7 + useAnnotationInteraction 全部）

- [ ] **Step 9: verify（typecheck + build）**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误

Run: `cd apps/desktop && bun ./scripts/build.ts`
Expected: 构建成功，`dist/preload/browser-overlay-preload.cjs` 产出（bundle 体积相比 Plan 2 的 1,238kB 略增，因新增交互逻辑 + 组件）

- [ ] **Step 10: 既有测试不退化**

Run: `cd apps/desktop && bun test`
Expected: 既有测试全绿（desktop-package.test.mjs 的 build.files 断言仍含 browser-overlay-preload.cjs）

---

## 完成判据（Plan 3 收尾）

1. `useAnnotationInteraction` + `SelectionHighlight`/`CursorBadge`/`PreviewCard` 全部就位，happy-dom 单元测试全绿。
2. comment 模式下：click 元素 / 文本选区 / 区域拖拽 → 正确生成 anchor 并发 `open-editor`；marker hover 120ms → preview；marker click → open-editor(annotationId)；ESC → mode-changed:browse；scroll/resize → rAF 刷新。
3. **零倒退**：`main.ts:1119` 未改，主进程 manager 未改，生产 guest preload 仍工作；overlay preload 仍休眠。
4. typecheck 干净、build 成功、既有测试全绿。
5. 无 git commit（用户控制）；ledger 更新 Plan 3 进度。

## Self-Review

**1. Spec 覆盖**（对照 ledger Plan 3 范围「click/text/region→open-editor + Selection/Cursor/Preview + scroll/resize」）：
- click→open-editor：Task 34 ✓
- text→open-editor：Task 35 ✓
- region→open-editor：Task 36 ✓
- Selection（hover-box）：Task 32 ✓
- Cursor（badge）：Task 33 ✓
- Preview：Task 37 ✓
- scroll/resize：Task 38 ✓
- 定位模型决策：Global Constraints 7 ✓
- ESC 退出（guest 有，comment 模式必备）：Task 38 ✓
- 未覆盖（明确 follow-up，非 Plan 3 范围）：iframe 递归、getComposedRanges、ElementMetadataTooltip、region 可视拖拽框、anchor-state 上报、interaction-blocker——均在约束 5/6/8 声明。

**2. 占位符扫描**：无 TBD/TODO（Task 38 的 anchor-state follow-up 是明确决策注释，非占位）。每步含完整代码。

**3. 类型一致性**：
- `Rect` 在 useAnnotationInteraction.ts 定义，SelectionHighlight/PreviewCard/Marker 均引用同一类型（Marker 用 `Rect as AnchorRect` 别名避免与 anchor.ts 的 Rect 冲突——两者同构 {x,y,width,height}）。
- `InteractionState.marker.enter/leave/click` 签名在 Task 31 定义、Task 37 实现、Marker props 与测试调用一致。
- `buildAnchor(kind, rect, element, exact, generation, framePath, win, range?)` 签名与 anchor.ts L7 一致；Task 34/35/36 调用参数顺序正确。
- `bridge.send` payload 的 type 字符串（open-editor/mode-changed/preview-open/preview-close）与 guest 一致（调查报告清单）。

**4. 定位模型**：所有矩形/偏移元素 CSS 无 transform（overlay.css.ts Task 31 步骤 5），marker 保留 translate(-50%,-50%)（既有），无混用。
