# 输入草稿恢复 + 历史回溯

- **日期**：2026-06-26
- **状态**：已设计，待实现
- **分支**：feat/new-ui
- **相关文件**：`apps/web/src/components/agent/AgentInput.tsx`、`apps/web/src/atoms/agent-atoms.ts`

## 1. 背景与目标

当前 Agent 输入框（`AgentInput.tsx`）的输入文本用组件内 `useState`（`AgentInput.tsx:223`）管理，是纯瞬时状态——组件卸载即丢失。用户写到一半切换到别的会话（或重启 App），再切回来，内容就没了。

本设计解决两件事：

1. **草稿恢复**：未发送的输入内容，按会话（thread）保存；切走再回来、重启 App 后都能恢复。
2. **输入历史回溯**：已发送过的输入，按会话存成历史列表（每会话最多 100 条）；用上下键回溯浏览，选中后可直接编辑重发。

两个功能共享同一套「按 `threadId` 存储」的基础设施。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 持久化范围 | 切换会话 + 重启 App 后都恢复 → 落 `localStorage` |
| 存储内容 | 富文本 TipTap JSON（`editor.getJSON()`），保留 `@agent` / `/命令` / `$技能` 等结构化节点与格式 |
| 功能范围 | 草稿恢复 + 历史回溯，两者都要 |
| 回溯交互 | ↑ 从新到旧直接覆盖编辑器；当前草稿实时存盘，故覆盖不丢草稿；↓ 到底 / Esc 回到草稿 |
| 存储组织 | 双 key 分离（draft / history 各一个 localStorage key） |
| 历史上限 | 每会话最多 100 条，FIFO 裁剪 |

## 3. 架构

底层机制用 Jotai 的 `atomWithStorage`（落 localStorage）+ 可写的 `atomFamily`（按 `threadId` 切片），对齐项目现有模式（参照 `agent-atoms.ts` 的 `agentMessageQueueAtom`）。

```
agent-input-draft   : { [threadId]: TipTapJSON }      // 每会话 1 份草稿
agent-input-history : { [threadId]: TipTapJSON[] }    // 每会话已发送输入列表（最新在前）
```

> 类型别名 `TipTapJSON` 对应 `JSONContent`（来自 `@tiptap/core`），即 `editor.getJSON()` 的返回类型。

### 3.1 Atoms

扩展 `apps/web/src/atoms/agent-atoms.ts`：

- `agentInputDraftAtom = atomWithStorage<Record<string, TipTapJSON>>('agent-input-draft', {})`
- `agentInputHistoryAtom = atomWithStorage<Record<string, TipTapJSON[]>>('agent-input-history', {})`
- `agentInputDraftFamily`：可写 `atomFamily(threadId)`，get 读 draftAtom[threadId]，set 更新 draftAtom 中该 threadId 的键。
- `agentInputHistoryFamily`：同上，对应 historyAtom。

> 注意：不能只用 `selectAtom` 做只读派生——草稿要更新、历史要追加，必须是**可写**派生 atom。

### 3.2 工具函数

建议放在 `apps/web/src/lib/agent-input-state.ts`（或并入 agent-atoms 的 action 层），供组件与清理逻辑调用：

- `setDraft(threadId, json)`：写入草稿。
- `clearDraft(threadId)`：删除该 thread 的草稿键。
- `pushHistory(threadId, json)`：在 history 数组队首插入（index 0 = 最近一条），长度 > 100 时裁掉尾部。
- `removeThreadInputState(threadId)`：从 draft 与 history 两个 Record 中同时删除该 threadId（孤儿清理用）。

### 3.3 数组顺序约定

- history 数组**最新在前**：`history[0]` 是最近一次发送，`history[n]` 最旧。
- ↑ 键索引从 `-1`（未回溯）递增到 `0`、`1`、`2`…，即从最新走向更旧。

## 4. AgentInput 接入（数据流）

接入点都在 `apps/web/src/components/agent/AgentInput.tsx`：

| 行为 | 接入点 | 动作 |
|------|--------|------|
| 草稿实时保存 | `onUpdate`（`AgentInput.tsx:419`） | 防抖 ~400ms → `setDraft(threadId, editor.getJSON())`。**仅在用户真实输入时触发**，回溯/恢复填充时被 `isNavigatingHistory` 标志短路（见 §5） |
| 草稿恢复 | mount / `threadId` 变化的 `useEffect`（参考 `AgentInput.tsx:338-367`） | 读 `draftFamily(threadId)` → `editor.commands.setContent(json, false)`（`false` = 不触发 onUpdate）；空则清空编辑器 |
| 草稿清除 | `handleSend` 成功后、清空动作旁（`AgentInput.tsx:600` 附近） | `clearDraft(threadId)` |
| 历史追加 | `handleSend` 内、`clearContent()`（`AgentInput.tsx:600`）**之前**取 JSON | `pushHistory(threadId, editor.getJSON())` |

**发送时固定顺序**：`getJSON 入历史` → `editor.commands.clearContent()` → `clearDraft()`。

**防抖 flush 时机**：草稿保存是防抖的（~400ms）。为避免「输入后快速切走导致防抖未触发而丢草稿」，在**组件卸载**与 **`threadId` 变化**时立即 flush：取消待执行的防抖，把当前编辑器内容同步写入旧 threadId 的草稿。否则用户在 <400ms 内切换会话会丢失最后一次输入。

## 5. 上下键历史回溯交互

### 5.1 拦截点

在 TipTap 的 ProseMirror 层扩展 keydown 处理：`useEditor` 的 `editorProps.handleKeyDown`（`AgentInput.tsx:379-422`）。回车发送已有同类拦截（`AgentInput.tsx:410`）。

### 5.2 状态机

组件内 `historyIndex = useRef(-1)`：

- `-1`：未回溯，编辑器显示当前草稿。
- `0..n`：回溯到 `history[index]`。

### 5.3 行为

- `↑`（光标在编辑器首行 **或** 编辑器为空时拦截）：`historyIndex++` → `setContent(history[index], false)`，置 `isNavigatingHistory = true`。超界（index >= history.length）则不再前进。
- `↓`（`historyIndex >= 0` 时拦截）：`historyIndex--`；回到 `-1` 时 `setContent(draft, false)` 恢复草稿。
- `Esc`：`historyIndex = -1`，恢复草稿。

### 5.4 核心约束：不污染草稿

这是「边输入边保存」直觉的实现保障：

- 历史回溯、草稿恢复都是**程序填充**：置 `isNavigatingHistory = true`，`setContent(..., false)` 不触发 onUpdate；即便触发，`onUpdate` 内的草稿保存也被该标志短路。
- 所以回溯覆盖编辑器**不会**把历史内容写进存盘草稿。
- 用户一旦在回溯态下手动敲键：立即重置 `isNavigatingHistory = false`、`historyIndex = -1`（退出回溯），从此刻起正常实时存为草稿。

### 5.5 多行兼容

TipTap 的 ↑↓ 默认是多行光标移动。只在**首行（↑）/ 末行（↓）或空框**时拦截，避免破坏多行编辑。

## 6. 清理与生命周期

**孤儿清理**：会话被删除（trash / 永久删除）时调 `removeThreadInputState(threadId)`。接入点在会话删除 action——实现阶段需定位具体 atom action / sidecar 调用处并接入。

**草稿清除**：`handleSend` 成功后 `clearDraft(threadId)`（草稿语义 = 未发送，发出即失效）。

**历史裁剪**：`pushHistory` 内部保证每会话 ≤ 100 条。

## 7. 边界处理

- **localStorage 脏 JSON / 手改**：`atomWithStorage` 读失败时容错返回空对象，不崩。
- **TipTap 跨版本 JSON 不兼容**：`setContent` 包 `try/catch`，失败回退清空编辑器。
- **空草稿**：编辑器为空时不写入 draft，避免存无意义空对象。
- **localStorage 配额**：每 thread ≈ 1 份草稿 + ≤100 条历史，总量远低于限额；写入 `try/catch` 兜底，失败静默不阻塞输入。

## 8. 测试策略

web 已有测试套件（`bun run test:web`）。

**单元测试（工具函数）**：
- `pushHistory`：追加、队首插入、超 100 条裁剪尾部。
- `setDraft` / `clearDraft`：写入、删除对应键。
- `removeThreadInputState`：同时清掉 draft 与 history 的该 threadId。

**集成测试（AgentInput 行为）**：
- `onUpdate` 防抖后写草稿；防抖窗口内多次输入只写一次。
- `threadId` 切换：切走保存旧会话草稿、切回恢复新会话草稿。
- 发送后：草稿被清除、内容进入历史。
- ↑ 回溯：依次填充 history[0]、history[1]…；回溯期间草稿存盘内容不变（不污染）。
- 回溯态手动输入：退出回溯、`historyIndex` 重置、新内容成为草稿。
- ↓ 到底 / Esc：恢复存盘草稿。

**存储容错测试**：
- localStorage 注入脏 JSON，组件不崩、回退空状态。

## 9. 未决项 / 范围外

- **跨设备同步**：不做。草稿/历史仅本地 localStorage，不进 sidecar `~/.lume/`，不随会话导出。
- **草稿与历史迁移**：TipTap 升级导致 JSON schema 变更时，不做自动迁移，依赖 `setContent` try/catch 容错。
- **会话归档（archive）**：归档不清理草稿/历史（仅删除才清理）。
- **全局快捷键 / 多窗口**：本设计基于单窗口单编辑器；多窗口并发编辑同一会话的草稿冲突不在范围内。
