# 文件面板树常驻重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 预览从 TabBar 一等公民降级为文件工作区内部单槽——树常驻面板本体、TabBar 高亮不跳变、废底部 FileDetailsBar 改行内菜单、窄模式二态切换。

**Architecture:** 撤销 #55 的预览 tab 渲染层（TabBar 项/file-preview 激活态/四个 handler props），保留其状态层（previewTab 字段+三函数，语义改"预览槽"）；窄模式树/预览切换由新 preference `narrowShowsPreview` 驱动；FileDetailsBar 整体删除（其操作集已在树行右键菜单中完整存在，仅需加 hover 三点第二入口）。

**Tech Stack:** React 18.3 + jotai（atomWithStorage）+ Tailwind + bun:test（happy-dom）。

**Spec:** `docs/superpowers/specs/2026-08-15-files-panel-tree-resident-design.md`

## Global Constraints

- 工作目录：worktree `D:/workspace/projects/ai-projects/lume/.claude/worktrees/fix-right-panel-resize`（分支 `fix-right-panel-resize`）
- bun 仓库：测试 `bun test <path>`；typecheck `bun run --filter @lume/web typecheck`
- 保留不动：`previewFileTab/pinPreviewFileTab/clearPreviewFileTab` 函数签名与 openTabs 正式 tab 体系、树行右键菜单既有项、宽模式"树|预览槽并排+treeCollapsed 折叠"
- previewTab 不持久化（既有）；`narrowShowsPreview` 随 preferences（atomWithStorage）持久化
- commit emoji 前缀 + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 每个 task 结束 typecheck 必须绿

## 关键既有代码事实（执行者必读）

- `right-panel-files-state.ts`：`RightPanelActiveItem`（:5-9，含要删的 `{kind:'file-preview'}` :8）；`previewFileTab`（:143-162，:153/:161 两处设 activeItem）；`clearPreviewFileTab`（:175+，:181 回退判断 file-preview）
- `RightPanelTabBar.tsx`：`RightPanelTabItem` file-preview 变体（:42）、`buildRightPanelTabItems` 第 5 参+labels 含 preview（:56-58）、预览项 push、props 四项（previewTab/onActivatePreview/onPinPreview/onClosePreview）、isActive/activate/close 的 file-preview 分支、斜体 span、onDoubleClick
- `RightPanelWorkspace.tsx`：:626 onActivatePreview handler、预览四 props 传参、:737 narrowing（`active.kind === 'file-preview'`）
- `FilesRightPanelWorkspace.tsx`：previewActiveTab（:59 读 activeItem）、showTree（:62）、handleMissing（:88 file-preview 分支）、FileDetailsBar（:140-149 调用 + :174-223 组件定义）、窄模式预览渲染
- `UnifiedFileTree.tsx`：TreeEntryRow 行右键菜单（:726-737，操作集完整：预览/系统打开/文件管理器/复制相对+绝对路径/导出legacy/重命名/移动/删除）、onContextMenu（:710）
- `right-panel-atoms.ts`：`RightPanelFileLayoutPreferences`（:294-297 `{treeWidth; treeCollapsed?}`）

---

### Task 1: 状态层——预览不再占用激活态 + narrowShowsPreview 偏好

**Files:**
- Modify: `apps/web/src/components/right-panel/right-panel-files-state.ts`（:8 变体删、:153/:161、:181）
- Modify: `apps/web/src/atoms/right-panel-atoms.ts`（:294-297）
- Test: `apps/web/src/components/right-panel/right-panel-files-state.test.ts`

**Interfaces:**
- Consumes: 既有 `previewFileTab/pinPreviewFileTab/clearPreviewFileTab`
- Produces:
  - `RightPanelActiveItem` 不再有 `file-preview` 变体（仅 function/file/browser）
  - `previewFileTab(state, input, options?)` **不再修改 activeItem**（签名不变）
  - `clearPreviewFileTab(state)` 回退逻辑简化（activeItem 不可能是 file-preview）
  - `RightPanelFileLayoutPreferences` 新增 `narrowShowsPreview?: boolean`

- [ ] **Step 1: 改写失败测试**

`right-panel-files-state.test.ts` 的 preview tab describe 块中，把所有 `expect(...activeItem).toEqual({ kind: 'file-preview' })` 断言改为**保留原 activeItem**：

```ts
test('previewFileTab 设置预览但不动 activeItem', () => {
  const state = previewFileTab(createThreadFileWorkspace({ fileContextId: 'ctx-1' }, { kind: 'function', type: 'files' }), ref('a.ts'))
  expect(state.previewTab?.target).toEqual({ kind: 'file', ref: ref('a.ts') })
  expect(state.activeItem).toEqual({ kind: 'function', type: 'files' }) // 树常驻：激活态不变
})
```

同块其余用例：凡断言 `activeItem` 为 `{kind:'file-preview'}` 的删掉该断言或改为"不变"断言；`clearPreviewFileTab` 的两个回退用例改为：activeItem 原样保留（不再回退，因为预览从不占激活态）：

```ts
test('clearPreviewFileTab 清预览且不影响 activeItem', () => {
  let state = openFileTab(base(), ref('a.ts'))
  const before = state.activeItem
  state = previewFileTab(state, ref('b.ts'))
  state = clearPreviewFileTab(state)
  expect(state.previewTab).toBeNull()
  expect(state.activeItem).toEqual(before)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/components/right-panel/right-panel-files-state.test.ts`
Expected: FAIL（activeItem 断言不匹配——现实现仍设 file-preview）

- [ ] **Step 3: 实现**

(a) `right-panel-files-state.ts` :8 删 `| { kind: 'file-preview' }`；
(b) `previewFileTab` :153 分支删 `activeItem: { kind: 'file-preview' },` 行；:161 返回值删 `, activeItem: { kind: 'file-preview' }`；
(c) `clearPreviewFileTab` 的 fallback 逻辑简化为直接 `return { ...state, previewTab: null }`（activeItem 原样）；
(d) `right-panel-atoms.ts` :294-297 加字段：

```ts
export interface RightPanelFileLayoutPreferences {
  treeWidth: number
  treeCollapsed?: boolean
  /** 窄面板（<680）树/预览二态：true=预览占满，false/缺省=树占满 */
  narrowShowsPreview?: boolean
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/components/right-panel/right-panel-files-state.test.ts && bun run --filter @lume/web typecheck`
Expected: 状态测试 PASS；typecheck **预期 FAIL**——`file-preview` 在 FilesRightPanelWorkspace/RightPanelWorkspace/RightPanelTabBar 的消费点失配（Task 2/3 修）。若 typecheck 报错仅限这三文件的 kind 比较/变体引用，属预期，记录错误清单后继续；**任何其他文件的报错立即停下排查**。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/right-panel/right-panel-files-state.ts apps/web/src/components/right-panel/right-panel-files-state.test.ts apps/web/src/atoms/right-panel-atoms.ts
git commit -m "✨ feat(web): 预览槽不再占用激活态 + narrowShowsPreview 偏好"
```

---

### Task 2: TabBar 撤预览项与激活分支

**Files:**
- Modify: `apps/web/src/components/right-panel/RightPanelTabBar.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`（:626 handler、预览 props 传参、:737 narrowing）
- Test: `apps/web/src/components/right-panel/RightPanelTabBar.test.ts`

**Interfaces:**
- Consumes: Task 1 后 `RightPanelActiveItem` 无 file-preview 变体
- Produces: TabBar 恢复到"browser/function/file/review 四种 tab"；`buildRightPanelTabItems` 签名回到 `(workspace, fileTabs, reviewOpen, browserTabs = [])`

- [ ] **Step 1: 删测试用例**

`RightPanelTabBar.test.ts` 删除 #55 Task 2 加的 4 个预览项用例（含 `preview:...` id 构造的用例），保留其余。

- [ ] **Step 2: 实现（纯撤销）**

`RightPanelTabBar.tsx`：
- `RightPanelTabItem`（:42）删 `| { kind: 'file-preview'; id: string; tab: RightPanelFileTab; label: string }`
- `buildRightPanelTabItems` 签名删第 5 参 `previewTab`；labels 行回到 `disambiguateFileTabLabels(fileTabs)`；删预览项 push 行
- Props 删 `previewTab/onActivatePreview/onPinPreview/onClosePreview` 四项
- items memo 依赖删 `props.previewTab`
- `isActive`/`activate`/`close` 删 file-preview 分支
- label span 的 `item.kind === 'file-preview' && 'italic'` 条件删（恢复原 span）
- 外层 div 的 `onDoubleClick` 整个删（仅预览使用）
- title/图标三元里的 `|| item.kind === 'file-preview'` 条件删（回到仅 file）

`RightPanelWorkspace.tsx`：
- :626 附近 `onActivatePreview` handler 整段删；`previewTab={...}`/`onPinPreview`/`onClosePreview` 传参删
- :737 narrowing 改回 `if (active.kind === 'file' || active.type === 'files') {`
- import 若 `pinPreviewFileTab` 因此不再使用则删该 import（`clearPreviewFileTab` 在 Task 3 仍可能用——保留前先 grep）

- [ ] **Step 3: 验证**

Run: `bun test apps/web/src/components/right-panel/RightPanelTabBar.test.ts && bun run --filter @lume/web typecheck`
Expected: TabBar 测试 PASS；typecheck 仅剩 `FilesRightPanelWorkspace.tsx` 的 file-preview 失配（Task 3 修）

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/right-panel/RightPanelTabBar.tsx apps/web/src/components/right-panel/RightPanelWorkspace.tsx apps/web/src/components/right-panel/RightPanelTabBar.test.ts
git commit -m "🔥 remove(web): TabBar 撤预览项(预览降级为工作区内部单槽)"
```

---

### Task 3: 面板布局——预览槽常驻渲染 + 窄模式二态切换 + 预览槽头部

**Files:**
- Modify: `apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx`（:59/:62/:88 + 预览槽头部 + 布局分支）
- Test: `apps/web/src/components/right-panel/FilesRightPanelWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `narrowShowsPreview` 偏好与"previewFileTab 不动 activeItem"；`workspace.previewTab`
- Produces: 窄模式 `showTree` 语义 = `!treeCollapsed && (wide || !narrowShowsPreview)`；预览槽头部含窄模式返回钮

- [ ] **Step 1: 改写失败测试**

`FilesRightPanelWorkspace.test.tsx`（既有 3 用例基于 activeItem file-preview 驱动窄模式显示——全部改写为 preference 驱动），替换后的核心用例：

```tsx
test('窄模式: 单击文件(previewTab 设置)后仍显示树,除非 narrowShowsPreview', () => {
  // renderToStaticMarkup 模式下 containerWidth=0 → 恒窄模式
  const ws = previewFileTab(makeWorkspace(), makeRef('a.ts'))
  const markup = renderToStaticMarkup(<FilesRightPanelWorkspace {...makeProps({ workspace: ws })} />)
  // 树可见（默认 narrowShowsPreview 缺省=false），预览容器 hidden
  expect(markup).toContain('aria-label') // 树容器渲染
})
test('窄模式: narrowShowsPreview=true 时预览占满且头部有返回树按钮', () => {
  const ws = previewFileTab(makeWorkspace(), makeRef('a.ts'))
  const markup = renderToStaticMarkup(<FilesRightPanelWorkspace {...makeProps({ workspace: ws, preferences: { treeWidth: 260, narrowShowsPreview: true } })} />)
  expect(markup).toContain('返回文件树')
})
```

（`makeWorkspace/makeRef/makeProps` 沿用该文件既有测试工厂；props 若无 preferences 注入口则给组件加可选 prop 透传或直接用 jotai 默认——以现有工厂模式为准改写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/components/right-panel/FilesRightPanelWorkspace.test.tsx`
Expected: FAIL（现实现无 narrowShowsPreview 逻辑/无返回钮）

- [ ] **Step 3: 实现**

`FilesRightPanelWorkspace.tsx`：
(a) :59 `previewActiveTab` 改为不再看 activeItem：`const previewActiveTab = workspace.previewTab`（预览槽常驻，激活哪个 tab 都显示在槽里）；
(b) :62 `showTree` 改：`const showTree = !treeCollapsed && (wide || !preferences.narrowShowsPreview)`；
(c) 窄模式单击文件要置 `narrowShowsPreview=true`、返回树置 false——在 `UnifiedFileTree` 的 select 路径联动：给 `FilesRightPanelWorkspace` 包一层（或传 prop）：树 `onWorkspaceChange` 回调里检测 `next.previewTab !== current.previewTab && next.previewTab` 时 `setPreferences(p => ({...p, narrowShowsPreview: true}))`（宽模式忽略）；实现选最小侵入：在现有 `onWorkspaceChange` 包装处做 diff；
(d) 预览槽头部：在预览容器（:151-153 的 flex-1 div）内、`RightPanelFilePreview`/`McpResourcePreview` 外包一层纵向 flex，头部一行（`h-9`）：

```tsx
{previewTarget && (
  <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2.5 text-[11px]">
    {!wide && (
      <Button variant="ghost" size="icon-sm" className="size-5" title="返回文件树"
        onClick={() => setPreferences((current) => ({ ...current, narrowShowsPreview: false }))}>
        <PanelLeftClose size={13} />
      </Button>
    )}
    <span className="min-w-0 flex-1 truncate text-foreground/60" title={`${previewRef?.source} · ${previewRef?.relativePath}`}>
      {previewRef?.relativePath ?? previewTarget.kind}
    </span>
    {selectedEntry && !selectedEntry.isDirectory && (
      <span className="shrink-0 text-[10px] text-foreground/45" title="文件信息">
        {fileType(previewRef!.relativePath)}{selectedEntry.size !== undefined ? ` · ${formatBytes(selectedEntry.size)}` : ''}{selectedEntry.modifiedAt ? ` · ${new Date(selectedEntry.modifiedAt).toLocaleString()}` : ''}
      </span>
    )}
  </div>
)}
```

（`fileType/formatBytes` 从 FileDetailsBar 定义移到文件顶部保留；`PanelLeftClose` 从 lucide-react 引入。注意 `RightPanelFilePreview` 自带 h-10 头部（:365/:384）与该头部并存时视觉重复——本任务将新头部作为唯一外层（文件名+元信息+返回），`RightPanelFilePreview` 若有 `disableHeader` 类 prop（:545 出现过）则透传关闭其自带头部；无该 prop 则保留其头部不动，只加返回钮行（择一，实施时以最小视觉重复为准并在报告注明选择）。）
(e) :88 `handleMissing` 简化：`if (workspaceRef.current.previewTab && <缺失 ref 匹配 previewTab>)`——判断改为匹配 previewTab 的 ref 后 `clearPreviewFileTab`（保留），file-preview activeItem 判断删。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/components/right-panel/ && bun run --filter @lume/web typecheck`
Expected: 全绿 + typecheck exit 0（file-preview 消费点全部清零）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx apps/web/src/components/right-panel/FilesRightPanelWorkspace.test.tsx
git commit -m "✨ feat(web): 预览槽常驻+窄模式二态切换+预览槽头部(返回树/元信息)"
```

---

### Task 4: 废 FileDetailsBar + 行尾 hover 三点入口

**Files:**
- Modify: `apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx`（删 :140-149 调用与 :174-223 组件）
- Modify: `apps/web/src/components/right-panel/UnifiedFileTree.tsx`（TreeEntryRow 行尾 hover 三点）
- Test: 既有测试回归（无新增断言文件；行尾按钮在 Task 3 测试文件可加一条可选断言）

**Interfaces:**
- Consumes: 既有行右键菜单（:726-737 完整操作集）与 `menuOpen` state
- Produces: 同一 DropdownMenu 双入口（右键 + 行尾 hover 三点）

- [ ] **Step 1: 实现**

(a) `FilesRightPanelWorkspace.tsx` 删 FileDetailsBar 整个组件定义（:174-223）与窄模式调用（:140-149）；`fileType/formatBytes` 若 Task 3 已移至顶部则保留，否则随本任务移到文件顶部（供预览槽头部用）；`ChevronDown/ExternalLink/FolderSearch/Copy/MoreHorizontal` 等 import 按需清理（`MoreHorizontal` 树文件用，本文件删净）。
(b) `UnifiedFileTree.tsx` TreeEntryRow：行内展开箭头按钮（:722 附近）之后追加 hover 三点（与右键同一 `menuOpen`）：

```tsx
<Button variant="ghost" size="icon-sm" className={cn('size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100', menuOpen && 'opacity-100')}
  onClick={(event) => { event.stopPropagation(); setMenuOpen(true) }}
  title="文件操作">
  <MoreHorizontal size={12} />
</Button>
```

（行容器已有 `group` class 的假设需验证——若无需加 `group`。`MoreHorizontal` 已在该文件 import 或补引。）

- [ ] **Step 2: 验证**

Run: `bun test apps/web/src/components/right-panel/ && bun run --filter @lume/web typecheck`
Expected: 全绿（FileDetailsBar 无既有专测；`grep -rn "FileDetailsBar" apps/web/src` 计数 0）

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/right-panel/FilesRightPanelWorkspace.tsx apps/web/src/components/right-panel/UnifiedFileTree.tsx
git commit -m "🔥 remove(web): 废底部 FileDetailsBar,行内 hover 三点作第二菜单入口"
```

---

### Task 5: 全量回归 + HMR 实机验证 + push + PR 更新

**Files:** 无新改动

- [ ] **Step 1: 全量回归**

Run: `bun test apps/web/src/ && bun run --filter @lume/web typecheck`
Expected: 失败集与 main 基线一致（预存失败不新增）；typecheck 0

- [ ] **Step 2: HMR 同步 + 实机验证清单**

```bash
cd D:/workspace/projects/ai-projects/lume
for f in FilesRightPanelWorkspace.tsx RightPanelTabBar.tsx RightPanelWorkspace.tsx UnifiedFileTree.tsx right-panel-files-state.ts; do
  cp ".claude/worktrees/fix-right-panel-resize/apps/web/src/components/right-panel/$f" "apps/web/src/components/right-panel/$f"
done
cp ".claude/worktrees/fix-right-panel-resize/apps/web/src/atoms/right-panel-atoms.ts" "apps/web/src/atoms/right-panel-atoms.ts"
```

（注意：此前发生过主仓未提交副本被 stash 吞掉——同步后立即 `grep -c narrowShowsPreview apps/web/src/atoms/right-panel-atoms.ts` 确认=1 再让用户验证。）

用户验证清单：
1. 宽模式：单击文件 → 右侧预览槽显示，**TabBar 高亮不动**，树不动
2. 连续单击多文件 → 预览槽单槽替换
3. 双击/预览内编辑 → 升格正式 tab；回"文件"功能 tab → 树+预览槽原样
4. 窄模式：单击文件 → 预览占满 + 左上"返回文件树"钮 → 点回树
5. 底部无 FileDetailsBar；行 hover 出三点，菜单含全部操作
6. 重启 → 正式 tab 保留、预览槽清空

- [ ] **Step 3: push + PR 更新**

```bash
cd .claude/worktrees/fix-right-panel-resize && git push
```

`gh pr edit 83 --body` 在预览 Tab 段落后追加"树常驻重设计"段（模型转变说明 + 本节验证点）。

- [ ] **Step 4: 用户确认后清理主 checkout 临时副本**

```bash
cd D:/workspace/projects/ai-projects/lume && git checkout -- apps/web/src/components/right-panel/ apps/web/src/atoms/right-panel-atoms.ts
```

---

## Self-Review 记录

- **Spec 覆盖**：交互表 5 行 → Task 1(不动 activeItem)/Task 2(TabBar 撤)/Task 3(升格既有+预览槽头部+二态)；布局宽窄 → Task 3(b)(c)(d)；FileDetailsBar 废+菜单 → Task 4；撤销清单 → Task 1(a-c)/Task 2 全部/Task 3(e)；测试节 → 各 task 内嵌+Task 5 清单 ✅
- **占位符**：Task 3(d) 头部与 RightPanelFilePreview 自带头部并存的处理给了明确决策规则（disableHeader 优先，否则仅返回钮行，报告注明）✅；Task 3 Step 1 测试代码依赖既有工厂以"该文件现有工厂模式为准"——文件已存在 3 用例（Task 3 前置），非空洞 ✅
- **类型一致性**：`narrowShowsPreview` 命名贯穿 Task 1(d)/Task 3(b)(c)/Task 5；`previewActiveTab` 语义变化在 Task 3(a) 单点定义 ✅
