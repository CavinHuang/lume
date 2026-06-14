# 文件链接右键菜单设计

- **日期**：2026-06-14
- **状态**：待评审
- **分支**：`feat/new-ui`

## 1. 背景与目标

Lume 的消息流里已存在「文件链接」机制：markdown 行内相对路径（如 `src/App.tsx`、`plans/research.md`）经 `thread-file-links.ts` 识别后，渲染成可点击的紫色胶囊，**当前唯一交互是「单击 → 右侧预览」**。消息附件卡片共享同一个打开入口。

目标：为「文件链接」补一组**只读**右键菜单动作（预览 / 系统打开 / Finder 显示 / 复制路径 / 另存为），覆盖对话流、右侧文件树、文件预览区三处。

## 2. 范围

右键菜单挂在以下四类位置：

| # | 位置 | 路径来源 |
|---|------|---------|
| A | 对话流胶囊（`MarkdownCode`） | thread |
| B | 消息附件卡片（`AgentAttachmentGrid`） | thread |
| C | 右侧文件树（`WorkspaceFileBrowser` 项） | workspace |
| D | 文件预览区（`FilePreviewTabView` 标题区） | 动态（thread / workspace / local） |

菜单动作（已与用户确认，固定为「只读六件套」）：

1. 在右侧预览（仅 `onPreview` 存在时出现）
2. 用系统默认应用打开
3. 在 Finder / 资源管理器中显示
4. 复制相对路径（local 来源隐藏）
5. 复制绝对路径
6. 另存为…

## 3. 非目标

- **不含**写操作（重命名 / 删除 / 移动）——无二次确认、无写 IPC。
- **不含**「提升到工作区」（`PROMOTE_FILE_TO_WORKSPACE`）。
- 不在菜单打开时预检文件存在性（文件状态实时变，失败时 toast 即可）。

## 4. 现状（已有基础设施，本次复用）

- **右键菜单组件**：`apps/web/src/components/ui/context-menu.tsx`（base-ui 封装），样板见 `apps/web/src/components/app-shell/ThreadItem.tsx`。
- **文件链接识别**：`apps/web/src/components/agent/thread-file-links.ts`（`normalizeThreadFilePathCandidate`）。
- **胶囊渲染**：`apps/web/src/components/agent/RuntimeEventContentBlock.tsx:949`（`MarkdownCode`）。
- **附件卡片**：`apps/web/src/components/agent/AgentAttachmentGrid.tsx`（`threadPath?: string`）。
- **环境信息**：`AgentView` 已持有 `threadId`（props）与 `workspaceSlug`（`AgentView.tsx:51-55` useMemo）。
- **路径解析 IPC**：`GET_THREAD_PATH`（`agent-handlers.ts:1004`，返回 thread 目录）、`GET_WORKSPACE_RESOURCES_PATH`（`:1429`，返回工作区共享目录）。
- **原生文件 API**：`native.ts` 的 `openInSystem` / `revealPathInSystem` / `saveFilePathDialog`。
- **Toast**：`sonner`（`AgentView` 已用）。

## 5. 设计

### 5.1 核心抽象（三个文件）

**① 路径上下文类型** `file-link-types.ts`

```ts
export type FileLinkSource = "thread" | "workspace" | "local"

export interface FileLinkContext {
  source: FileLinkSource
  relPath: string          // thread/workspace 内相对路径；local 时即绝对路径
  threadId?: string        // source === "thread" 时必填
  workspaceSlug?: string   // source === "thread" | "workspace" 时必填
}
```

**② 动作层** `file-link-actions.ts`（纯逻辑，可单测）

```ts
export function resolveFileLinkActions(ctx: FileLinkContext): FileLinkActions
// 返回 5 个动作：openInSystem / revealInFolder / copyRelativePath / copyAbsolutePath / saveAs
// 每个动作内部完成 toast（成功/失败），返回 Promise<void>，组件层只 await
```

`preview` 不进动作层——它是 UI 行为（切右侧面板），由组件层注入 `onPreview` 回调直接调。

**③ 共享菜单组件** `components/ui/FileLinkContextMenu.tsx`

```tsx
<FileLinkContextMenu context={ctx} onPreview?: {() => void}>
  <触发元素 />
</FileLinkContextMenu>
```

菜单结构与现有 `ThreadItem` 右键菜单视觉一致：

```
[在右侧预览]          ← 仅 onPreview 存在时出现
─────────────────
[用系统应用打开]
[在 Finder 中显示]    ← Windows: "在资源管理器中显示"
─────────────────
[复制相对路径]        ← source==="local" 时隐藏
[复制绝对路径]
─────────────────
[另存为…]
```

动态规则集中在组件：`local` 隐藏「复制相对路径」；其余动作三类来源都启用。

### 5.2 挂载点接线

**透传：用 React Context，不做 prop drilling**

`onOpenThreadFile` 现沿 ~16 个节点 drill。新增 `threadId`/`workspaceSlug` 若再 drill 会在十几个节点加 prop——机械且易漏。改用轻量 Context 只承载新增的 thread 环境（`onOpenThreadFile` 保持现状不动）：

```tsx
// AgentView 顶层 provide
<ThreadFileEnvProvider value={{ threadId, workspaceSlug }}>
  <AgentMessages ... />
</ThreadFileEnvProvider>

// MarkdownCode / AgentAttachmentGrid 调用点消费
const env = useThreadFileEnv()   // { threadId?, workspaceSlug? }
```

`env` 任一缺失 → 不挂菜单，降级为现状纯触发元素（安全兜底）。

**四类挂载点接线**

| # | 位置 | source | context 构造 | onPreview | 挂菜单条件 |
|---|------|--------|-------------|-----------|-----------|
| A | 胶囊 `MarkdownCode:961` | thread | `{source:'thread', relPath:filePath, ...env}` | `onOpenThreadFile(filePath)` | `env.threadId` 存在 |
| B | 附件卡片 `AgentAttachmentGrid:66` | thread | `{source:'thread', relPath:attachment.threadPath, ...env}` | 图片→`onOpenImage` / 文件→`onOpenFile` | `attachment.threadPath` 存在 |
| C | 文件树 `WorkspaceFileBrowser` 项 | workspace | `{source:'workspace', relPath:file.path, workspaceSlug}` | 现有 `onOpenFile` | 始终 |
| D | 预览区 `FilePreviewTabView` 标题区 | 动态（`tab.fileSource`） | 按 `fileSource` 映射 | **不传**（已在预览，隐藏「预览」项） | 始终 |

每处只是用 `<FileLinkContextMenu>` 包住现有触发元素，触发元素本身（胶囊 button / 卡片 button / 树项 div）不改。

**预览区（D）与现有「更多」下拉的关系**：`FilePreviewTabView:191` 自绘下拉含「复制路径 / 切换增强视图」。
- 「复制路径」→ 移入右键菜单（统一，避免重复）
- 「切换增强视图」→ 留在下拉按钮（预览视图专属动作，不属于文件链接通用动作）

### 5.3 数据流与 IPC

**核心汇聚：`resolveAbsolutePath(ctx)`**——三类来源的统一汇聚点。

```
thread:     GET_THREAD_PATH {threadId, workspaceSlug} → dir ; absPath = join(dir, relPath)
workspace:  GET_WORKSPACE_RESOURCES_PATH {workspaceSlug} → dir ; absPath = join(dir, relPath)
local:      absPath = relPath（已是绝对路径）
```

**六动作数据流**

```
FileLinkContextMenu
 ├─ 在右侧预览      → onPreview()                       [UI 注入回调，零 IPC]
 ├─ 复制相对路径    → clipboard.writeText(ctx.relPath)  [local 隐藏此项]
 │
 ├─ 用系统应用打开 ┐
 ├─ 在 Finder 显示 ├→ resolveAbsolutePath(ctx) ──→ absPath
 ├─ 复制绝对路径   ┤       │
 └─ 另存为…        ┘       ├→ openInSystem(absPath)            [原生 open_in_system]
                          ├→ revealPathInSystem(absPath)       [原生 reveal_path_in_system]
                          ├→ clipboard.writeText(absPath)
                          └→ saveFilePathDialog(basename) → copyFile(absPath, target)  [原生]
```

**关键简化**：后 4 个动作全部基于 `absPath` 用原生 API，**不再按 source 分派** `OPEN_FILE`/`SHOW_IN_FOLDER`/`OPEN_WORKSPACE_FILE`/`SHOW_WORKSPACE_IN_FOLDER` 那套 sidecar channel。

安全性：`absPath` 由 sidecar 的 `GET_THREAD_PATH`/`GET_WORKSPACE_RESOURCES_PATH` 解析，已在合法目录内（`resolveRequiredWorkspaceSlug` + 目录沙箱保证）；`relPath` 来自受控来源（胶囊识别器 / 工作区文件树 / `tab.fileSource`），非用户自由输入。原生 `open_in_system`/`reveal_path_in_system` 直接接 `absPath` 安全。

**IPC 缺口（仅需补 1 项）**

| 需要 | 现状 | 处置 |
|------|------|------|
| 绝对路径解析 | ✅ `GET_THREAD_PATH` / `GET_WORKSPACE_RESOURCES_PATH` | 复用 |
| 系统打开 / Finder 显示 | ✅ 原生 `openInSystem` / `revealPathInSystem` | 复用 |
| 复制路径 | ✅ `navigator.clipboard` | 复用 |
| 另存为目标对话框 | ✅ `saveFilePathDialog` | 复用 |
| **文件复制（源→目标）** | ❌ `native.ts` 无 `copyFile` | **新增原生 `copy_file` 命令** |

新增 `copy_file`（Rust `main.rs` + `native.ts` 封装，参照 `open_in_system` 模式）：用于「另存为」，避免为 workspace/local 补一套二进制 base64 读取 channel。

### 5.4 错误处理（集中在动作层）

| 动作 | 失败模式 | 反馈 |
|------|---------|------|
| `resolveAbsolutePath`（后 4 动作前置） | thread/workspace 不存在、slug 无效 | `toast.error("无法解析文件路径")`，中止后续 |
| 系统打开 / Finder 显示 | 文件已删、权限不足 | `toast.error("无法打开：{msg}")` |
| 复制相对/绝对路径 | clipboard 异常（罕见） | 成功 `toast.success("已复制路径")`；失败 `toast.error` |
| 另存为 · 用户取消 | `saveFilePathDialog` 返回 `null` | **静默**，不 toast |
| 另存为 · copyFile 失败 | 目标不可写、磁盘满 | `toast.error("保存失败：{msg}")` |
| 另存为 · 成功 | — | `toast.success("已保存到 {target}")` |

成功反馈只在「无可见副作用」的动作上给（复制路径、另存为）；打开/Finder/预览有可见效果，不 toast。

### 5.5 测试

**`file-link-actions.test.ts`**（纯逻辑，mock `sidecarCall` / 原生 / `toast` / `clipboard`）
- `resolveAbsolutePath`：thread / workspace / local 三类各验证调对 channel + join 正确
- `openInSystem` / `revealInFolder`：先 resolve 再调原生，传 `absPath`
- `copyRelativePath` / `copyAbsolutePath`：clipboard 内容正确
- `saveAs`：成功路径（resolve→dialog→copyFile）；用户取消（dialog 返回 null → 不调 copyFile、无错误 toast）；copyFile 失败 → error toast
- 错误：resolve 失败 → error toast，后续原生调用不触发

**`FileLinkContextMenu.test.tsx`**（组件）
- `onPreview` 存在 → 显示「预览」项；缺失 → 隐藏
- `source==="local"` → 隐藏「复制相对路径」
- env 缺失（`threadId` 无）→ 不渲染菜单（降级为纯触发元素）
- 点击各菜单项调用对应动作（mock `resolveFileLinkActions`）
- **回归保障**：`ContextMenu` 包裹不改变胶囊 `button` 的 `onClick`——单击仍触发 `onOpenThreadFile`（现有 `RuntimeEventContentBlock.markdown-file-link.test.tsx` 必须继续通过）

**透传 Context**（轻量）：`ThreadFileEnvProvider` provide、`useThreadFileEnv` consume，缺省值 `{}`。

## 6. 待核实点（实现时确认）

1. **`copy_file` 实现方式**：新增 Rust 原生命令，还是复用 `@tauri-apps/plugin-fs` 的 `copyFile`（若已集成）。倾向原生命令以与 `native.ts` 风格一致。
2. **`GET_THREAD_PATH` / `GET_WORKSPACE_RESOURCES_PATH` 返回值**：假设返回目录绝对路径字符串，前端 `join(dir, relPath)` 拼文件路径。实现时读 `getAgentThreadPath` / `getWorkspaceResourcesDirectory` 确认。
3. **`AgentAttachmentGrid` 调用点**（`RuntimeEventContentBlock.tsx:306`）能否拿到 thread 环境注入 context——预期从 env Context 取。
4. **`WorkspaceFileBrowser` 文件树项**的 `workspaceSlug` 来源——预期从工作区上下文取。
5. **`tab.fileSource` 枚举到 `FileLinkSource` 的映射**（D 行）：需确认预览区 `fileSource` 的确切取值能映射到 `"thread" | "workspace" | "local"`，否则 D 行 context 构造需补归一化。
6. **`AgentAttachmentGrid` 被 `AgentInput` 复用**：pending 附件（未发送）应无 `threadPath`，靠「挂菜单条件 = `threadPath` 存在」自然过滤。需确认 pending 附件确实不带 `threadPath`，避免误挂菜单。

## 7. 涉及文件清单

**新增**
- `apps/web/src/components/agent/file-link-types.ts`（FileLinkContext 类型）
- `apps/web/src/components/agent/file-link-actions.ts`（动作层 + `resolveAbsolutePath`）
- `apps/web/src/components/agent/file-link-actions.test.ts`
- `apps/web/src/components/ui/FileLinkContextMenu.tsx`（共享菜单组件）
- `apps/web/src/components/ui/FileLinkContextMenu.test.tsx`
- `apps/web/src/components/agent/thread-file-env.tsx`（Context Provider/Hook）

**修改**
- `apps/web/src/components/agent/AgentView.tsx`（provide `ThreadFileEnvProvider`）
- `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`（胶囊 `MarkdownCode:961` 包菜单）
- `apps/web/src/components/agent/AgentAttachmentGrid.tsx`（附件卡片包菜单）
- `apps/web/src/components/file-browser/WorkspaceFileBrowser.tsx`（文件树项包菜单）
- `apps/web/src/components/tabs/FilePreviewTabView.tsx`（预览区包菜单，「复制路径」从下拉移入）
- `apps/web/src/lib/desktop-api/native.ts`（新增 `copyFile` 封装）
- `apps/desktop/src-tauri/src/main.rs`（新增 `copy_file` 原生命令）
