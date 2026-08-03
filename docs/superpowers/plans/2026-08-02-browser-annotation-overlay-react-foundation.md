# 浏览器注释 React Overlay 基建 — 实施计划（Plan 1/N）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lume desktop 引入 React overlay preload，使注释浮层（marker/高亮/编辑器）能在目标网页 Shadow DOM 内用 React 渲染（对齐 Codex 技术栈），并验证「React in preload」构建可行。

**Architecture:** 新增 `browser-overlay-preload.tsx`（CJS preload，内嵌 React 18）注入网页，挂载 closed Shadow DOM 容器，渲染 `AnnotationOverlay` React 树；`overlayReducer` 纯函数实现对齐 Codex `Ve()` 的编辑器状态机。本 plan 只交付骨架（hello-marker 渲染 + reducer），Marker/Editor/design 等组件迁移在后续 plan。

**Tech Stack:** Electron 42、Vite 6 lib mode（CJS preload）、React 18.3.1（对齐 apps/web）、TypeScript、bun:test。

**参考文档:**
- 设计：`docs/superpowers/specs/2026-08-02-browser-annotation-codex-parity-design.md`（§4.1 / 附录 A.2-A.3）
- Codex 实现：`docs/codex-browser-annotation-analysis.md`（§3.3 状态机 `Ve`、附录 A.2 CSS、A.3 marker 管线）

## Global Constraints

- React 版本固定 `react@18.3.1` + `react-dom@18.3.1` + `@types/react@^18.3.12` + `@types/react-dom@^18.3.1` + `@vitejs/plugin-react@^4.3.4`（与 `apps/web` 对齐，勿用 React 19）。
- preload 构建保持 Vite lib mode + `formats: ['cjs']` + `external: ['electron', /^node:/, ...builtinModules]`；React 不 external（需打包进 bundle）。
- 测试用 `bun:test`（**非 vitest**）；desktop 当前无 React DOM 测试基建，故纯逻辑用单测、渲染/挂载用构建验证 + 后续 e2e。
- **遵循用户全局偏好：不主动执行 git 提交**；每个任务以 Checkpoint 收尾，提交由用户控制。
- 注释语言：与现有 `browser-guest-preload.ts` 一致（中英混用，保持代码库风格）。
- 不改动现有 `browser-guest-preload.ts`（本 plan 只新增并行入口，退役在后续 plan）。

---

## File Structure

| 文件 | 职责 | 创建/修改 |
|---|---|---|
| `apps/desktop/package.json` | 加 react/react-dom/plugin-react 依赖 + builder files | 修改 |
| `apps/desktop/vite.config.ts` | preloadConfig 加 tsx entry + plugin-react | 修改 |
| `apps/desktop/tsconfig.json` | 启用 jsx react-jsx | 修改 |
| `apps/desktop/src/browser-overlay-preload.tsx` | preload 入口：Shadow DOM 挂载 + bootstrap mount + 渲染 React | 创建 |
| `apps/desktop/src/browser-overlay/overlayReducer.ts` | 编辑器状态机（对齐 Codex `Ve`） | 创建 |
| `apps/desktop/src/browser-overlay/overlayReducer.test.ts` | reducer 单测（bun:test） | 创建 |
| `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx` | overlay 根组件（骨架，渲染 markers-layer + hello marker） | 创建 |
| `apps/desktop/src/browser-overlay/overlay.css.ts` | Shadow DOM 内样式字符串（对齐 Codex CSS 类） | 创建 |

---

## Task 1: 引入 React 依赖与构建配置

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/vite.config.ts:30-50`
- Modify: `apps/desktop/tsconfig.json`

**Interfaces:**
- Produces: `browser-overlay-preload.cjs` 构建产物（后续任务消费）；React 可在 desktop preload 中 import。

- [ ] **Step 1: 加依赖到 `apps/desktop/package.json`**

把 `dependencies` 与 `devDependencies` 改为（在现有基础上追加 react 相关）：

```json
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "electron": "42.5.1",
    "electron-builder": "24.13.3",
    "electron-updater": "6.8.9",
    "typescript": "^5.9.3",
    "vite": "^6.3.0"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1"
  }
```

并在 `build.files` 数组里 `"dist/preload/browser-annotation-preload.cjs",` 之后追加一行：

```json
      "dist/preload/browser-overlay-preload.cjs",
```

- [ ] **Step 2: 安装依赖**

Run: `cd D:/workspace/projects/ai-projects/lume && pnpm install`
Expected: 安装成功，react/react-dom/plugin-react 就位（pnpm workspace 会链接）。

- [ ] **Step 3: 修改 `apps/desktop/vite.config.ts` 的 `preloadConfig`**

```ts
import react from '@vitejs/plugin-react'
// ... 顶部 import 不变

export const preloadConfig = defineConfig({
  plugins: [react()],
  build: {
    target: 'node22',
    outDir: resolve(desktopRoot, 'dist', 'preload'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        preload: resolve(desktopRoot, 'src', 'preload.ts'),
        'browser-auth-preload': resolve(desktopRoot, 'src', 'browser-auth-preload.ts'),
        'browser-guest-preload': resolve(desktopRoot, 'src', 'browser-guest-preload.ts'),
        'browser-annotation-preload': resolve(desktopRoot, 'src', 'browser-annotation-preload.ts'),
        'browser-overlay-preload': resolve(desktopRoot, 'src', 'browser-overlay-preload.tsx'),
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external,
    },
  },
})
```

> 注意：`plugin-react` 会处理 `.tsx` 的 JSX（automatic runtime，使用 `react/jsx-runtime`）。React/react-dom 不在 `external`，会被打包进每个 entry bundle（多 entry 下有重复，可接受）。

- [ ] **Step 4: 修改 `apps/desktop/tsconfig.json` 启用 JSX**

在 `compilerOptions` 中确保（若已有 `jsx` 则改为 `react-jsx`，无则追加）：

```json
    "jsx": "react-jsx",
    "types": ["react", "react-dom"]
```

> 若 `tsconfig.json` 有 `include` 限制，确认 `src/browser-overlay/**/*.tsx` 在覆盖范围内（通常 `src/**/*` 已覆盖）。

- [ ] **Step 5: 创建占位入口以验证构建**

创建 `apps/desktop/src/browser-overlay-preload.tsx`（最小内容，仅用于 Task 1 构建验证，Task 4 会替换）：

```tsx
// 占位入口：Task 4 替换为完整 Shadow DOM 挂载逻辑
console.log('[lume] browser-overlay-preload loaded')
export {}
```

- [ ] **Step 6: 验证构建**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bun ./scripts/build.ts`
Expected: 构建无错；`apps/desktop/dist/preload/browser-overlay-preload.cjs` 文件存在。

验证文件存在：`ls dist/preload/browser-overlay-preload.cjs` 应输出该文件。

- [ ] **Step 7: Checkpoint（用户控制提交）**

构建链路（react 依赖 + plugin-react + tsx entry + tsconfig jsx）打通，`browser-overlay-preload.cjs` 产出。**头号风险（React in preload 可行性）已验证。**

---

## Task 2: overlayReducer 纯函数状态机（对齐 Codex `Ve`）

**Files:**
- Create: `apps/desktop/src/browser-overlay/overlayReducer.ts`
- Test: `apps/desktop/src/browser-overlay/overlayReducer.test.ts`

**Interfaces:**
- Produces: `overlayReducer(prev, action)` 与类型 `OverlayEditorState` / `OverlayAction` / `OverlayTarget`（Task 4 的 `AnnotationOverlay` 消费）。

**参考**：Codex `comment-preload.js` 的 `Ve(prev, msg)` 状态机（设计文档附录 A.2 / spec §4.1）。

- [ ] **Step 1: 写失败测试 `overlayReducer.test.ts`**

```ts
import { test, expect } from 'bun:test'
import { overlayReducer, type OverlayEditorState } from './overlayReducer'

const idle: OverlayEditorState = { type: 'idle' }

test('create-comment-at-point 进入编辑态', () => {
  const next = overlayReducer(idle, { type: 'create-comment-at-point' })
  expect(next).toEqual({ type: 'editing', target: { mode: 'create' } })
})

test('select-comment 进入 edit 态并带 commentId', () => {
  const next = overlayReducer(idle, { type: 'select-comment', commentId: 'c1' })
  expect(next).toEqual({ type: 'editing', target: { mode: 'edit', commentId: 'c1' } })
})

test('open-design-editor-at-point 进入 design 态', () => {
  const next = overlayReducer(idle, { type: 'open-design-editor-at-point' })
  expect(next).toEqual({ type: 'editing', target: { mode: 'design' } })
})

test('restore-editor 在已编辑时保持当前态', () => {
  const editing: OverlayEditorState = { type: 'editing', target: { mode: 'edit', commentId: 'c1' } }
  const next = overlayReducer(editing, { type: 'restore-editor', target: { mode: 'create' } })
  expect(next).toBe(editing)
})

test('restore-editor 在 idle 时进入新编辑态', () => {
  const next = overlayReducer(idle, { type: 'restore-editor', target: { mode: 'create' } })
  expect(next).toEqual({ type: 'editing', target: { mode: 'create' } })
})

test('close-editor 回到 idle', () => {
  const editing: OverlayEditorState = { type: 'editing', target: { mode: 'create' } }
  expect(overlayReducer(editing, { type: 'close-editor' })).toEqual({ type: 'idle' })
})

test('sync / prepare-comment-screenshot / clear-comment-screenshot 透传不打断编辑', () => {
  const editing: OverlayEditorState = { type: 'editing', target: { mode: 'create' } }
  expect(overlayReducer(editing, { type: 'sync' })).toBe(editing)
  expect(overlayReducer(editing, { type: 'prepare-comment-screenshot', commentId: 'c1' })).toBe(editing)
  expect(overlayReducer(editing, { type: 'clear-comment-screenshot' })).toBe(editing)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bun test src/browser-overlay/overlayReducer.test.ts`
Expected: FAIL（模块不存在 / 导出缺失）。

- [ ] **Step 3: 实现 `overlayReducer.ts`**

```ts
// 编辑器状态机：对齐 Codex comment-preload 的 Ve(prev, msg)。
// 决定「当前活跃编辑器」：评论/设计编辑器开关 + 抗打断（sync/screenshot 透传）。

export type OverlayTarget =
  | { mode: 'create' }
  | { mode: 'edit'; commentId: string }
  | { mode: 'design'; groupId?: string }

export type OverlayEditorState =
  | { type: 'idle' }
  | { type: 'editing'; target: OverlayTarget }

export type OverlayAction =
  | { type: 'select-comment'; commentId: string }
  | { type: 'create-comment-at-point' }
  | { type: 'create-comment-from-selection' }
  | { type: 'open-design-editor-at-point' }
  | { type: 'restore-editor'; target: OverlayTarget }
  | { type: 'close-editor' }
  | { type: 'sync' }
  | { type: 'prepare-comment-screenshot'; commentId: string }
  | { type: 'clear-comment-screenshot' }

const editingActions = new Set<OverlayAction['type']>([
  'select-comment',
  'create-comment-at-point',
  'create-comment-from-selection',
  'open-design-editor-at-point',
])

function deriveTarget(action: OverlayAction): OverlayTarget {
  switch (action.type) {
    case 'select-comment':
      return { mode: 'edit', commentId: action.commentId }
    case 'open-design-editor-at-point':
      return { mode: 'design' }
    default:
      return { mode: 'create' }
  }
}

export function overlayReducer(prev: OverlayEditorState, action: OverlayAction): OverlayEditorState {
  if (editingActions.has(action.type)) {
    return { type: 'editing', target: deriveTarget(action) }
  }
  switch (action.type) {
    case 'restore-editor':
      // 已在编辑态则保持（抗打断），否则进入新编辑态
      return prev.type === 'editing' ? prev : { type: 'editing', target: action.target }
    case 'close-editor':
      return { type: 'idle' }
    case 'sync':
    case 'prepare-comment-screenshot':
    case 'clear-comment-screenshot':
      return prev
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bun test src/browser-overlay/overlayReducer.test.ts`
Expected: PASS（7 个测试全绿）。

- [ ] **Step 5: Checkpoint**

reducer 状态机（对齐 Codex `Ve`）完成且有单测覆盖。

---

## Task 3: Shadow DOM 内样式（对齐 Codex CSS 类）

**Files:**
- Create: `apps/desktop/src/browser-overlay/overlay.css.ts`

**Interfaces:**
- Produces: `overlayStyles` 字符串常量（Task 4 注入 Shadow DOM `<style>`）。

**参考**：Codex `comment-preload.js` line 98-119 的 CSS（设计文档附录 A.2）。本 plan 只迁移基础类（markers-layer / marker / saved-marker / marker-label / data-selected），其余类（interaction-layer/highlight/editor 等）在后续 plan 补。

- [ ] **Step 1: 创建 `overlay.css.ts`**

```ts
// overlay Shadow DOM 内样式（对齐 Codex comment-preload CSS）。
// 主色 #128dff；marker pin 编号样式；后续 plan 补 interaction-layer/highlight/editor 等。
export const overlayStyles = `
:host{all:initial;--annotation-accent:#128dff;--browser-sidebar-saved-marker-size:24px;--browser-sidebar-draft-marker-size:24px;--browser-sidebar-marker-label-offset:0px}
*{box-sizing:border-box}
.markers-layer{position:fixed;inset:0;z-index:1;pointer-events:none;font:12px system-ui,-apple-system,sans-serif;color:#fff}
.marker{position:fixed;transform:translate(-50%,-50%);pointer-events:auto;width:var(--browser-sidebar-saved-marker-size);height:var(--browser-sidebar-saved-marker-size);border-radius:999px;border:2px solid #fff;background:var(--annotation-accent);color:#fff;box-shadow:0 3px 12px #0006;display:flex;align-items:center;justify-content:center;font-weight:700;cursor:pointer}
.marker[data-selected="true"]{transform:translate(-50%,-50%) scale(1.08)}
.marker-label{color:#fff;font-weight:700}
.saved-marker{width:var(--browser-sidebar-saved-marker-size);height:var(--browser-sidebar-saved-marker-size)}
.draft-marker{width:var(--browser-sidebar-draft-marker-size);height:var(--browser-sidebar-draft-marker-size);border-style:dashed}
`
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误（纯字符串常量）。

- [ ] **Step 3: Checkpoint**

overlay 样式常量就位，颜色/尺寸变量对齐 Codex。

---

## Task 4: AnnotationOverlay 组件骨架

**Files:**
- Create: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`

**Interfaces:**
- Consumes: `overlayReducer` / `OverlayEditorState`（Task 2）、`overlayStyles`（Task 3）
- Produces: `AnnotationOverlay` 默认导出组件（Task 5 的 preload 挂载消费）。骨架只渲染 markers-layer + 一个 hello marker；后续 plan 接 sync/comments。

- [ ] **Step 1: 创建 `AnnotationOverlay.tsx`**

```tsx
import { useReducer } from 'react'
import { overlayReducer, type OverlayEditorState } from './overlayReducer'

// overlay 根组件骨架。本 plan 仅渲染 markers-layer + hello marker，
// 验证 React + Shadow DOM 渲染链路。后续 plan 接 sync 消息渲染真实 comments。
export function AnnotationOverlay() {
  const [state] = useReducer(overlayReducer, { type: 'idle' } as OverlayEditorState)
  void state // 后续 plan 用 state 渲染 EditorCard
  return (
    <>
      <style>{overlayStylesFallback}</style>
      <div className="markers-layer">
        {/* hello marker：证明 React 渲染到 Shadow DOM 成功；后续 plan 替换为真实 Marker 列表 */}
        <button type="button" className="marker saved-marker" data-selected="false" style={{ left: 120, top: 120 }}>
          <span className="marker-label">1</span>
        </button>
      </div>
    </>
  )
}

// 样式由 Task 3 的 overlayStyles 提供；preload 已把 overlayStyles 注入 Shadow DOM <style>，
// 组件内此 fallback 仅作冗余保险（Shadow DOM 内 <style> 已覆盖）。
const overlayStylesFallback = ''
```

> 说明：Shadow DOM 的 `<style>` 由 preload（Task 5）注入 `overlayStyles`，组件本身不重复注入，保持单源。`overlayStylesFallback` 留空，避免组件在没有 Shadow DOM style 时裸奔——实际场景下 preload 必注入。

- [ ] **Step 2: 验证类型检查**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 3: Checkpoint**

AnnotationOverlay 骨架就位（reducer 接入 + markers-layer + hello marker）。

---

## Task 5: browser-overlay-preload.tsx 挂载 Shadow DOM + bootstrap

**Files:**
- Create: `apps/desktop/src/browser-overlay-preload.tsx`（覆盖 Task 1 占位）

**Interfaces:**
- Consumes: `AnnotationOverlay`（Task 4）、`overlayStyles`（Task 3）
- Produces: 一个可被 Electron `webPreferences.preload` 引用的 CJS preload，注入网页后挂载 closed Shadow DOM 并渲染 React overlay。

**参考**：现有 `browser-guest-preload.ts` 的 bootstrap mount（`about:blank#lume-browser-mount=` → `lume:browser-guest-mounted`）需迁移过来；本 plan 不删 guest-preload（并行存在，退役在后续 plan）。

- [ ] **Step 1: 实现 `browser-overlay-preload.tsx`**

```tsx
import { createRoot } from 'react-dom/client'
import { ipcRenderer } from 'electron'
import { AnnotationOverlay } from './browser-overlay/AnnotationOverlay'
import { overlayStyles } from './browser-overlay/overlay.css'

// bootstrap mount：迁移自 browser-guest-preload（iframe 挂载点通知主进程）。
const bootstrapUrl = window.location.href
if (bootstrapUrl.startsWith('about:blank#lume-browser-mount=')) {
  ipcRenderer.send('lume:browser-guest-mounted', bootstrapUrl)
}

function start(): void {
  // 已挂载则跳过（防止重复注入）
  if (document.querySelector('div[data-lume-annotation-overlay]')) return

  const host = document.createElement('div')
  host.setAttribute('data-lume-annotation-overlay', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;'
  const shadow = host.attachShadow({ mode: 'closed' })

  // 注入 Shadow DOM 样式（对齐 Codex comment-preload 的 <style> 注入）
  const style = document.createElement('style')
  style.textContent = overlayStyles
  shadow.append(style)

  document.documentElement.append(host)
  createRoot(shadow).render(<AnnotationOverlay />)
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}

// 注：本 plan 不接 sync IPC（render hello marker 即可）；Task 后续 plan 接
// ipcRenderer.on('lume:browser-annotation-guest', ...) 驱动 reducer 渲染真实 comments。
export {}
```

- [ ] **Step 2: 验证类型检查**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bunx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [ ] **Step 3: 重新构建**

Run: `cd D:/workspace/projects/ai-projects/lume/apps/desktop && bun ./scripts/build.ts`
Expected: 构建无错；`dist/preload/browser-overlay-preload.cjs` 存在。

- [ ] **Step 4: 冒烟检查清单（手动 / 后续 e2e 自动化）**

构建产物存在后，按以下清单人工验证（在能跑 desktop dev 的环境）：
1. 把某浏览器 tab 的 `webPreferences.preload` 临时指向 `browser-overlay-preload.cjs`（具体接入在后续 plan；本 plan 可临时在 dev 注入测试页）。
2. 加载任意网页，确认：
   - 控制台无 React/Shadow DOM 错误
   - 页面左上（120,120）出现蓝色编号「1」marker pin（24px 圆，白描边，居中到 left/top）
   - 网页本身交互不受影响（overlay 容器 pointer-events:none）
3. 检查 DOM：`document.querySelector('[data-lume-annotation-overlay]').shadowRoot` 为 null（closed），宿主页面看不到 shadow 内部。

> 若无法人工跑 desktop，此步可推迟到后续 plan 的 e2e（`scripts/browser-runtime.e2e.mjs` 扩展）。本 plan 以「构建通过 + 类型检查通过 + reducer 单测通过」为最低验收。

- [ ] **Step 5: Checkpoint（Plan 1 完成）**

React overlay preload 链路打通：React 18 进 desktop → Vite lib mode 打包 tsx → preload 注入网页 → closed Shadow DOM → React 渲染 markers-layer + hello marker。`overlayReducer` 状态机（对齐 Codex `Ve`）有单测覆盖。

---

## Self-Review（plan 自审记录）

**1. Spec 覆盖**：本 plan 覆盖 spec §11 阶段 1（基建）+ 阶段 2 的骨架起点（reducer + overlay 容器 + hello marker）。阶段 2 的完整 Marker/Selection/Cursor/Preview 迁移、EditorCard、主进程 manager 接入、e2e 在后续 plan。**有意缩小范围以先验证头号风险**（spec §10 风险 1：React in preload 可行性）。

**2. 占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。Task 4 的 `overlayStylesFallback` 为空字符串是有意的（样式由 preload Shadow DOM style 注入，组件不重复），非占位。

**3. 类型一致性**：`OverlayEditorState` / `OverlayAction` / `OverlayTarget` 在 Task 2 定义、Task 4 消费，命名一致。`overlayReducer` 签名 ` (prev, action) => next` 一致。`AnnotationOverlay` 默认导出 vs 具名——Task 4 用 `export function AnnotationOverlay`，Task 5 用 `import { AnnotationOverlay }`，一致。

**4. 范围**：本 plan 产出可独立验证的最小单元（构建 + reducer 单测 + hello marker 渲染），符合「自包含可测试」。

**未覆盖（留给后续 plan）**：
- sync IPC 接入 + 真实 comments → Marker 列表渲染
- SelectionHighlight / CursorBadge / TextSelectionHighlight / PreviewCard 迁移
- EditorCard（替代 BrowserWindow）+ 主进程 manager 改造（移除 popup）
- 修饰键多选 / 元素元数据 tooltip / getComposedRanges / exit-comment-mode
- design-editor / Web MCP 注入侧 / 截图 cropRect / 宿主面板对齐
- browser-guest-preload 退役 + 全量回归
