# Right Panel Tabs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the right panel as a thread-scoped singleton function-tab workspace without changing the left sidebar or main content area behavior.

**Architecture:** Add a focused right-panel state model, pure workspace helpers, and right-panel presentation components under `apps/web/src/components/right-panel`. Mount the new workspace from the app shell / agent right-panel boundary while keeping `LeftSidebar`, `MainArea`, `TabBar`, and `TabContent` untouched. Migrate only old right-panel state hints; do not reuse the old agent `SidePanelView` as the source of truth.

**Tech Stack:** React, TypeScript, Jotai, Tailwind CSS, Bun test, existing `sidecarCall` file/browser helpers.

---

## Scope Guard

Before starting implementation, record the base commit:

```bash
export RIGHT_PANEL_PLAN_BASE="$(git rev-parse HEAD)"
```

Use this value for final scope verification.

Do not modify these files unless a human explicitly expands scope:

- `apps/web/src/components/app-shell/LeftSidebar.tsx`
- `apps/web/src/components/tabs/MainArea.tsx`
- `apps/web/src/components/tabs/TabBar.tsx`
- `apps/web/src/components/tabs/TabContent.tsx`
- welcome, settings, reading, automation, skills screens

Allowed middle-area touch points are limited to right-panel integration:

- `apps/web/src/components/app-shell/AppShell.tsx` may mount the right panel as a sibling after `MainArea`.
- `apps/web/src/components/app-shell/TitleBar.tsx` may swap old right-panel window controls for the new right-panel controls.
- `apps/web/src/components/agent/AgentView.tsx` may remove the old embedded side-panel mount and redirect file-preview requests into the new right-panel workspace. Do not change message rendering, composer behavior, banners, drag/drop attachments, or main column layout beyond removing the old side-panel sibling.
- `apps/web/src/components/agent/AgentHeader.tsx` may remove `AgentSidePanelToolbar` only if the new window controls fully replace it.

## File Structure

### Create

- `apps/web/src/components/right-panel/right-panel-state.ts`
  - Pure types and helpers: default tab creation, open, close, available functions, sanitize/migration.
- `apps/web/src/components/right-panel/right-panel-state.test.ts`
  - Focused Bun tests for singleton tabs, filtered `+` menu, close behavior, thread isolation helpers, and sanitization.
- `apps/web/src/components/right-panel/right-panel-browser-utils.ts`
  - Right-panel-local URL normalization and local service list. Do not move or edit existing middle-area browser tab files.
- `apps/web/src/components/right-panel/right-panel-browser-utils.test.ts`
  - Focused tests for right-panel URL normalization.
- `apps/web/src/atoms/right-panel-atoms.ts`
  - Jotai persisted state: `rightPanelWorkspacesAtom` and `rightPanelLayoutAtom`.
- `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
  - Top-level right-panel shell; renders launcher or active tab; owns only right-panel layout.
- `apps/web/src/components/right-panel/RightPanelTabBar.tsx`
  - Opened function tabs, close buttons, filtered `+` menu, disabled `+` when all functions are open.
- `apps/web/src/components/right-panel/RightPanelLauncher.tsx`
  - Empty-state launcher with Review / Terminal / Browser / Files.
- `apps/web/src/components/right-panel/RightPanelWindowControls.tsx`
  - Far-right window-level controls: expand/fullscreen, minimize/collapse, right-panel toggle.
- `apps/web/src/components/right-panel/FilesRightPanelTab.tsx`
  - Files tab: preview, right-side file tree, file toolbar.
- `apps/web/src/components/right-panel/BrowserRightPanelTab.tsx`
  - Browser tab: browser toolbar, address navigation, local-service launcher, iframe/webview surface.
- `apps/web/src/components/right-panel/PlaceholderRightPanelTab.tsx`
  - Minimal Review / Terminal placeholder tabs until their internals are designed.
- `apps/web/src/components/right-panel/index.ts`
  - Barrel exports for the right-panel package.

### Modify

- `apps/web/src/atoms/index.ts`
  - Export `right-panel-atoms`.
- `apps/web/src/components/app-shell/AppShell.tsx`
  - Mount `RightPanelWorkspace` as the rightmost sibling after `MainArea`.
- `apps/web/src/components/app-shell/TitleBar.tsx`
  - Replace old `AgentSidePanelToolbar` usage with `RightPanelWindowControls`.
- `apps/web/src/components/agent/AgentView.tsx`
  - Remove old `SidePanel` rendering when the new right panel is mounted, then update file-preview callbacks to open the singleton Files tab in the right panel.
- `apps/web/src/components/agent/AgentHeader.tsx`
  - Remove `AgentSidePanelToolbar` export if no longer used.

### Avoid

- Do not create new dependencies.
- Do not modify left sidebar or main tab routing.
- Do not add multiple browser pages.
- Do not refactor old `SidePanel.tsx` unless removing an import becomes necessary. It can remain as dead code until a separate cleanup request.

---

## Chunk 1: State Model And Tests

### Task 1: Add Pure Right-Panel State Helpers

**Files:**
- Create: `apps/web/src/components/right-panel/right-panel-state.ts`
- Create: `apps/web/src/components/right-panel/right-panel-state.test.ts`

- [ ] **Step 1: Write failing tests for singleton creation and filtered menu**

```ts
import { describe, expect, test } from 'bun:test'
import {
  RIGHT_PANEL_FUNCTION_ORDER,
  createEmptyRightPanelWorkspace,
  getAvailableRightPanelFunctions,
  openRightPanelTab,
} from './right-panel-state'

describe('right-panel-state', () => {
  test('opens each function at most once and filters opened functions from plus menu', () => {
    let workspace = createEmptyRightPanelWorkspace()

    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'files')

    expect(Object.keys(workspace.tabs)).toEqual(['files'])
    expect(workspace.activeTab).toBe('files')
    expect(getAvailableRightPanelFunctions(workspace)).toEqual(['review', 'terminal', 'browser'])
  })

  test('uses the fixed display order instead of creation order', () => {
    let workspace = createEmptyRightPanelWorkspace()
    workspace = openRightPanelTab(workspace, 'files')
    workspace = openRightPanelTab(workspace, 'review')
    workspace = openRightPanelTab(workspace, 'browser')

    const openedInDisplayOrder = RIGHT_PANEL_FUNCTION_ORDER.filter((type) => workspace.tabs[type])
    expect(openedInDisplayOrder).toEqual(['review', 'browser', 'files'])
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: FAIL because `right-panel-state.ts` does not exist.

- [ ] **Step 3: Implement minimal state types and helpers**

```ts
export type RightPanelFunction = 'review' | 'terminal' | 'browser' | 'files'

export const RIGHT_PANEL_FUNCTION_ORDER: RightPanelFunction[] = ['review', 'terminal', 'browser', 'files']

export interface ThreadRightPanelWorkspace {
  activeTab: RightPanelFunction | null
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>
}

export type RightPanelTabState =
  | { type: 'review' }
  | { type: 'terminal' }
  | BrowserTabState
  | FilesTabState

export interface BrowserTabState {
  type: 'browser'
  url: string
  addressInput: string
  zoom: number
  deviceToolbarVisible: boolean
}

export interface FilesTabState {
  type: 'files'
  selectedPath: string | null
  treeVisible: boolean
  searchQuery: string
  enhancedView: boolean
}

export function createEmptyRightPanelWorkspace(): ThreadRightPanelWorkspace {
  return { activeTab: null, tabs: {} }
}

export function createDefaultRightPanelTab(type: RightPanelFunction): RightPanelTabState {
  if (type === 'browser') {
    return { type, url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false }
  }
  if (type === 'files') {
    return { type, selectedPath: null, treeVisible: true, searchQuery: '', enhancedView: true }
  }
  return { type }
}

export function openRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  return {
    activeTab: type,
    tabs: {
      ...workspace.tabs,
      [type]: workspace.tabs[type] ?? createDefaultRightPanelTab(type),
    },
  }
}

export function getAvailableRightPanelFunctions(workspace: ThreadRightPanelWorkspace): RightPanelFunction[] {
  return RIGHT_PANEL_FUNCTION_ORDER.filter((type) => !workspace.tabs[type])
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/right-panel/right-panel-state.ts apps/web/src/components/right-panel/right-panel-state.test.ts
git commit -m "✨ feat(web): 添加右侧面板状态模型" \
  -m "新增线程级 singleton 功能 tab 状态 helper，为右侧面板交互提供可测试边界。" \
  -m "Constraint: 不触碰左侧面板和中间主内容区" \
  -m "Tested: bun test apps/web/src/components/right-panel/right-panel-state.test.ts"
```

### Task 2: Add Close Behavior And Sanitization

**Files:**
- Modify: `apps/web/src/components/right-panel/right-panel-state.ts`
- Modify: `apps/web/src/components/right-panel/right-panel-state.test.ts`

- [ ] **Step 1: Add failing tests for close and sanitize**

```ts
import {
  closeRightPanelTab,
  firstOpenRightPanelTab,
  sanitizeRightPanelWorkspace,
} from './right-panel-state'

test('closing the active tab selects the next tab in fixed order', () => {
  let workspace = createEmptyRightPanelWorkspace()
  workspace = openRightPanelTab(workspace, 'review')
  workspace = openRightPanelTab(workspace, 'browser')
  workspace = openRightPanelTab(workspace, 'files')

  const next = closeRightPanelTab(workspace, 'browser')

  expect(next.activeTab).toBe('files')
  expect(next.tabs.browser).toBeUndefined()
})

test('sanitize drops malformed tabs and repairs activeTab', () => {
  const workspace = sanitizeRightPanelWorkspace({
    activeTab: 'unknown',
    tabs: {
      files: { type: 'browser', url: 'bad' },
      browser: { type: 'browser', zoom: 'nope' },
      review: { type: 'review' },
    },
  })

  expect(workspace.activeTab).toBe('review')
  expect(workspace.tabs.files).toBeUndefined()
  expect(workspace.tabs.browser).toMatchObject({ type: 'browser', url: '', zoom: 1 })
})

test('closing a tab makes it available and closing the last tab returns to launcher state', () => {
  let workspace = createEmptyRightPanelWorkspace()
  workspace = openRightPanelTab(workspace, 'files')

  const closed = closeRightPanelTab(workspace, 'files')

  expect(closed.activeTab).toBeNull()
  expect(getAvailableRightPanelFunctions(closed)).toContain('files')
})

test('firstOpenRightPanelTab follows fixed function order', () => {
  expect(firstOpenRightPanelTab({
    files: createDefaultRightPanelTab('files'),
    browser: createDefaultRightPanelTab('browser'),
  })).toBe('browser')
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: FAIL because close/sanitize helpers do not exist.

- [ ] **Step 3: Implement close and sanitize**

Implement the close behavior explicitly:

```ts
export function firstOpenRightPanelTab(
  tabs: Partial<Record<RightPanelFunction, RightPanelTabState>>,
): RightPanelFunction | null {
  return RIGHT_PANEL_FUNCTION_ORDER.find((candidate) => tabs[candidate]) ?? null
}

export function closeRightPanelTab(
  workspace: ThreadRightPanelWorkspace,
  type: RightPanelFunction,
): ThreadRightPanelWorkspace {
  const tabs = { ...workspace.tabs }
  delete tabs[type]

  if (workspace.activeTab !== type) {
    return { activeTab: workspace.activeTab && tabs[workspace.activeTab] ? workspace.activeTab : firstOpenRightPanelTab(tabs), tabs }
  }

  const closedIndex = RIGHT_PANEL_FUNCTION_ORDER.indexOf(type)
  const right = RIGHT_PANEL_FUNCTION_ORDER.slice(closedIndex + 1).find((candidate) => tabs[candidate])
  const left = [...RIGHT_PANEL_FUNCTION_ORDER.slice(0, closedIndex)].reverse().find((candidate) => tabs[candidate])
  return { activeTab: right ?? left ?? null, tabs }
}
```

Implement sanitization with these exact rules:

- Return an empty workspace if input is not an object.
- Accept only keys in `RIGHT_PANEL_FUNCTION_ORDER`.
- Drop any tab whose `type` does not match the key.
- Merge valid tab objects over `createDefaultRightPanelTab(key)`.
- Browser fields: `url` and `addressInput` must be strings; otherwise default to `''`.
- Browser `zoom` must be a finite number between `0.25` and `3`; otherwise default to `1`.
- Browser `deviceToolbarVisible` must be boolean; otherwise default to `false`.
- Files `selectedPath` must be string or `null`; otherwise default to `null`.
- Files `treeVisible` and `enhancedView` must be boolean; otherwise use defaults.
- Files `searchQuery` must be string; otherwise default to `''`.
- If sanitized `activeTab` is not open, use the first open tab in fixed order.
- If no tabs remain, set `activeTab` to `null`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/right-panel/right-panel-state.ts apps/web/src/components/right-panel/right-panel-state.test.ts
git commit -m "🐛 fix(web): 修复右侧面板状态恢复规则" \
  -m "补充关闭 tab 后的激活顺序和持久化状态清洗，避免坏数据破坏右侧面板渲染。" \
  -m "Constraint: 固定功能顺序为审查、终端、浏览器、文件" \
  -m "Tested: bun test apps/web/src/components/right-panel/right-panel-state.test.ts"
```

### Task 3: Add Jotai Persistence Atom

**Files:**
- Create: `apps/web/src/atoms/right-panel-atoms.ts`
- Modify: `apps/web/src/components/right-panel/right-panel-state.ts`
- Modify: `apps/web/src/components/right-panel/right-panel-state.test.ts`
- Modify: `apps/web/src/atoms/index.ts`

- [ ] **Step 1: Add a test for legacy migration helper**

Add a pure helper test in `right-panel-state.test.ts` before wiring Jotai:

```ts
import { migrateLegacyRightPanelHints } from './right-panel-state'

test('legacy file side-panel hints can create an initial files tab', () => {
  const workspace = migrateLegacyRightPanelHints({
    sidePanelView: 'files',
    fileTreeOpen: false,
  })

  expect(workspace.activeTab).toBe('files')
  expect(workspace.tabs.files).toMatchObject({ type: 'files', treeVisible: false })
})
```

- [ ] **Step 2: Run the state test and verify it fails**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: FAIL because migration helper does not exist.

- [ ] **Step 3: Implement migration helper**

Add this helper to `right-panel-state.ts`:

```ts
export function migrateLegacyRightPanelHints(input: {
  sidePanelView?: unknown
  fileTreeOpen?: unknown
}): ThreadRightPanelWorkspace {
  if (input.sidePanelView !== 'files') return createEmptyRightPanelWorkspace()
  const workspace = openRightPanelTab(createEmptyRightPanelWorkspace(), 'files')
  const files = workspace.tabs.files
  if (!files || files.type !== 'files') return workspace
  return {
    activeTab: 'files',
    tabs: {
      files: {
        ...files,
        treeVisible: typeof input.fileTreeOpen === 'boolean' ? input.fileTreeOpen : files.treeVisible,
      },
    },
  }
}
```

This helper does not read atoms directly. It is a deterministic adapter for old right-panel hints.

- [ ] **Step 4: Implement the atom**

`apps/web/src/atoms/right-panel-atoms.ts`:

```ts
import { atomWithStorage } from 'jotai/utils'
import type { ThreadRightPanelWorkspace } from '@/components/right-panel/right-panel-state'

export type RightPanelDisplayMode = 'normal' | 'expanded' | 'compact'

export interface RightPanelLayoutState {
  open: boolean
  mode: RightPanelDisplayMode
}

export const rightPanelWorkspacesAtom = atomWithStorage<Record<string, ThreadRightPanelWorkspace>>(
  'right-panel-workspaces',
  {},
)

export const rightPanelLayoutAtom = atomWithStorage<RightPanelLayoutState>(
  'right-panel-layout',
  { open: true, mode: 'normal' },
)
```

If a component needs to update a single thread workspace, use this immutable pattern instead of mutating the record in place:

```ts
setRightPanelWorkspaces((prev) => ({
  ...prev,
  [threadId]: nextWorkspace,
}))
```

Add a small test or inline helper in `right-panel-state.test.ts` for record isolation:

```ts
test('thread workspace records update one thread without changing another', () => {
  const first = openRightPanelTab(createEmptyRightPanelWorkspace(), 'files')
  const second = openRightPanelTab(createEmptyRightPanelWorkspace(), 'browser')
  const record = { 'thread-1': first, 'thread-2': second }

  const next = {
    ...record,
    'thread-1': openRightPanelTab(record['thread-1'], 'review'),
  }

  expect(next['thread-1'].activeTab).toBe('review')
  expect(next['thread-2']).toBe(second)
})
```

`apps/web/src/atoms/index.ts`:

```ts
export * from './right-panel-atoms'
```

- [ ] **Step 5: Run focused tests and compile check**

Run:

```bash
bun test apps/web/src/components/right-panel/right-panel-state.test.ts
bun run --filter @lume/web typecheck
```

Expected: PASS. The typecheck is included because this task adds exported atoms.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/atoms/right-panel-atoms.ts apps/web/src/atoms/index.ts apps/web/src/components/right-panel/right-panel-state.ts apps/web/src/components/right-panel/right-panel-state.test.ts
git commit -m "✨ feat(web): 持久化右侧面板工作区" \
  -m "新增 right-panel-workspaces 存储键，并保留旧文件侧栏状态到新 files tab 的迁移入口。" \
  -m "Constraint: 旧 SidePanelView 只作为迁移提示，不作为新状态源" \
  -m "Tested: bun test apps/web/src/components/right-panel/right-panel-state.test.ts && bun run --filter @lume/web typecheck"
```

---

## Chunk 2: Workspace Shell And Window Controls

### Task 4: Build Launcher, Tab Bar, And Workspace Shell

**Files:**
- Create: `apps/web/src/components/right-panel/RightPanelLauncher.tsx`
- Create: `apps/web/src/components/right-panel/RightPanelTabBar.tsx`
- Create: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- Create: `apps/web/src/components/right-panel/PlaceholderRightPanelTab.tsx`
- Create: `apps/web/src/components/right-panel/index.ts`
- Test: `apps/web/src/components/right-panel/right-panel-state.test.ts`

- [ ] **Step 1: Add a state test for all-functions-open behavior**

```ts
test('available function list is empty when all functions are open', () => {
  let workspace = createEmptyRightPanelWorkspace()
  for (const type of RIGHT_PANEL_FUNCTION_ORDER) {
    workspace = openRightPanelTab(workspace, type)
  }

  expect(getAvailableRightPanelFunctions(workspace)).toEqual([])
})
```

- [ ] **Step 2: Run the focused state test**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: PASS if Chunk 1 is complete.

- [ ] **Step 3: Create `RightPanelLauncher.tsx`**

Use existing lucide icons. Render four large rows in fixed order. Props:

```ts
interface RightPanelLauncherProps {
  onOpen: (type: RightPanelFunction) => void
}
```

Each row calls `onOpen(type)`.

- [ ] **Step 4: Create `RightPanelTabBar.tsx`**

Props:

```ts
interface RightPanelTabBarProps {
  workspace: ThreadRightPanelWorkspace
  onActivate: (type: RightPanelFunction) => void
  onClose: (type: RightPanelFunction) => void
  onOpen: (type: RightPanelFunction) => void
}
```

Render opened tabs in `RIGHT_PANEL_FUNCTION_ORDER`. The `+` menu renders `getAvailableRightPanelFunctions(workspace)`. If none are available, render a disabled `+` button with title `全部功能已打开`.

- [ ] **Step 5: Create `PlaceholderRightPanelTab.tsx`**

Minimal placeholder for any function whose full tab body has not been implemented yet:

```tsx
export function PlaceholderRightPanelTab({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--text-3)]">
      {label}
    </div>
  )
}
```

- [ ] **Step 6: Create `RightPanelWorkspace.tsx`**

Responsibilities:

- Derive active thread from `tabsAtom` and `activeTabIdAtom`.
- If active main tab is not an agent thread, hide the right panel.
- Read/write `rightPanelWorkspacesAtom[threadId]`.
- Sanitize workspace before rendering.
- Render launcher when no opened function tabs exist.
- Render `RightPanelTabBar` and active function content otherwise.
- During this chunk, render `PlaceholderRightPanelTab` for all four functions. Use labels `审查`, `终端`, `浏览器`, and `文件`.
- Do not allow an opened `files` or `browser` tab to render blank or `undefined` content before Chunk 3.

Do not import or modify `LeftSidebar`, `MainArea`, `TabBar`, or `TabContent`.

- [ ] **Step 7: Run focused tests and compile check**

Run:

```bash
bun test apps/web/src/components/right-panel/right-panel-state.test.ts
bun run --filter @lume/web typecheck
```

Expected: PASS. Typecheck is required here because this task creates TSX components and barrel exports.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/right-panel apps/web/src/components/right-panel/right-panel-state.test.ts
git commit -m "✨ feat(web): 搭建右侧面板工作区外壳" \
  -m "新增右侧面板启动器、功能 tab bar 和占位内容，按线程状态渲染 singleton 功能 tab。" \
  -m "Constraint: 不修改左侧面板和中间 tab 内容路由" \
  -m "Tested: bun test apps/web/src/components/right-panel/right-panel-state.test.ts && bun run --filter @lume/web typecheck"
```

### Task 5: Add Window-Level Controls And Mount Right Panel

**Files:**
- Create: `apps/web/src/components/right-panel/RightPanelWindowControls.tsx`
- Modify: `apps/web/src/atoms/right-panel-atoms.ts`
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- Modify: `apps/web/src/components/app-shell/AppShell.tsx`
- Modify: `apps/web/src/components/app-shell/TitleBar.tsx`
- Modify: `apps/web/src/components/agent/AgentView.tsx`

- [ ] **Step 1: Confirm layout state exists**

Use `rightPanelLayoutAtom` from `apps/web/src/atoms/right-panel-atoms.ts`:

```ts
export type RightPanelDisplayMode = 'normal' | 'expanded' | 'compact'

export interface RightPanelLayoutState {
  open: boolean
  mode: RightPanelDisplayMode
}
```

Behavior:

- `open: false`: `RightPanelWorkspace` returns `null`, but `RightPanelWindowControls` remains visible for agent threads so the panel can be reopened.
- `mode: 'normal'`: `RightPanelWorkspace` renders at `w-[520px]`.
- `mode: 'expanded'`: `RightPanelWorkspace` renders at `w-[760px]`.
- `mode: 'compact'`: `RightPanelWorkspace` renders at `w-[72px]` and hides tab content body while preserving workspace state.

`RightPanelWorkspace` is the component that consumes `rightPanelLayoutAtom` and applies these width/body rules.

- [ ] **Step 2: Create `RightPanelWindowControls.tsx`**

Controls:

- Expand / fullscreen toggles `mode` between `normal` and `expanded`.
- Minimize / collapse toggles `mode` between `compact` and `normal`.
- Right-panel toggle toggles `open`.

These are right-panel layout actions, not Tauri window actions. Keep them visually at the far right. Do not include file-tree, browser menu, or current-tab actions here.

- [ ] **Step 3: Apply layout state in `RightPanelWorkspace.tsx`**

Read `rightPanelLayoutAtom`:

- If `open` is false, return `null`.
- If active main tab is not an agent thread, return `null`.
- Apply the width classes defined in Step 1.
- In `compact` mode, render only the panel shell/rail affordance and hide the active tab body. Do not clear or mutate the thread workspace.

- [ ] **Step 4: Mount `RightPanelWorkspace` in `AppShell.tsx`**

Add it as the rightmost sibling after the existing `MainArea` wrapper:

```tsx
<div className="flex-1 min-w-0 pb-2 pl-2 pr-2 pt-5 relative z-[60]">
  <MainArea />
</div>
<RightPanelWorkspace />
```

Do not alter `LeftSidebar` or `MainArea`.

- [ ] **Step 5: Update `TitleBar.tsx`**

Replace the old agent-only side-panel toolbar with `RightPanelWindowControls`. Keep titlebar drag behavior intact.

Visibility rules:

- Show `RightPanelWindowControls` only when the active main app tab is an agent thread.
- Do not read or write `agentSidePanelViewAtom` here.
- Do not change titlebar drag regions or non-right-panel titlebar behavior.

- [ ] **Step 6: Remove the old embedded `SidePanel` mount from `AgentView.tsx`**

Once `RightPanelWorkspace` is mounted in `AppShell.tsx`, remove the old embedded `<SidePanel />` rendering and its panel animation state from `AgentView.tsx` in the same task. This prevents duplicate right panels.

Keep file-preview callbacks compiling for now; Task 8 will redirect them to `rightPanelWorkspacesAtom`. File-preview clicks may be temporarily non-functional between Task 5 and Task 8, so do not ship or hand off the feature after Chunk 2. If removing the old mount leaves callback state unused, remove only the now-unused state and imports. Verify `AgentView.tsx` has no remaining `renderedSidePanelView`, side-panel animation timer, or `SidePanel` import that could remount the old panel. Do not change `AgentMessages`, `AgentInput`, banners, drag/drop attachment behavior, or main column layout.

- [ ] **Step 7: Run a focused build sanity check**

Run: `bun run --filter @lume/web typecheck`

Expected: PASS. If unrelated errors appear, record them and run the smallest command that verifies the touched files compile if available.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/right-panel/RightPanelWindowControls.tsx apps/web/src/components/right-panel/RightPanelWorkspace.tsx apps/web/src/atoms/right-panel-atoms.ts apps/web/src/components/app-shell/AppShell.tsx apps/web/src/components/app-shell/TitleBar.tsx apps/web/src/components/agent/AgentView.tsx
git commit -m "✨ feat(web): 挂载右侧多标签面板" \
  -m "将右侧面板作为主内容右侧的独立工作区挂载，移除旧 Agent 内嵌侧栏挂载，并把窗口级控制固定在最右侧。" \
  -m "Constraint: MainArea、TabBar、TabContent、LeftSidebar 保持不动；不改消息流和输入区" \
  -m "Tested: bun run --filter @lume/web typecheck"
```

---

## Chunk 3: Files And Browser Function Tabs

### Task 6: Implement Files Singleton Tab

**Files:**
- Create: `apps/web/src/components/right-panel/FilesRightPanelTab.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- Reuse patterns from: `apps/web/src/components/tabs/FilePreviewTabView.tsx`

- [ ] **Step 1: Identify reusable code paths**

Read `FilePreviewTabView.tsx` and reuse existing APIs:

- `readTextFile`
- `sidecarCall`
- `writeClipboardText`
- `AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE`
- `AGENT_IPC_CHANNELS.READ_FILE`
- `AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY`
- `AGENT_IPC_CHANNELS.LIST_DIRECTORY`
- `AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE`
- `AGENT_IPC_CHANNELS.OPEN_FILE`
- `normalizeDirectoryEntriesResponse`
- `FileTypeIcon`
- `XMarkdown`

Do not move shared code unless duplication becomes large. Prefer a small copied implementation scoped to the right panel for the first pass.

- [ ] **Step 2: Implement `FilesRightPanelTab` props**

```ts
interface FilesRightPanelTabProps {
  state: FilesTabState
  workspaceSlug?: string
  threadId: string
  onChange: (next: FilesTabState) => void
}
```

- [ ] **Step 3: Implement stable two-column layout**

First pass file source behavior:

- Default tree source is thread files when opened from an agent thread.
- If `workspaceSlug` is available, expose a local segmented switch inside the files tab toolbar for `线程文件` and `工作区文件`.
- Do not add a new global source switch outside the files tab.
- Memory source preview is introduced in Task 8 through `FilesTabState.source`; it is not part of the initial tree source switch.

States:

- `selectedPath === null`: left preview empty, right file tree visible.
- `selectedPath !== null`: left preview content, right file tree visible and selected file highlighted.
- `treeVisible === false`: preview full width, toolbar still has file-tree toggle.

Toolbar actions stay inside this tab:

- Toggle file tree
- Open with system app
- More menu: copy path, copy file contents, enhanced view toggle

- [ ] **Step 4: Wire files tab into `RightPanelWorkspace`**

When active tab state is `files`, render:

```tsx
<FilesRightPanelTab
  state={filesState}
  threadId={activeThreadId}
  workspaceSlug={workspaceSlug}
  onChange={(next) => updateFunctionState('files', next)}
/>
```

Selecting a file only updates `files.selectedPath`; it must not create a new right-panel tab.

- [ ] **Step 5: Run focused checks**

Run:

```bash
bun run --filter @lume/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Manual files-tab smoke**

Run the app with `bun run dev`.

Expected terminal output: both web and desktop dev processes start without exiting; use the printed localhost URL for the web app if needed.

Verify:

- Opening Files creates one files tab.
- The left preview shows the empty state before file selection.
- The right file tree is visible before file selection.
- Selecting a file updates the same files tab and does not create another files tab.
- Toggling the file tree only updates the files tab toolbar/content, not the far-right window controls.
- Closing and reopening Files resets it to its initial state.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/right-panel/FilesRightPanelTab.tsx apps/web/src/components/right-panel/RightPanelWorkspace.tsx
git commit -m "✨ feat(web): 实现右侧文件功能 tab" \
  -m "新增线程内 singleton 文件 tab，保持左预览右文件树布局并将文件操作限制在当前 tab 工具栏。" \
  -m "Constraint: 文件树选择复用同一个 files tab" \
  -m "Tested: bun run --filter @lume/web typecheck; manual files-tab smoke"
```

### Task 7: Implement Browser Singleton Tab

**Files:**
- Create: `apps/web/src/components/right-panel/right-panel-browser-utils.ts`
- Create: `apps/web/src/components/right-panel/right-panel-browser-utils.test.ts`
- Create: `apps/web/src/components/right-panel/BrowserRightPanelTab.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- Reuse patterns from: `apps/web/src/components/tabs/BrowserTabView.tsx`

- [ ] **Step 1: Create right-panel-local browser utility tests**

Do not modify `apps/web/src/components/tabs/BrowserTabView.tsx` or `apps/web/src/components/tabs/file-tabs.test.ts`.

`right-panel-browser-utils.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { getDefaultLocalBrowserServices, normalizeRightPanelBrowserUrl } from './right-panel-browser-utils'

describe('right-panel browser utils', () => {
  test('normalizes localhost-style addresses to http and external hosts to https', () => {
    expect(normalizeRightPanelBrowserUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeRightPanelBrowserUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    expect(normalizeRightPanelBrowserUrl('example.com')).toBe('https://example.com')
    expect(normalizeRightPanelBrowserUrl('https://openai.com')).toBe('https://openai.com')
  })

  test('provides the default local Lume service card', () => {
    expect(getDefaultLocalBrowserServices()).toContainEqual({
      title: 'Lume',
      url: 'http://localhost:3000',
    })
  })
})
```

- [ ] **Step 2: Run utility tests and verify they fail**

Run: `bun test apps/web/src/components/right-panel/right-panel-browser-utils.test.ts`

Expected: FAIL because the utility file does not exist.

- [ ] **Step 3: Implement right-panel browser utilities**

`normalizeRightPanelBrowserUrl` should match the current browser tab behavior without importing from the middle tab component.

`getDefaultLocalBrowserServices()` should return a readonly list with one card for `{ title: 'Lume', url: 'http://localhost:3000' }`.

- [ ] **Step 4: Implement `BrowserRightPanelTab` props**

```ts
interface BrowserRightPanelTabProps {
  state: BrowserTabState
  onChange: (next: BrowserTabState) => void
}
```

- [ ] **Step 5: Implement browser toolbar and initial launcher**

Toolbar:

- Back
- Forward
- Refresh
- Address bar
- Open in system browser
- More menu

Initial content:

- If `state.url` is empty, show local-service launcher cards.
- Clicking a local-service card updates `url` in the same browser tab.
- No "new browser page" or reset action.

History controls:

- Refresh reloads the current iframe by bumping a local `frameKey`.
- Back and Forward are present but visibly disabled in the first pass unless the implementation has a safe same-tab iframe history mechanism. Do not add new browser/webview backend APIs in this plan.

- [ ] **Step 6: Implement browser more menu**

Menu contains only current-browser actions:

- Force reload
- Show device toolbar
- Zoom controls
- Clear Cookie disabled with title `暂不支持清除 Cookie`
- Clear cache using existing `clearCache({ frontendTemp: true, previewRender: true })`

Do not add new backend or Tauri APIs for Cookie clearing in this plan.

- [ ] **Step 7: Wire browser tab into `RightPanelWorkspace`**

When active tab state is `browser`, render the singleton browser tab. `+ -> Browser` must be absent while it is open because the available-function helper filters it out.

- [ ] **Step 8: Run focused checks**

Run:

```bash
bun test apps/web/src/components/right-panel/right-panel-browser-utils.test.ts
bun run --filter @lume/web typecheck
```

Expected: PASS.

- [ ] **Step 9: Manual browser-tab smoke**

Run the app with `bun run dev`.

Expected terminal output: both web and desktop dev processes start without exiting; use the printed localhost URL for the web app if needed.

Verify:

- Opening Browser creates one browser tab.
- `+` no longer shows Browser while Browser is open.
- The initial browser body shows the Lume local service card.
- Clicking the service card navigates the same browser tab.
- Typing a new URL navigates the same browser tab.
- There is no new browser page/reset action.
- Browser more menu is inside the browser toolbar, not the far-right window controls.
- Clear Cookie is visible but disabled.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/right-panel/right-panel-browser-utils.ts apps/web/src/components/right-panel/right-panel-browser-utils.test.ts apps/web/src/components/right-panel/BrowserRightPanelTab.tsx apps/web/src/components/right-panel/RightPanelWorkspace.tsx
git commit -m "✨ feat(web): 实现右侧浏览器功能 tab" \
  -m "新增给 agent 操作的 singleton 浏览器 tab，保留本地服务启动页并移除多浏览器页语义。" \
  -m "Constraint: 浏览器更多菜单只放当前 browser tab 操作" \
  -m "Tested: bun test apps/web/src/components/right-panel/right-panel-browser-utils.test.ts && bun run --filter @lume/web typecheck; manual browser-tab smoke"
```

---

## Chunk 4: Replace Old Agent Side Panel Wiring

### Task 8: Redirect File Preview Requests Into The New Right Panel

**Files:**
- Modify: `apps/web/src/components/agent/AgentView.tsx`
- Modify: `apps/web/src/components/agent/AgentView.test.tsx`
- Modify: `apps/web/src/components/agent/AgentHeader.tsx`
- Modify: `apps/web/src/components/right-panel/FilesRightPanelTab.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- Modify: `apps/web/src/components/right-panel/right-panel-state.ts`
- Modify: `apps/web/src/components/right-panel/right-panel-state.test.ts`

- [ ] **Step 1: Add pure helper for opening files in the files tab**

In `right-panel-state.test.ts`:

```ts
// Add openFileInRightPanel and sanitizeRightPanelWorkspace to the existing
// right-panel-state import list instead of creating a duplicate import block.

test('opening a file creates or reuses the files tab and selects the path', () => {
  const workspace = openFileInRightPanel(createEmptyRightPanelWorkspace(), 'README.md')

  expect(workspace.activeTab).toBe('files')
  expect(workspace.tabs.files).toMatchObject({
    type: 'files',
    source: 'thread',
    selectedPath: 'README.md',
  })

  const next = openFileInRightPanel(workspace, 'package.json')
  expect(Object.keys(next.tabs)).toEqual(['files'])
  expect(next.tabs.files).toMatchObject({ selectedPath: 'package.json' })
})

test('opening a file preserves files-tab view settings', () => {
  let workspace = openFileInRightPanel(createEmptyRightPanelWorkspace(), 'README.md')
  workspace = {
    ...workspace,
    tabs: {
      files: {
        type: 'files',
        source: 'thread',
        selectedPath: 'README.md',
        treeVisible: false,
        searchQuery: 'src',
        enhancedView: false,
      },
    },
  }

  const next = openFileInRightPanel(workspace, 'package.json')

  expect(next.tabs.files).toMatchObject({
    source: 'thread',
    selectedPath: 'package.json',
    treeVisible: false,
    searchQuery: 'src',
    enhancedView: false,
  })
})

test('opening a memory file uses the files tab memory source', () => {
  const workspace = openFileInRightPanel(createEmptyRightPanelWorkspace(), 'memories/profile.md', 'memory')

  expect(workspace.activeTab).toBe('files')
  expect(workspace.tabs.files).toMatchObject({
    type: 'files',
    source: 'memory',
    selectedPath: 'memories/profile.md',
  })
})

test('sanitize defaults missing files source to thread', () => {
  const workspace = sanitizeRightPanelWorkspace({
    activeTab: 'files',
    tabs: {
      files: {
        type: 'files',
        selectedPath: 'README.md',
        treeVisible: true,
        searchQuery: '',
        enhancedView: true,
      },
    },
  })

  expect(workspace.tabs.files).toMatchObject({ source: 'thread' })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test apps/web/src/components/right-panel/right-panel-state.test.ts`

Expected: FAIL because `openFileInRightPanel` does not exist.

- [ ] **Step 3: Implement `openFileInRightPanel`**

Extend `FilesTabState` with a `source: 'thread' | 'memory'` field in this task so both thread-file previews and memory-source previews survive the old side-panel removal:

- default source is `'thread'`
- `openFileInRightPanel(workspace, path, 'thread')` selects a thread file
- `openFileInRightPanel(workspace, path, 'memory')` selects a memory file
- sanitization defaults missing `source` to `'thread'`

`openFileInRightPanel` should call `openRightPanelTab(workspace, 'files')` and then update `files.selectedPath` and `files.source`, preserving existing files-tab view settings.

- [ ] **Step 4: Redirect `AgentView` callbacks**

If any old `SidePanel` wiring remains after Chunk 2, replace only the right-panel parts:

- Remove old `SidePanel` rendering.
- Remove old side-panel animation state if it becomes unused.
- Keep `AgentMessages` callbacks intact, but make `openThreadFilePreview(path)` write to `rightPanelWorkspacesAtom` for the active `threadId` using `openFileInRightPanel`.
- Route `openMemoryFilePreview(path)` to the same singleton files tab with source `'memory'`.
- Both `openThreadFilePreview(path)` and `openMemoryFilePreview(path)` must also update `rightPanelLayoutAtom` so preview actions visibly reopen the right panel if it was closed or compact. If the panel is already open in `expanded` mode, preserve `expanded`; otherwise set `{ open: true, mode: 'normal' }`.
- Update `FilesRightPanelTab` to call existing `readMemory({ workspaceSlug, path })` for memory files.
- If memory source support cannot be completed without changing non-right-panel areas, stop and ask for scope clarification before removing the old `SidePanel`.

Do not change `AgentMessages`, `AgentInput`, banners, drag/drop attachment behavior, or message rendering.

- [ ] **Step 5: Assign `RightPanelWorkspace.tsx` responsibility for AgentView file opens**

If `RightPanelWorkspace` currently derives only active thread state, keep it that way. The file-open write should happen from `AgentView` through `rightPanelWorkspacesAtom`; do not add a second event bus. Modify `RightPanelWorkspace.tsx` only if the files tab state shape changes, such as adding `FilesTabState.source`.

- [ ] **Step 6: Remove obsolete toolbar usage**

Remove `AgentSidePanelToolbar` and obsolete imports from `AgentHeader.tsx` after `TitleBar.tsx` uses `RightPanelWindowControls`.

Keep `AgentHeader` itself visually unchanged.

- [ ] **Step 7: Run focused tests**

Run:

```bash
bun test apps/web/src/components/right-panel/right-panel-state.test.ts
bun test apps/web/src/components/agent/AgentView.test.tsx
bun run --filter @lume/web typecheck
```

Expected: PASS. Update `AgentView.test.tsx` right-panel-related assertions to expect `rightPanelWorkspacesAtom` and `rightPanelLayoutAtom` updates instead of `agentSidePanelViewAtom` writes for both thread-file opens and memory-source opens.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/agent/AgentView.tsx apps/web/src/components/agent/AgentView.test.tsx apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/right-panel/FilesRightPanelTab.tsx apps/web/src/components/right-panel/right-panel-state.ts apps/web/src/components/right-panel/right-panel-state.test.ts apps/web/src/components/right-panel/RightPanelWorkspace.tsx
git commit -m "♻️ refactor(web): 切换文件预览到右侧工作区" \
  -m "将聊天中的文件预览入口改为打开线程级 files tab，并移除旧 Agent 内嵌侧栏挂载。" \
  -m "Constraint: 不改消息列表、输入框、左侧导航或主 tab 路由" \
  -m "Tested: bun test apps/web/src/components/right-panel/right-panel-state.test.ts && bun test apps/web/src/components/agent/AgentView.test.tsx && bun run --filter @lume/web typecheck"
```

### Task 9: Final Integration Check

**Files:**
- Review changed files only.

- [ ] **Step 1: Inspect changed-file list**

Run: `git status --short`

Expected after per-chunk commits: clean working tree. If commits were intentionally deferred, only files listed in this plan may appear.

- [ ] **Step 2: Verify forbidden files were not modified**

Run:

```bash
test -n "${RIGHT_PANEL_PLAN_BASE:-}"
git rev-parse --verify "$RIGHT_PANEL_PLAN_BASE"
git diff --quiet "$RIGHT_PANEL_PLAN_BASE"..HEAD -- \
  apps/web/src/components/app-shell/LeftSidebar.tsx \
  apps/web/src/components/tabs/MainArea.tsx \
  apps/web/src/components/tabs/TabBar.tsx \
  apps/web/src/components/tabs/TabContent.tsx
```

Expected: all commands exit successfully. If the final `git diff --quiet` exits non-zero, a forbidden file changed and the implementation must stop for human review.

- [ ] **Step 3: Run focused test set**

Run:

```bash
bun test apps/web/src/components/right-panel/right-panel-state.test.ts
bun test apps/web/src/components/right-panel/right-panel-browser-utils.test.ts
bun test apps/web/src/components/tabs/file-tabs.test.ts
bun test apps/web/src/components/agent/AgentView.test.tsx
bun run --filter @lume/web typecheck
```

Expected: PASS.

- [ ] **Step 4: Manual smoke in app**

Start the app using the existing project command:

```bash
bun run dev
```

Expected terminal output: `web` and `desktop` processes start and remain running. The web process prints a localhost dev URL, commonly `http://localhost:5173/`.

Verify manually:

- A thread with no right-panel tabs shows launcher.
- Opening Files creates one files tab.
- `+` no longer shows Files while Files is open.
- Closing Files makes Files appear again in `+`.
- Opening Browser creates one browser tab.
- `+` no longer shows Browser while Browser is open.
- Browser has no new-page/reset action.
- File tree toggle is inside files toolbar, not window controls.
- Browser more menu is inside browser toolbar, not window controls.
- Window controls stay far right.
- Left sidebar and middle content behavior are unchanged.

- [ ] **Step 5: Handle integration fixes**

If Step 4 reveals a bug, stop and create a focused fix task with exact files, exact verification commands, and a Lore-compliant commit message. Do not make an unplanned catch-all integration commit.
