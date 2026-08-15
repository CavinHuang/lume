# 右侧文件面板预览 Tab 实施计划（issue #55）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件树单击打开 VS Code 式"预览 tab"（斜体、可切换、双击/编辑固定为正式 tab），取代 temporaryPreviewTarget 隐式预览与窄模式 singleClickOpen 直接开 tab 的割裂行为。

**Architecture:** 全部基建已存在（`RightPanelTabBar` 支持 file tabs、`openFileTab` 带去重、树行已支持 `event.detail===2` 双击打开）。新增 `previewTab` 单槽状态（不持久化）+ `file-preview` activeItem 变体，三入口（树双击/预览 tab 双击/编辑）固定 = 复用 `openFileTab`。

**Tech Stack:** React 18.3 + jotai + Tailwind + bun:test（happy-dom 组件测试）。

**Spec:** `docs/superpowers/specs/2026-08-15-right-panel-preview-tab-design.md`

## Global Constraints

- 仓库用 **bun**（非 pnpm）；测试 `bun test <path>`；typecheck `bun run --filter @lume/web typecheck`
- 所有工作在 worktree `D:/workspace/projects/ai-projects/lume/.claude/worktrees/fix-right-panel-resize`（分支 `fix-right-panel-resize`，spec 已在同分支）
- Task 1-3 为**增量改动**（不删 `temporaryPreviewTarget`），保证每个 task 独立编译绿；Task 4 才统一删除旧字段
- 组件测试参照 `RightPanelTabBar.test.ts` 现有模式；状态测试参照 `right-panel-files-state.test.ts`（顶部 `const ref = (relativePath, source='session', scopeId='scope-1') => ({source, scopeId, relativePath})` 工厂）
- commit 信息用 emoji 前缀（✨/🧪/🔥 等），结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`

---

### Task 1: 状态层 — previewTab 字段与三个转换函数

**Files:**
- Modify: `apps/web/src/components/right-panel/right-panel-files-state.ts`
- Test: `apps/web/src/components/right-panel/right-panel-files-state.test.ts`

**Interfaces:**
- Consumes: 现有 `openFileTab(state, input, options)`（:101）、`normalizeRightPanelFileTarget`、`rightPanelFileTargetKey`、`normalizeLineSelection`、`RightPanelFileTab`
- Produces（后续 task 依赖，签名精确）:
  - `ThreadFileWorkspace.previewTab: RightPanelFileTab | null`（新字段，初始 null）
  - `previewFileTab(state: ThreadFileWorkspace, input: RightPanelFileTarget | FileRef, options?: FileRefIdentityOptions & { lineSelection?: ThreadFileLineSelection }): ThreadFileWorkspace`
  - `pinPreviewFileTab(state: ThreadFileWorkspace, options?: FileRefIdentityOptions): ThreadFileWorkspace`
  - `clearPreviewFileTab(state: ThreadFileWorkspace): ThreadFileWorkspace`
  - `RightPanelActiveItem` 新变体 `{ kind: 'file-preview' }`

- [ ] **Step 1: 写失败测试**

在 `right-panel-files-state.test.ts` 的 import 列表加入 `previewFileTab, pinPreviewFileTab, clearPreviewFileTab`，文件末尾追加：

```ts
describe('preview tab 状态转换', () => {
  const binding = { fileContextId: 'ctx-1' }
  const base = () => createThreadFileWorkspace(binding)

  test('previewFileTab 设置预览并激活 file-preview', () => {
    const next = previewFileTab(base(), ref('a.ts'))
    expect(next.previewTab?.target).toEqual({ kind: 'file', ref: ref('a.ts') })
    expect(next.activeItem).toEqual({ kind: 'file-preview' })
    expect(next.openTabs).toEqual([])
  })

  test('previewFileTab 替换为不同文件（单槽）', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    state = previewFileTab(state, ref('b.ts'))
    expect(next_target(state)).toBe('b.ts')
  })

  test('previewFileTab 同文件重复点击只刷新 navigationRevision', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    const firstRevision = state.previewTab!.navigationRevision
    state = previewFileTab(state, ref('a.ts'))
    expect(state.previewTab!.navigationRevision).toBe(firstRevision + 1)
    expect(state.previewTab?.id).toMatch(/^preview:/)
  })

  test('pinPreviewFileTab 原地转正并清空预览', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    state = pinPreviewFileTab(state)
    expect(state.previewTab).toBeNull()
    expect(state.openTabs).toHaveLength(1)
    expect(state.openTabs[0]!.id).toMatch(/^file:/)
    expect(state.activeItem).toEqual({ kind: 'file', tabId: state.openTabs[0]!.id })
  })

  test('pinPreviewFileTab 对已打开文件去重（激活既有 tab）', () => {
    let state = openFileTab(base(), ref('a.ts'))
    const openTabId = state.openTabs[0]!.id
    state = previewFileTab(state, ref('a.ts'))
    state = pinPreviewFileTab(state)
    expect(state.openTabs).toHaveLength(1)
    expect(state.activeItem).toEqual({ kind: 'file', tabId: openTabId })
  })

  test('pinPreviewFileTab 无预览时原样返回', () => {
    const state = base()
    expect(pinPreviewFileTab(state)).toBe(state)
  })

  test('clearPreviewFileTab 清预览并回退 activeItem 到最后一个正式 tab', () => {
    let state = openFileTab(base(), ref('a.ts'))
    const tabId = state.openTabs[0]!.id
    state = previewFileTab(state, ref('b.ts'))
    state = clearPreviewFileTab(state)
    expect(state.previewTab).toBeNull()
    expect(state.activeItem).toEqual({ kind: 'file', tabId })
  })

  test('clearPreviewFileTab 无正式 tab 时回退 files 功能视图', () => {
    let state = previewFileTab(base(), ref('a.ts'))
    state = clearPreviewFileTab(state)
    expect(state.activeItem).toEqual({ kind: 'function', type: 'files' })
  })
})

function next_target(state: ReturnType<typeof createThreadFileWorkspace>): string {
  const tab = state.previewTab
  if (!tab || tab.target.kind === 'mcp-resource') return ''
  return tab.target.ref.relativePath
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/components/right-panel/right-panel-files-state.test.ts`
Expected: FAIL（`previewFileTab` 等未导出 / `previewTab` 属性不存在）

- [ ] **Step 3: 实现**

`right-panel-files-state.ts` 三处修改：

(a) `RightPanelActiveItem`（:5-8）加变体：

```ts
export type RightPanelActiveItem =
  | { kind: 'function'; type: RightPanelFunction }
  | { kind: 'file'; tabId: string }
  | { kind: 'file-preview' }
  | { kind: 'browser'; tabId: string }
```

(b) `ThreadFileWorkspace`（:45 `temporaryPreviewTarget` 行后）加字段；`createThreadFileWorkspace`（:87 同位置）加 `previewTab: null,`

(c) `openFileTab` 函数（:135 附近，`openFileTab` 结束后）追加三个函数：

```ts
/** 单击预览：单槽替换式预览 tab（VS Code 预览语义），同文件重复点击只刷新 navigationRevision */
export function previewFileTab(
  state: ThreadFileWorkspace,
  input: RightPanelFileTarget | FileRef,
  options: FileRefIdentityOptions & { lineSelection?: ThreadFileLineSelection } = {},
): ThreadFileWorkspace {
  const target = normalizeRightPanelFileTarget(input)
  const lineSelection = normalizeLineSelection(options.lineSelection)
  const key = rightPanelFileTargetKey(target, options)
  if (state.previewTab && rightPanelFileTargetKey(state.previewTab.target, options) === key) {
    return {
      ...state,
      previewTab: { ...state.previewTab, lineSelection, navigationRevision: state.previewTab.navigationRevision + 1 },
      activeItem: { kind: 'file-preview' },
    }
  }
  const normalized = normalizeRightPanelFileTarget(target)
  const base = { id: `preview:${encodeURIComponent(key)}`, lineSelection, navigationRevision: 1 }
  const previewTab: RightPanelFileTab = normalized.kind === 'mcp-resource'
    ? { ...base, target: normalized }
    : { ...base, target: normalized, ref: normalized.ref }
  return { ...state, previewTab, activeItem: { kind: 'file-preview' } }
}

/** 固定预览：转正为正式 tab（复用 openFileTab 的同文件去重），随后清空预览槽 */
export function pinPreviewFileTab(
  state: ThreadFileWorkspace,
  options: FileRefIdentityOptions = {},
): ThreadFileWorkspace {
  if (!state.previewTab) return state
  const pinned = openFileTab({ ...state, previewTab: null }, state.previewTab.target, {
    ...options,
    lineSelection: state.previewTab.lineSelection,
    navigationRevision: state.previewTab.navigationRevision,
  })
  return { ...pinned, previewTab: null }
}

/** 清除预览：activeItem 回退到最后一个正式 tab，无则回退 files 功能视图 */
export function clearPreviewFileTab(state: ThreadFileWorkspace): ThreadFileWorkspace {
  if (!state.previewTab) return state
  const fallback = state.activeItem?.kind === 'file-preview'
    ? state.openTabs.length > 0
      ? { kind: 'file' as const, tabId: state.openTabs[state.openTabs.length - 1]!.id }
      : { kind: 'function' as const, type: 'files' as const }
    : state.activeItem
  return { ...state, previewTab: null, activeItem: fallback }
}
```

(d) 同文件 `rewriteFileRefPrefix`（:276）与 `removeFileRef`（:294）的返回对象中，紧挨现有 `temporaryPreviewTarget` 处理各加一行（重命名/移除命中预览文件时直接清预览，语义：预览失效需重点）：

```ts
// rewriteFileRefPrefix 返回对象中追加（与 temporaryPreviewTarget 同级）：
previewTab: state.previewTab?.ref && state.previewTab.ref.source === from.source && state.previewTab.ref.relativePath.startsWith(from.relativePath)
  ? null
  : state.previewTab,
// removeFileRef 返回对象中追加（同位置）：
previewTab: state.previewTab?.ref && state.previewTab.ref.source === ref.source && state.previewTab.ref.relativePath === ref.relativePath
  ? null
  : state.previewTab,
```

（注意：两个函数内的 `from`/`ref` 参数名以其函数签名为准，实现时对照 :276/:294 原文；命中判断模仿函数内已有的 temporaryPreviewTarget/selectedRef 分支写法。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/components/right-panel/right-panel-files-state.test.ts`
Expected: PASS（新 describe 全绿 + 原有测试不回归）

- [ ] **Step 5: typecheck + 提交**

```bash
bun run --filter @lume/web typecheck
git add apps/web/src/components/right-panel/right-panel-files-state.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts
git commit -m "✨ feat(web): 文件面板预览 tab 状态层(previewTab/固定/清除)"
```

---

### Task 2: TabBar — 预览项渲染与交互

**Files:**
- Modify: `apps/web/src/components/right-panel/RightPanelTabBar.tsx`
- Test: `apps/web/src/components/right-panel/RightPanelTabBar.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RightPanelFileTab`/`file-preview` 变体；现有 `buildRightPanelTabItems`（:50）、`disambiguateFileTabLabels`、`getRightPanelCloseFallback`、chip 渲染（:154-230）
- Produces:
  - `RightPanelTabItem` 新变体 `{ kind: 'file-preview'; id: string; tab: RightPanelFileTab; label: string }`
  - `buildRightPanelTabItems(workspace, fileTabs, reviewOpen, browserTabs = [], previewTab: RightPanelFileTab | null = null)`（第 5 参）
  - `RightPanelTabBarProps` 新增：`previewTab?: RightPanelFileTab | null`、`onActivatePreview?: () => void`、`onPinPreview?: () => void`、`onClosePreview?: () => void`

- [ ] **Step 1: 写失败测试**

`RightPanelTabBar.test.ts`（沿用现有 render+断言模式；若该文件用 react测试工具照抄其头部 import）追加：

```ts
test('预览 tab 渲染为斜体项且可激活/关闭/双击固定', () => {
  const fileTab = makeFileTab('file:session%2Fscope-1%2Fa.ts', 'a.ts') // 复用文件内既有 tab 工厂；无则内联构造
  const previewTab = { ...fileTab, id: 'preview:session%2Fscope-1%2Fb.ts' }
  const onActivatePreview = mock()
  const onPinPreview = mock()
  const onClosePreview = mock()
  const { container } = renderTabBar({
    fileTabs: [fileTab],
    previewTab,
    activeItem: { kind: 'file-preview' },
    onActivatePreview, onPinPreview, onClosePreview,
  })
  const chips = container.querySelectorAll('[role="tab"], [title*="b.ts"]')
  // 预览项存在且 label 斜体
  const previewChip = [...container.querySelectorAll('span')].find(el => el.textContent === 'b.ts')
  expect(previewChip?.className).toContain('italic')
  // 激活
  ;(previewChip?.closest('button') as HTMLElement)?.click()
  expect(onActivatePreview).toHaveBeenCalled()
})
```

（实现时以该测试文件既有的 render 辅助/mock 方式为准替换 `renderTabBar`/`makeFileTab`/`mock`——先读文件头部现有测试怎么渲染与断言，照抄模式。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/components/right-panel/RightPanelTabBar.test.ts`
Expected: FAIL（无 previewTab prop / 无斜体项）

- [ ] **Step 3: 实现**

`RightPanelTabBar.tsx`：

(a) `RightPanelTabItem`（:37-42）加变体（file 之后）：

```ts
  | { kind: 'file-preview'; id: string; tab: RightPanelFileTab; label: string }
```

(b) `buildRightPanelTabItems`（:50）签名加第 5 参 `previewTab: RightPanelFileTab | null = null`；:56 labels 行改为含预览（保持正式 tab 标签消歧一致）：

```ts
const labels = disambiguateFileTabLabels(previewTab ? [...fileTabs, previewTab] : fileTabs)
```

:66-68 的 `if (!workspace.tabs.files)` 块内、`result.push(...fileTabs...)` 之后追加：

```ts
if (previewTab) result.push({ kind: 'file-preview', id: previewTab.id, tab: previewTab, label: labels[previewTab.id]! })
```

(c) Props（:100 前后）加：

```ts
  previewTab?: RightPanelFileTab | null
  onActivatePreview?: () => void
  onPinPreview?: () => void
  onClosePreview?: () => void
```

(d) 组件体：
- :107 items memo 参数列表加 `props.previewTab`
- `isActive`（:119-125）末尾 file 分支前插：

```ts
      : item.kind === 'file-preview'
        ? !props.reviewActive && props.activeItem?.kind === 'file-preview'
```

- `activate`（:127-133）对应插 `: item.kind === 'file-preview' ? props.onActivatePreview?.()`
- `close`（:135-142）插 `else if (item.kind === 'file-preview') props.onClosePreview?.()`（放在 browser 分支后、`else props.onCloseFile` 前）
- chip 渲染（:154 `items.map` 内）：`title` 计算（:157-163）与图标（:199-205）对 `file-preview` 复用 `file` 分支——在这两处三元里把 `item.kind === 'file'` 条件改为 `item.kind === 'file' || item.kind === 'file-preview'`（TypeScript 下用 `item.tab` 访问需两变体都命中）
- label span（:206）加斜体（仅预览）：

```tsx
<span className={cn('min-w-0 flex-1 truncate text-left', item.kind === 'file-preview' && 'italic')}>{item.label}</span>
```

- 外层 div（:165 起）加双击固定（放在 `onMouseDown` 之后）：

```tsx
onDoubleClick={() => { if (item.kind === 'file-preview') props.onPinPreview?.() }}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/components/right-panel/RightPanelTabBar.test.ts`
Expected: PASS（新测试绿 + 既有不回归）

- [ ] **Step 5: typecheck + 提交**

```bash
bun run --filter @lume/web typecheck
git add apps/web/src/components/right-panel/RightPanelTabBar.tsx apps/web/src/components/right-panel/RightPanelTabBar.test.ts
git commit -m "✨ feat(web): TabBar 预览 tab 项(斜体/激活/关闭/双击固定)"
```

---

### Task 3: 入口接线 — 树单击预览、面板渲染、父层 handlers

**Files:**
- Modify: `apps/web/src/components/right-panel/UnifiedFileTree.tsx`（select :346、MCP 区 onClick :630、props :72/:82/:506）
- Modify: `apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx`（:57-60、:90、:135、:149-162）
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`（TabBar 接线 :597-629）

**Interfaces:**
- Consumes: Task 1 `previewFileTab`/`clearPreviewFileTab`；Task 2 props；现有 `updateRuntime`（RightPanelWorkspace :616 模式）、`onOpenFile`（Files 面板 prop）
- Produces: 完整交互链——单击预览 / 双击固定（树行 `event.detail===2` 已有）/ 编辑固定（`onEditStart`）

- [ ] **Step 1: UnifiedFileTree — 单击改走 previewFileTab**

(a) `select`（:346-355）替换（目录行为不变）：

```ts
const select = (ref: FileRef) => {
  const entry = findCachedEntry(cacheRef.current, ref)
  commitWorkspace(entry?.isDirectory
    ? { ...workspaceRef.current, selectedRef: ref }
    : previewFileTab({ ...workspaceRef.current, selectedRef: ref }, ref))
}
```

（顶部 import 加 `previewFileTab`。）

(b) MCP resource 区 onClick（:630-633）同理：`temporaryPreviewTarget: target` 行改为 `previewFileTab({ ...workspaceRef.current, selectedRef: null }, target)` 的返回值——即整个 commitWorkspace 参数换成 `previewFileTab({ ...workspaceRef.current, selectedRef: null }, target)`（onDoubleClick 的 `onOpenFile(target)` 保留不动）。

(c) **不删** `temporaryPreviewTarget`（Task 4 统一删），但 `select`/MCP 区已不再写它。

- [ ] **Step 2: FilesRightPanelWorkspace — 预览渲染**

(a) :57-60 改：

```ts
const activeFileTabId = workspace.activeItem?.kind === 'file' ? workspace.activeItem.tabId : null
const activeTab = activeFileTabId ? workspace.openTabs.find((tab) => tab.id === activeFileTabId) : undefined
const previewActiveTab = workspace.activeItem?.kind === 'file-preview' ? workspace.previewTab : null
const previewTarget = activeTab?.target ?? previewActiveTab?.target ?? (wide ? createPreviewTargetFromTemporary() : null)
```

其中 `createPreviewTargetFromTemporary` 为本文件内一行辅助（过渡期兼容，Task 4 删）：

```ts
const createPreviewTargetFromTemporary = (): RightPanelFileTarget | null => workspace.temporaryPreviewTarget
```

(b) :154-155 行的 `lineSelection`/`navigationRevision` 改为取"当前生效的 tab"：

```ts
lineSelection={activeTab?.lineSelection ?? previewActiveTab?.lineSelection}
navigationRevision={activeTab?.navigationRevision ?? previewActiveTab?.navigationRevision}
```

(c) :159 `onEditStart` 改（预览激活时固定）：

```ts
onEditStart={!activeTab && previewActiveTab ? () => openFile(previewActiveTab.target) : undefined}
```

(d) :135 移除 `singleClickOpen={!wide}`（树行 onClick 的 `event.detail === 2` 双击打开已在 :718 生效，单击一律预览）；同 props 类型不再需要变更（`singleClickOpen` 留给 Task 4 删）。

(e) `handleMissing`（本文件内已有）加预览分支：缺失目标是预览时 `onWorkspaceChange(clearPreviewFileTab)`（import 自 Task 1）。

- [ ] **Step 3: RightPanelWorkspace — TabBar handlers**

:597 `<RightPanelTabBar` 的 props 块（:620 `onCloseFile` 之后）插入：

```tsx
previewTab={runtimeWorkspace.previewTab}
onActivatePreview={() => {
  closeCodingReview({ type: 'deactivate', threadId })
  updateRuntime((current) => current.previewTab ? { ...current, activeItem: { kind: 'file-preview' } } : current)
}}
onPinPreview={() => updateRuntime(pinPreviewFileTab)}
onClosePreview={() => updateRuntime(clearPreviewFileTab)}
```

（顶部 import 加 `pinPreviewFileTab, clearPreviewFileTab`；`updateRuntime`/`closeCodingReview`/`runtimeWorkspace` 均为该组件既有量，见 :614-616。）

- [ ] **Step 4: 跑既有测试防回归 + typecheck**

Run: `bun test apps/web/src/components/right-panel/ && bun run --filter @lume/web typecheck`
Expected: PASS（可能出现引用 singleClickOpen 行为的既有测试失败——若失败，把该断言更新为预览语义：单击不再开正式 tab，改为 activeItem `{kind:'file-preview'}`）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/right-panel/UnifiedFileTree.tsx apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx apps/web/src/components/right-panel/RightPanelWorkspace.tsx
git commit -m "✨ feat(web): 文件树单击开预览 tab + 双击/编辑固定(接线)"
```

---

### Task 4: 删除 temporaryPreviewTarget 与 singleClickOpen

**Files:**
- Modify: `apps/web/src/components/right-panel/right-panel-files-state.ts`（:45 字段、:87 初始值、:281-282 rewrite 分支）
- Modify: `apps/web/src/components/right-panel/UnifiedFileTree.tsx`（:72/:82/:506 props、残留读写）
- Modify: `apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx`（过渡辅助 `createPreviewTargetFromTemporary`）
- Test: 两个 state 测试文件中引用旧字段的断言

**Interfaces:**
- Consumes: Task 1-3 已全部落地且绿
- Produces: `temporaryPreviewTarget`/`singleClickOpen` 全仓零引用

- [ ] **Step 1: 全仓引用清点**

Run: `grep -rn "temporaryPreviewTarget\|singleClickOpen" apps/web/src --include="*.ts*"`
Expected: 列出全部残留（应只在上述四类文件 + 测试）

- [ ] **Step 2: 逐一删除**

- `right-panel-files-state.ts`：字段声明、`createThreadFileWorkspace` 初始值、`rewriteFileRefPrefix` 内 :281-282 分支（Task 1 已加的 previewTab 分支保留）
- `UnifiedFileTree.tsx`：`singleClickOpen` prop 声明/透传（:72/:82/:506）与 :718 行 `props.singleClickOpen ||`（保留 `event.detail === 2`）
- `FilesRightPanelWorkspace.tsx`：删过渡辅助，`previewTarget` 链变为 `activeTab?.target ?? previewActiveTab?.target ?? null`
- 测试文件：删/改引用旧字段的断言

- [ ] **Step 3: 全量验证**

Run: `bun test apps/web/src/components/right-panel/ && bun run --filter @lume/web typecheck && grep -rn "temporaryPreviewTarget\|singleClickOpen" apps/web/src --include="*.ts*" | grep -v "\.test\." | wc -l`
Expected: 测试 PASS；typecheck exit 0；grep 计数 0

- [ ] **Step 4: 提交**

```bash
git add -A apps/web/src/components/right-panel/
git commit -m "🔥 remove(web): 删除 temporaryPreviewTarget 与 singleClickOpen(被预览 tab 取代)"
```

---

### Task 5: 实机验证 + push

**Files:** 无新改动（验证与推送）

- [ ] **Step 1: 全量回归**

Run: `bun test apps/web/src/ && bun run --filter @lume/web typecheck`
Expected: 全绿（对齐 main baseline，无既有失败新增）

- [ ] **Step 2: 实机 HMR 验证**

把分支的两个文件同步到 dev 运行中的主 checkout（仅验证用，不提交；主 checkout 当前已有 resize 修复的未提交副本，一并共存无冲突）：

```bash
cd D:/workspace/projects/ai-projects/lume
for f in right-panel-files-state.ts right-panel-state.ts RightPanelTabBar.tsx UnifiedFileTree.tsx FilesRightPanelWorkspace.tsx RightPanelWorkspace.tsx; do
  cp ".claude/worktrees/fix-right-panel-resize/apps/web/src/components/right-panel/$f" "apps/web/src/components/right-panel/$f"
done
```

在 Lume 窗口验证清单（请用户确认）：
1. 文件树单击 → 顶部出现斜体预览 tab，右侧显示内容
2. 再点另一文件 → 预览 tab 被替换（单槽）
3. 双击文件 / 双击预览 tab / 预览中开始编辑 → 三入口都转正（斜体消失，位置保留）
4. 关闭预览 tab → 回到上一个正式 tab
5. 窄模式（收窄面板 <680）行为一致
6. 重启 dev → 预览 tab 消失、正式 tab 还在

- [ ] **Step 3: push + PR 描述更新**

```bash
cd .claude/worktrees/fix-right-panel-resize && git push
```

`gh pr edit 83 --body`（追加 issue #55 段落：交互表 + 关联 `Closes #55`——若希望独立 PR 则告知用户改走新分支）。

- [ ] **Step 4: 验证后清理主 checkout 临时副本（用户确认后）**

```bash
cd D:/workspace/projects/ai-projects/lume && git checkout -- apps/web/src/components/right-panel/ && git checkout -- apps/web 2>/dev/null; git status --short | head -5
```

（注意保留主 checkout 上 resize 修复副本的处置与用户确认——见 PR#83 验证流程。）

---

## Self-Review 记录

- **Spec 覆盖**：交互表 6 行 → Task 3(单击/双击) + Task 2(预览 tab 双击/关闭/激活) + Task 3(onEditStart)；不持久化 → Task 1 内存字段（`rightPanelFileWorkspacesAtom` 本就是 `atom({})` 内存态，持久化只走 `normalizePersistedRightPanelFileTabs` 还原 openTabs，RightPanelWorkspace:159）✅；去重固定 → Task 1 `pinPreviewFileTab` 复用 `openFileTab` ✅；窄宽统一 → Task 3(d) ✅；旧机制删除 → Task 4 ✅；测试 → 各 task 内嵌 ✅
- **占位符**：Task 2 Step 1 测试代码标注"以该文件既有渲染模式为准"——是对照既有文件的适配指令而非空洞占位（RightPanelTabBar.test.ts 已存在，含既定渲染辅助）✅
- **类型一致性**：`previewFileTab/pinPreviewFileTab/clearPreviewFileTab` 签名在 Task 1/3 一致；`file-preview` 变体贯穿 Task 1(a)/2(a)(d)/3 ✅
