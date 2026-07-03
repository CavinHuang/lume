# 会话顶部「更多操作」菜单设计

- 日期：2026-07-02
- 状态：待评审
- 涉及层：`apps/web`（渲染层，改动集中于此）；复用现有后端 IPC `GET_WORKSPACE_ROOT_PATH`，**后端零改动**

## 1. 背景与目标

当前每个会话打开后，顶部区域（`AgentHeader`）在标题与运行状态徽章之间显示一个 `WorkspacePicker`——它承担「显示当前工作区名 / 切换工作区 / 新建工作区 / MCP·Skill 计数徽章」四项职能。

目标：将该位置改造为一个「更多操作」`⋯` 图标按钮，点击后弹出**针对当前会话**的操作菜单，把工作区切换并入其中，并新增若干会话级操作（置顶、重命名、归档、复制、Fork）。

设计原则：KISS（最小可用菜单）、YAGNI（未勾选功能不做）、DRY（复用现有 IPC 与 UI 原语）、SRP（`AgentHeader` 保持纯展示）。

## 2. 用户决策汇总（已拍板）

| 决策点 | 选择 |
|---|---|
| 工作区切换去向 | 并入「更多操作」菜单（带子菜单） |
| 菜单范围 | 扩展会话级功能（复用列表项操作 + 新增复制/Fork） |
| 实现方案 | A：新建 `ThreadMoreActions` 组件 |
| 重命名交互 | 弹窗输入（非就地编辑） |
| readOnly 语义 | 仅留安全项（禁用写操作，保留读/复制项） |
| 复制工作目录路径 | 复用现有 `GET_WORKSPACE_ROOT_PATH` IPC（后端零改动） |

## 3. 范围

### 纳入
顶部 `⋯` 菜单包含以下项（按分组顺序）：

```
⋯ (MoreHorizontal)
├─ 切换工作区 ▶            子菜单：工作区列表，当前项打勾
├─ ─────────────
├─ 置顶 / 取消置顶
├─ 重命名                  弹窗
├─ 归档
├─ ─────────────
├─ 复制 ▶                  子菜单
│   ├─ 复制工作目录
│   ├─ 复制会话 ID
│   └─ 复制为 Markdown
└─ Fork 分支
```

### 非目标（本期不做）
- 新建工作区（菜单不含；用户未勾选）
- 删除会话（顶部不提供，仍只从左侧栏列表项进入；破坏性操作集中在一处）
- 清空消息、导出文件、查看会话信息面板
- MCP / Skill 计数徽章（随 `WorkspacePicker` 一并移除）

## 4. 方案选型

选定 **方案 A：新建 `ThreadMoreActions.tsx` 独立组件**。

- `AgentHeader:42` 的 `{!readOnly && <WorkspacePicker />}` → `<ThreadMoreActions threadId={threadId} readOnly={readOnly} />`
- 与既有 `ThreadItemActions`（列表项「⋯」）同构，互为兄弟组件，各自服务于不同容器（详情顶栏 vs 侧栏列表）
- `AgentHeader` 维持纯展示职责，不内联菜单逻辑（SRP）

否决方案 B（复用 `ThreadItemActions`）：该组件绑定列表项专属逻辑（相对时间戳、hover 显隐、归档二次确认倒计时），复用会引入无关依赖。

否决方案 C（内联 `AgentHeader`）：使 `AgentHeader` 膨胀、难以独立测试。

## 5. 组件设计

### 5.1 `ThreadMoreActions`

- 路径：`apps/web/src/components/agent/ThreadMoreActions.tsx`
- 职责：渲染 `⋯` 触发按钮 + `DropdownMenu`，按 readOnly 启用/禁用各菜单项，委托 `useThreadActions` 与各专项逻辑执行。

```ts
interface ThreadMoreActionsProps {
  threadId: string
  readOnly?: boolean
}
```

- 触发按钮：`MoreHorizontal`（lucide），样式与 `ThreadItemActions` 的触发按钮一致（`p-0.5 rounded text-[var(--text-3)] hover:bg-[var(--surface-2)]`），保证视觉统一。
- 使用 `DropdownMenu` / `DropdownMenuSub` / `DropdownMenuSubTrigger` / `DropdownMenuSubContent` / `DropdownMenuItem` / `DropdownMenuSeparator`（来自 `@/components/ui/dropdown-menu`）。

### 5.2 `AgentHeader` 改动

- 移除 `WorkspacePicker` 导入与渲染，改为 `ThreadMoreActions`。
- 布局：`⋯` 图标**紧挨标题右侧**——即原 `WorkspacePicker` 的位置（标题 `<span>` 之后、运行状态徽章之前），原位替换，**不**移到整行最右。仍在左侧 `flex-1` 容器内；标题 `truncate`，`⋯` 触发按钮与状态徽章均 `flex-shrink-0`，不被挤压。
- readOnly 仍向下透传。

### 5.3 `WorkspacePicker` 处理

- `WorkspacePicker.tsx` 的「工作区列表渲染 + 切换」逻辑迁移至 `ThreadMoreActions` 的「切换工作区」子菜单后，**删除 `WorkspacePicker.tsx`**。
- 清理其引入的孤儿：`agentWorkspaceCapabilitiesAtom` 若仅被 `WorkspacePicker` 使用则一并删除；实现前用 `grep` 确认引用范围（capabilities 仅服务于已移除的徽章）。
- `CreateWorkspaceDialog` 不再被顶部入口引用（用户未要「新建工作区」）；若全项目无其他引用则保留组件文件但不接入，**不在本期删除**（surgical：不删预存在组件）。

## 6. 各菜单项实现

### 6.1 切换工作区（子菜单）
- 数据：`agentWorkspacesAtom`（列表）、`currentWorkspaceIdAtom`（当前）。
- 渲染：`DropdownMenuSub`，遍历工作区，`currentWorkspaceId === w.id` 项打勾（`Check` 图标），点击 `setCurrentId(w.id)`。
- 语义沿用原 `WorkspacePicker`：切换的是**全局当前工作区**（影响新建线程），不绑定当前 thread（与原行为一致）。
- readOnly：**启用**（切换工作区不修改当前会话）。

### 6.2 置顶 / 取消置顶
- 经 `useThreadActions(threadId).togglePin()`（见 §9）。
- 图标随状态：`Pin` / `PinOff`，文案「置顶」/「取消置顶」。
- readOnly：**禁用**。

### 6.3 重命名（弹窗）
- 本组件内置一个轻量重命名 `Dialog`（复用 `@/components/ui/dialog.tsx`）：标题输入框 + 取消/确认。
- 初值为当前 thread 标题；确认时调 `useThreadActions(threadId).rename(newTitle)`。
- 触发：点击菜单项 → 关闭菜单 → 打开 Dialog（菜单与 Dialog 不嵌套，避免 Radix 焦点冲突）。
- readOnly：**禁用**。

### 6.4 归档
- 经 `useThreadActions(threadId).archive()`：调 `agent:archive-thread` IPC，并从 `agentThreadsAtom` 与 `tabsAtom` 移除该 thread；若归档的是当前激活会话，`setActiveTabId(null)` 切走（复刻 `LeftSidebar.tsx:173-180`）。
- **关键 UX**：顶部菜单归档的通常正是当前打开的会话，归档后该 tab 必须关闭、激活切走，否则界面会停留在已归档会话上。
- readOnly：**禁用**。
- 注：顶部入口**不做**二次确认倒计时（那是列表项 `ThreadItemActions` 的专属交互）；归档可恢复，风险可控。

### 6.5 复制（子菜单）
统一用 `writeClipboardText`（`@/lib/desktop-api`，项目已有），复制成功 `toast.success`，失败 `toast.error`。三项均 readOnly **启用**。

- **复制工作目录**：`sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH, { workspaceSlug })` 取当前工作区绝对路径 → 写入剪贴板（见 §7；前端已有用法 `WorkspacesSettings.tsx:102`）。
- **复制会话 ID**：`writeClipboardText(threadId)`。
- **复制为 Markdown**：见 §8。

### 6.6 Fork 分支
- `sidecarCall(AGENT_IPC_CHANNELS.FORK_THREAD, { threadId, upToMessageId })`；后端 `forkAgentThread` 返回 `{ newThreadId }`（`agent-thread-manager.ts:706-732`）。
- `upToMessageId`：本期取当前会话**最后一条消息**的 id（整体分叉，最简；KISS）。前端从该 thread 消息列表末项取 id（实现时确认 `agentThreadsAtom` 的 transcript 或 `agentRuntimeEventsFamily(threadId)` 哪个持有带 `id` 的有序消息，取末项）。
- 成功后（本期）：仅 `toast` 提示「已创建分叉」，**不自动跳转**（跳转依赖 tab 创建 + thread 列表刷新链路，本期不做，见 §14 技术债）。
- 空会话（无消息）：菜单项禁用，提示「空会话无法 Fork」。
- readOnly：**禁用**。

## 7. 复制工作目录：复用现有 `GET_WORKSPACE_ROOT_PATH` IPC

`AgentWorkspace` 仅含 `id/name/slug/createdAt/updatedAt`，无文件系统路径字段。但后端**已存在**等价 IPC，无需新增（修正初版「新增 IPC」的误判）：

- channel：`AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH: 'agent:get-workspace-root-path'`（`packages/shared/src/types/agent.ts:1542`）。
- handler（`apps/sidecar/src/rpc/agent-handlers.ts:1566`）用 `workspaceSlugInputSchema` 验参，调 `getAgentWorkspacePath` 返回绝对路径。
- 前端已有用法可照搬：`apps/web/src/components/settings/WorkspacesSettings.tsx:102`。
- 调用：`const path = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH, { workspaceSlug })` → `writeClipboardText(path)`。
- slug 为空（无当前工作区）：前端不发请求，菜单项点击 `toast.error('当前无工作区')`。
- **后端零改动**。

## 8. 「复制为 Markdown」拼接

- 位置：**前端拼接**（消息数据已在渲染层 atom 中，无需后端往返）。
- 实现：新增纯函数 `threadToMarkdown(title, messages): string`，放在 `apps/web/src/components/agent/thread-to-markdown.ts`（便于单测）。
- 格式：
  ```
  # {会话标题}

  ## 👤 用户
  {user 文本}

  ## 🤖 助手
  {assistant 文本}

  ...
  ```
- 文本提取：参照 `RuntimeEventContentBlock.tsx` 中既有的 markdown 提取逻辑（如 `preview.markdown`、`getAssistantDownloadPayload`），抽公共部分或照搬相同规则，保持一致。
- 工具调用/结果：本期以折叠的代码块或简述呈现（`> 🔧 调用工具 xxx`），不做完整还原（YAGNI）。
- messages 来源：实现时确认从 `agentThreadsAtom` 的 transcript 还是 `agentRuntimeEventsFamily` 取——选用能拿到完整有序 user/assistant 文本的那一个。

## 9. `useThreadActions` 共享 hook（DRY）

thread 的「置顶 / 重命名 / 归档」当前由 `LumeSidebar` 顶层 props 链下传，`AgentHeader` 树无法接入。为避免在 `ThreadMoreActions` 重复编写 IPC 调用与 atom 更新，新增共享 hook：

- 路径：`apps/web/src/components/agent/use-thread-actions.ts`
- 签名：
  ```ts
  function useThreadActions(threadId: string) {
    return {
      togglePin: () => Promise<void>,
      rename: (title: string) => Promise<void>,
      archive: () => Promise<void>,
    }
  }
  ```
- 内部复刻 `LeftSidebar.tsx:148-208` 的三个 handler：
  - `togglePin` → `sidecarCall('agent:toggle-pin-thread', {threadId})` + 翻转 `agentThreadsAtom` 中该 thread 的 `pinned`。
  - `rename(title)` → `sidecarCall('agent:update-thread-title', {threadId, title})` + 更新 `agentThreadsAtom` 与 `tabsAtom` 的 title。
  - `archive()` → `sidecarCall('agent:archive-thread', {threadId})` + 从 `agentThreadsAtom`/`tabsAtom` 移除 + 若为当前激活会话则 `setActiveTabId(null)`。
  - 各失败分支 `toast.error`，文案与 LeftSidebar 一致。
- 涉及 atom：`agentThreadsAtom`、`tabsAtom`（实现时确认确切 atom 名）、`activeTabIdAtom`——均为全局 atom，hook 内 `useAtom` 取用。
- 归档**不做** `LeftSidebar` 的二次确认弹窗（顶部菜单直接执行；归档可恢复）。
- 现有列表项 handler **本期不改**（surgical）；hook 作为新代码的标准入口，未来列表项可迁移收敛至此（记入技术债）。
- Fork 不放入此 hook（其语义偏「创建新会话」而非「修改当前会话」，且需处理 `upToMessageId` 与跳转），由 `ThreadMoreActions` 直接调用。

## 10. readOnly 语义汇总

| 菜单项 | readOnly |
|---|---|
| 切换工作区（及子菜单） | 启用 |
| 置顶 / 重命名 / 归档 | 禁用 |
| 复制工作目录 / 会话 ID / Markdown | 启用 |
| Fork | 禁用 |

实现：`DropdownMenuItem` 的 `disabled` 属性按上表设置；菜单本身在 readOnly 下**仍显示**（区别于原 `{!readOnly && <WorkspacePicker/>}` 的整块隐藏）。

## 11. 错误处理

- 所有 IPC 调用失败：`toast.error` 提示，菜单保持可用（可重试）。
- 复制类操作失败：`toast.error('复制失败')`。
- `GET_WORKSPACE_PATH` 在 slug 为空时前端不发起请求，菜单项显示但点击提示「当前无工作区」。
- Fork 的 `upToMessageId` 取不到（空会话）：菜单项禁用或点击提示「空会话无法 Fork」。

## 12. 测试策略

- `ThreadMoreActions.test.tsx`：
  - 渲染：菜单默认收起，点击 `⋯` 展开后出现全部分组项。
  - readOnly：写操作项 `disabled`，读/复制项可用。
  - 各子菜单展开：「切换工作区」「复制」子项齐全。
  - 交互：点击「置顶」调用 `useThreadActions.togglePin`（mock）；点击「复制会话 ID」调用 `writeClipboardText`（mock）。
  - 重命名：点击「重命名」打开 Dialog，确认后调用 `rename`。
- `thread-to-markdown.test.ts`：纯函数单测，覆盖 user/assistant 交替、空会话、含工具调用简述。
- `use-thread-actions.test.ts`：mock `sidecarCall`，验证对应 IPC channel 与 atom 更新。
- 后端：`agent-handlers` 现有测试模式追加 `GET_WORKSPACE_PATH` 用例（slug → 路径；不存在 → 抛错）。
- 复用 `rtk` 包裹测试命令（项目约定）。

## 13. 实现顺序（build sequence）

1. 前端纯函数：`threadToMarkdown` + 用例 → verify：单测通过。
2. 前端 hook：`useThreadActions` + 用例（mock IPC）→ verify：单测通过。
3. UI 原语：`dropdown-menu.tsx` 加 `DropdownMenuSub`/`SubTrigger`/`SubContent` 封装 → verify：tsc 通过。
4. 前端组件：`ThreadMoreActions`（含重命名 Dialog、两个子菜单、readOnly 禁用）+ 用例 → verify：组件测试通过。
5. 接线：`AgentHeader` 替换 + 布局调整；删除 `WorkspacePicker`，清理孤儿 atom → verify：`AgentHeader` 渲染、tsc 无残留引用。
6. 手验：开发环境实跑——切换工作区 / 置顶 / 重命名 / 归档 / 三项复制 / Fork，及 readOnly 会话行为。

> 后端无任务：`GET_WORKSPACE_ROOT_PATH` IPC 已存在，直接复用。

## 14. 技术债 / 未来

- `LumeSidebar` 顶层 thread action handler 未迁移至 `useThreadActions`，存在两套调用同一 IPC 的路径——未来收敛。
- 「复制为 Markdown」的工具调用/结果为简述，未来可做完整还原。
- 「Fork」当前整体分叉，未来可支持「从指定消息分叉」（需消息级右键入口）。
