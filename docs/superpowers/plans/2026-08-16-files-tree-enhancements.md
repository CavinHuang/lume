# 文件树三增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三增强——①session/memory/legacy 条目复制式晋升到项目根 ②搜索结果行内来源 badge + 组头计数四组统一 ③外部目录引用式附加（双作用域迷你树）。

**Architecture:** ①②为既有流程增强（新 sidecar 通道 + 菜单项 + 渲染）；③为新子系统（external-dirs.json 元数据 + 四个只读/元数据通道 + 树外迷你树区块），存储模式照抄 attachment-meta-service 的双作用域原子写。

**Tech Stack:** React 18.3 + jotai + zod schema + bun:test（组件断言必须 mock 无关——见 61fde147 先例）。

**Spec:** `docs/superpowers/specs/2026-08-16-files-tree-enhancements-design.md`

## Global Constraints

- 工作目录：worktree `D:/workspace/projects/ai-projects/lume/.claude/worktrees/feat-files-tree-enhancements`（分支 `feat-files-tree-enhancements`）
- bun 仓库：`bun test <path>`；typecheck `bun run --filter @lume/web typecheck`（web 改动）/ `bun run --filter @lume/sidecar typecheck`（sidecar/shared 改动）；每 task 结束相关 typecheck 必须 exit 0
- 晋升固定 `conflict: 'error'`；旧 `EXPORT_LEGACY_RESOURCE_TO_PROJECT` channel 与实现保留，仅前端菜单不再调用
- 附加目录引用式只读：不复制、条目无 rename/move/delete/晋升；新元数据 `external-dirs.json` 键=绝对路径
- commit emoji 前缀 + `Co-Authored-By: Claude <noreply@anthropic.com>`

## 关键既有代码事实（执行者必读，行号为当前 worktree）

- channel 常量：`packages/shared/src/types/agent.ts` `AGENT_IPC_CHANNELS` 对象；文件树块 :2217-2239；`EXPORT_LEGACY_RESOURCE_TO_PROJECT: 'agent:export-legacy-resource-to-project'` :2196
- handler 模式：`apps/sidecar/src/rpc/agent-handlers.ts` `[AGENT_IPC_CHANNELS.X]: async (params) => { const input = validateInput(schema, params, AGENT_IPC_CHANNELS.X); return fn(...) }`（EXPORT :1417-1424 / RENAME :1913-1915）
- 晋升实现模板：`agent-files-service.ts` `exportLegacyResourceToProject` :966-1005（staging cpSync + rename 原子落盘 + `assertLegacyExportSourceSafe` :955-965 symlink 防护 + `resolveExistingProjectTarget(workspaceSlug)` + `isWithin` + `resolveSafePathWithin`）
- schema 模式：`apps/sidecar/src/rpc/schemas.ts` `legacyResourceExportInputSchema` :1205-1209
- FileRef 三 source 根解析：`agent-files-service.ts` `resolveFileRefRoot` :338-350（session=agent-file-contexts、memory=memory dirs、legacy=workspace resources）
- attachment-meta 模式：`agent-attachment-meta-service.ts`——`AttachmentScope` 判别联合 :17-29、原子写 :137-149、按作用域定路径 :79-92
- web：`UnifiedFileTree.tsx`（964 行）组头计数 :638、行菜单 :796-806、exportLegacy 调用+stale+toast :484-498、搜索行=同一 `TreeEntryRow` `showPath` :789、拖出 :758/:762-766、`refreshSource` :502-521；`unified-file-tree-state.ts` `markSourceStale` :54-56；`openFolderDialog` 已有 `apps/web/src/lib/desktop-api/native.ts:68`
- web→sidecar：`sidecarCall<Ret>(AGENT_IPC_CHANNELS.X, params)`（UnifiedFileTree.tsx:419 示例）

---

### Task 1: shared + sidecar 晋升通道

**Files:**
- Modify: `packages/shared/src/types/agent.ts`（:2196 附近加 channel）
- Modify: `apps/sidecar/src/rpc/schemas.ts`（:1209 后加 schema）
- Modify: `apps/sidecar/src/services/agent/agent-files-service.ts`（:1005 后加函数）
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`（:1915 后加 handler）
- Test: `apps/sidecar/src/services/agent/agent-files-service.test.ts`（若无此文件则创建同名，参照同目录既有 service 测试模式）

**Interfaces:**
- Produces:
  - channel `PROMOTE_FILE_REF_TO_PROJECT: 'agent:promote-file-ref-to-project'`
  - schema `promoteFileRefInputSchema = z.object({ ref: fileRefSchema, workspaceSlug: idSchema })`（fileRefSchema 用 schemas.ts 既有 FileRef schema 名——实现时 grep 确认实际名）
  - `promoteFileRefToProject(ref: FileRef, workspaceSlug: string): { ok: true; path: string }`（agent-files-service 导出）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('promoteFileRefToProject', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lume-promote-'))
    // 布置：伪造 scope 根与 project 根的结构由测试通过环境变量/注入实现——
    // 实现时先读 agent-files-service.test.ts 既有测试怎么构造 workspace/project 根（若该文件
    // 已有 exportLegacyResourceToProject 的测试，照抄其夹具；没有则在函数实现里以依赖注入
    // 或 config-dir 环境变量搭建，以既有测试模式为准）
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('session 文件复制到项目根且源保留', () => {
    // 断言 promoteFileRefToProject(sessionRef, slug) 返回 { ok: true, path }
    // 且 existsSync(源) === true、existsSync(目标) === true
  })
  test('memory 条目可晋升', () => { /* 同上，memory ref */ })
  test('project 自身 ref 拒绝', () => { /* expect(() => ...).toThrow('项目') */ })
  test('同名冲突报错不覆盖', () => { /* 目标已存在 → throw '已存在同名' */ })
  test('目标不存在 project 根报错', () => { /* resolveExistingProjectTarget 抛错路径 */ })
})
```

（测试夹具构造以同文件既有 exportLegacy/resource 测试的实际模式为准——先读再写，禁止自造环境变量约定。）

- [ ] **Step 2: 跑测试确认失败** — `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts` → FAIL（函数不存在）

- [ ] **Step 3: 实现**

(a) `agent.ts` EXPORT 行后：
```ts
/** 将 session/memory/legacy 条目复制晋升到项目根（源保留，同名报错） */
PROMOTE_FILE_REF_TO_PROJECT: 'agent:promote-file-ref-to-project',
```

(b) `schemas.ts`：
```ts
export const promoteFileRefInputSchema = z.object({
  ref: fileRefInputSchema,
  workspaceSlug: idSchema,
});
```
（`fileRefInputSchema` 名以文件内既有 FileRef schema 实际导出名为准。）

(c) `agent-files-service.ts`（exportLegacyResourceToProject 后）：
```ts
/** 复制式晋升：session/memory/legacy → project 根，源保留，同名报错。 */
export function promoteFileRefToProject(ref: FileRef, workspaceSlug: string): { ok: true; path: string } {
  if (ref.source === 'project') throw new Error('项目文件无需晋升')
  if (ref.source === 'mcp-resource' as unknown) throw new Error('该来源不支持晋升')
  const rootPath = resolveFileRefRoot(ref)
  const lexicalSource = resolveSafePathWithin(rootPath, ref.relativePath, '源路径超出来源目录')
  if (!existsSync(lexicalSource)) throw new Error('源文件不存在')
  assertLegacyExportSourceSafe(lexicalSource) // symlink 防护复用（改名不必要，逻辑通用）
  const source = realpathSync(lexicalSource)
  if (!isWithin(realpathSync(rootPath), source)) throw new Error('源路径超出来源目录')
  const projectRoot = resolveExistingProjectTarget(workspaceSlug)
  const destination = join(projectRoot, basename(source))
  if (existsSync(destination)) throw new Error('项目目录已存在同名文件，未覆盖任何内容')
  const staging = join(projectRoot, `.lume-promote-${randomUUID()}`)
  try {
    cpSync(source, staging, { recursive: statSync(source).isDirectory(), errorOnExist: true,
      filter: (p) => { assertLegacyExportSourceSafe(p); return true } })
    if (!isWithin(projectRoot, realpathSync(staging))) throw new Error('晋升目标超出项目目录')
    renameSync(staging, destination)
    return { ok: true, path: destination }
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error }
}
```
（`resolveFileRefRoot(ref)` 的实际签名以 :338-350 原文为准——它可能接收 source+scopeId 而非整个 ref，照实际调整；memory 的 scopeId（'global'/'workspace:slug'）其内部已处理。）

(d) `agent-handlers.ts` RENAME handler 后：
```ts
[AGENT_IPC_CHANNELS.PROMOTE_FILE_REF_TO_PROJECT]: async (params) => {
  const input = validateInput(promoteFileRefInputSchema, params, AGENT_IPC_CHANNELS.PROMOTE_FILE_REF_TO_PROJECT);
  return promoteFileRefToProject(input.ref, input.workspaceSlug);
},
```

- [ ] **Step 4: 跑测试确认通过** — service 测试 PASS + `bun run --filter @lume/sidecar typecheck` exit 0

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/types/agent.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/services/agent/agent-files-service.ts apps/sidecar/src/services/agent/agent-files-service.test.ts apps/sidecar/src/rpc/agent-handlers.ts
git commit -m "✨ feat(sidecar,shared): 晋升通道 promoteFileRefToProject(三 source 复制到项目根)"
```

---

### Task 2: web 晋升菜单项

**Files:**
- Modify: `apps/web/src/components/right-panel/UnifiedFileTree.tsx`（行菜单 :796-806 区、exportLegacy 逻辑 :484-498 区）
- Test: `apps/web/src/components/right-panel/unified-file-tree-state.test.ts`（若菜单条件为纯函数则加状态测试；组件级断言用 FilesRightPanelWorkspace.test.tsx 模式 renderToStaticMarkup 不适用菜单——以 mock 无关的纯逻辑测试为准）

**Interfaces:**
- Consumes: Task 1 的 channel 与 `{ ref, workspaceSlug }` 入参
- Produces: 行菜单「晋升到项目」（source ∈ {session,memory,legacy} 时显示，legacy 旧「导出到项目（不覆盖）」项删除）

- [ ] **Step 1: 写失败测试** — 在 unified-file-tree-state.test.ts 加纯逻辑测试（若菜单条件内联在 JSX 则先抽 `canPromoteToProject(source: FileSource): boolean` 到 unified-file-tree-state.ts）：
```ts
test('canPromoteToProject 仅 session/memory/legacy', () => {
  expect(canPromoteToProject('session')).toBeTrue()
  expect(canPromoteToProject('memory')).toBeTrue()
  expect(canPromoteToProject('legacy')).toBeTrue()
  expect(canPromoteToProject('project')).toBeFalse()
})
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现** —
(a) `unified-file-tree-state.ts` 加 `export function canPromoteToProject(source: FileSource): boolean { return source === 'session' || source === 'memory' || source === 'legacy' }`
(b) UnifiedFileTree：把 `mutateExportLegacy`（:484-498 附近）泛化为 `mutatePromote(entry)`——`sidecarCall(AGENT_IPC_CHANNELS.PROMOTE_FILE_REF_TO_PROJECT, { ref: entry.ref, workspaceSlug: <现 exportLegacy 取 scopeId 的同源逻辑> })`，成功后 `markSourceStale(current, 'project')`（改用 unified-file-tree-state 的 helper，替换现在内联的 sourceStatus 展开）+ toast `已晋升到项目；项目文件已标记为有更新`；失败 toast error.message
(c) 菜单：删 :802 的 legacy 导出项，替换为 `{canPromoteToProject(entry.ref.source) && <DropdownMenuItem onSelect={() => void mutatePromote(entry)}>晋升到项目</DropdownMenuItem>}`（tooltip 经 title 或菜单文案自带说明）
(d) import 清理：EXPORT channel 引用删（onExportLegacy prop 整条链若仅此使用则一并清理——grep 确认 FilesRightPanelWorkspace 传参侧）

- [ ] **Step 4: 验证** — `bun test apps/web/src/components/right-panel/` PASS + web typecheck 0

- [ ] **Step 5: Commit** — `✨ feat(web): 行菜单「晋升到项目」(三 source,替换 legacy 导出项)`

---

### Task 3: 搜索 badge + 组头计数统一

**Files:**
- Modify: `apps/web/src/components/right-panel/UnifiedFileTree.tsx`（:638 组头条件、:789 showPath 渲染处）

**Interfaces:** 无新接口（纯渲染）

- [ ] **Step 1: 实现**（小改动，测试以既有组件测试回归 + 手动 HMR 验证为准；若要断言，TreeEntryRow 已被 FilesRightPanelWorkspace.test.tsx 覆盖不到——本 task 免新测试，依赖 Task 6 实机清单）

(a) :638 组头计数去掉条件：`<span className="text-foreground/38">{entries.length}</span>`（四组统一）
(b) TreeEntryRow :789 showPath 渲染旁加搜索态 badge（showPath 即搜索态信号）：
```tsx
{props.showPath && (
  <span className="shrink-0 rounded bg-foreground/6 px-1 text-[9px] leading-4 text-foreground/45">
    {SOURCE_BADGE_LABEL[entry.ref.source]}
  </span>
)}
```
顶部常量：`const SOURCE_BADGE_LABEL: Record<FileSource, string> = { project: '项目', session: '会话', memory: '记忆', legacy: '旧版' }`

- [ ] **Step 2: 验证** — right-panel 测试 PASS + web typecheck 0

- [ ] **Step 3: Commit** — `✨ feat(web): 搜索结果来源 badge + 组头计数四组统一`

---

### Task 4: sidecar external-dirs 元数据 + 四通道

**Files:**
- Create: `apps/sidecar/src/services/agent/external-dirs-service.ts`
- Modify: `packages/shared/src/types/agent.ts`（四 channel）
- Modify: `apps/sidecar/src/rpc/schemas.ts` + `agent-handlers.ts`
- Test: `apps/sidecar/src/services/agent/external-dirs-service.test.ts`

**Interfaces:**
- Produces:
  - channels：`LIST_EXTERNAL_DIRS`/`ADD_EXTERNAL_DIR`/`REMOVE_EXTERNAL_DIR`/`LIST_EXTERNAL_DIR_ENTRIES`（`agent:list-external-dirs` 等）
  - `listExternalDirs(scope: AttachmentScope): ExternalDirEntry[]`，`ExternalDirEntry = { absolutePath: string; attachedAt: string }`
  - `upsertExternalDir(scope: AttachmentScope, absolutePath: string): void`（校验存在+目录+非 symlink）
  - `removeExternalDir(scope: AttachmentScope, absolutePath: string): void`
  - `listExternalDirEntries(absolutePath: string): Array<{ name: string; isDirectory: boolean; size?: number; modifiedAt?: string }>`（只读、拒绝 symlink、单层）

- [ ] **Step 1: 写失败测试**（夹具用 mkdtemp 真目录；AttachmentScope 复用 attachment-meta-service 的导出类型）：
```ts
test('upsert/list/remove 双作用域读写与去重', () => { /* thread 与 workspace 两份 JSON 互不可见；同 path 二次 upsert 只留一条（attachedAt 更新） */ })
test('upsert 拒绝非目录与不存在路径', () => { /* file → throw '只能附加目录'；不存在 → throw */ })
test('remove 不动物理目录', () => { /* 删元数据后 existsSync(dir) === true */ })
test('listExternalDirEntries 单层只读', () => { /* 返回 name/isDirectory；symlink 子项被过滤 */ })
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现** — external-dirs-service.ts（存储：thread=`<configDir>/agent-workspaces/<slug>/<threadId 或 fileContextId>/.context/external-dirs.json`——路径解析照抄 attachment-meta-service :79-92 的作用域定位函数，实现时直接复用其内部定位 helper 或以同逻辑重写；写=读-改-`.tmp`-rename 原子写 :137-149 模式）；channels/schema/handler 按 Task 1 模式（schema：`externalDirScopeInputSchema = z.discriminatedUnion('kind', [z.object({kind: z.literal('thread'), workspaceSlug, threadId, fileContextId: z.string().optional()}), z.object({kind: z.literal('workspace'), workspaceSlug})])`；entries schema `{ absolutePath: z.string().min(1).max(4096) }`）

- [ ] **Step 4: 验证** — service 测试 PASS + sidecar typecheck 0

- [ ] **Step 5: Commit** — `✨ feat(sidecar,shared): external-dirs 引用式附加元数据+四通道`

---

### Task 5: web 附加目录迷你树

**Files:**
- Create: `apps/web/src/components/right-panel/ExternalDirsSection.tsx`
- Modify: `apps/web/src/components/right-panel/UnifiedFileTree.tsx`（工具条按钮+树尾挂载+drop）
- Test: `apps/web/src/components/right-panel/ExternalDirsSection.test.tsx`（renderToStaticMarkup + mock 无关断言）

**Interfaces:**
- Consumes: Task 4 四通道 + `openFolderDialog`（native.ts:68）+ `sidecarCall`
- Produces: `<ExternalDirsSection workspaceSlug={...} threadId={...} fileContextId={...} onOpenInSystem={...} onRevealInSystem={...} />`（props 以 UnifiedFileTree 现有可用量为准）

- [ ] **Step 1: 写失败测试**（mock sidecarCall 返回双作用域清单）：
```tsx
test('双作用域清单渲染：会话与共享小节 + 根行折叠 + ✕ + 共享 badge', () => {
  const markup = renderToStaticMarkup(<ExternalDirsSection {...props} dirs={{
    thread: [{ absolutePath: 'D:\\refs\\a', attachedAt: '2026-08-16T00:00:00Z' }],
    workspace: [{ absolutePath: 'E:\\shared\\b', attachedAt: '2026-08-16T00:00:00Z' }],
  }} />)
  expect(markup).toContain('附加目录（会话）')
  expect(markup).toContain('附加目录（工作区）')
  expect(markup).toContain('共享')
  expect(markup).toContain('D:\\refs\\a')
})
test('不可用目录渲染「路径不可用」', () => { /* exists 标记由 listExternalDirs 返回的 available 字段（实现时在 service 返回体加 `available: boolean`）驱动 */ })
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现** —
(a) `ExternalDirsSection.tsx`：两小节（会话/工作区·共享）；每目录一行根（`ChevronDown` 折叠 + Folder 图标 + 绝对路径 + hover ✕ `stopPropagation` 调 REMOVE 后刷新清单）；展开时 `LIST_EXTERNAL_DIR_ENTRIES` 懒加载子项（本地 useState 缓存 `Record<absolutePath, entries[]>`）；子项行=图标+name（目录可再展开一层或递归同构——v1 递归复用同一行组件）；行操作 hover 三点：系统打开/在文件管理器中显示/复制路径（只读集）
(b) UnifiedFileTree：工具条加 `FolderPlus` 图标按钮（desktop-only，`openFolderDialog()` 返回 path 后弹小菜单选作用域——用简单 `DropdownMenu` 包按钮：菜单两项「附加到本会话/附加到此工作区」，选择后再开目录对话框）+ 树容器 `onDragOver={e => e.preventDefault()}` `onDrop`（读 `e.dataTransfer.files[0].path`（Electron 提供）为目录则 ADD thread 作用域）
(c) 挂载点：四组渲染循环之后 `{!query && <ExternalDirsSection ... />}`（搜索态隐藏）

- [ ] **Step 4: 验证** — 组件测试 PASS + right-panel 全绿 + web typecheck 0

- [ ] **Step 5: Commit** — `✨ feat(web): 附加目录迷你树(双作用域/引用只读/按钮+拖拽入口)`

---

### Task 6: 回归 + push + PR + HMR 实机验证

- [ ] **Step 1**: `bun test apps/web/src/ && bun test apps/sidecar/src/`（失败集对 main 基线不新增）+ 双 typecheck 0
- [ ] **Step 2**: `git push -u origin feat-files-tree-enhancements` + `gh pr create`（base main，body 含三增强说明 + spec 链接 + Closes 无 issue）
- [ ] **Step 3**: HMR 同步主 checkout（改动文件 cp——**同步后立即 grep 验证落盘**，防 stash 吞副本事故重演），实机清单：
  1. session/memory/legacy 条目右键「晋升到项目」→ toast → 项目组头「有更新」→ 刷新见新文件、源仍在
  2. project 条目无此项；同名冲突 toast 报错不覆盖
  3. 搜索混排显示四色 badge；组头四组计数
  4. 「附加目录」按钮选目录（会话/工作区两作用域）→ mini tree 出现；拖文件夹到树=会话级附加
  5. 展开/折叠/✕ 移除（物理目录仍在）；重启后面板记住附加清单
  6. 外部条目菜单只有只读四项
- [ ] **Step 4**: 用户确认后清理主 checkout 临时副本

---

## Self-Review 记录

- **Spec 覆盖**：①通道/菜单/刷新链 → T1/T2；conflict:'error' 固定 → T1 测试用例 4；②badge/计数 → T3；③元数据/通道/mini tree/入口/只读/持久化 → T4/T5；测试节 → 各 task + T6 清单 ✅
- **占位符**：T1 测试夹具"以既有测试模式为准"（文件存在与否未验证——执行者先读再写，若文件不存在则创建并自建夹具，计划已声明）；`fileRefInputSchema` 名以实际导出为准（grep 指令已给）——均为对照式适配指令 ✅
- **类型一致性**：`canPromoteToProject`/`ExternalDirEntry`/`AttachmentScope`（复用既有导出）跨 task 一致；channel 命名与 spec 修正版一致（LIST_EXTERNAL_DIRS/LIST_EXTERNAL_DIR_ENTRIES/ADD/REMOVE）✅
