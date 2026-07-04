# TodoWrite 工具全面改进设计

**日期**：2026-06-26
**状态**：待实现
**关联**：前序设计 `2026-06-26-todo-tool-redesign-design.md`（per-session 工厂重构，仅 Task 1 落库，commit `ee72ffc9`）

## 1. 背景

Lume 的 TodoWrite 工具近期做了一次 per-session 工厂重构（commit `ee72ffc9`），目标是修复跨会话串台——所有 session 共享一个模块级 todo 数组，会话 A 的 todo 会出现在会话 B。但该重构**只完成了 SDK 源码改写（Task 1）**，SDK 导出更新（Task 2）与 sidecar 接线（Task 3）未落库，导致当前 HEAD 上 **SDK 包编译断裂**。

对比 claude-code（Anthropic 官方 CLI）的 todo 实现，发现 Lume 在三个层面存在落差：行为约束未生效、UX 可视化缺失、工程债未清。本文档基于对两个代码库的逐文件排查，给出分阶段的改进设计。

## 2. 问题诊断

### P0 — SDK 编译断裂（工程债，硬前提）
`ee72ffc9` 删除了 `TodoWriteTool` / `getTodos` / `clearTodos` 符号，但以下位置仍引用它们：
- `packages/sdk/src/tools/index.ts:74,142,265`
- `packages/sdk/src/index.ts:150,474-478`
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts:28,599`
- `packages/sdk/dist/tools/todo-tool.d.ts:18-20`（过期产物）

工作树是干净的，断裂状态被提交。当前 SDK build/typecheck 失败，per-session 工厂未接线生效。

### P1 — activeForm 收集却从不使用（最大设计浪费）
`todo-tool.ts:11-19` 强制 `activeForm` 必填非空，但 `renderTodos` 只输出 `content`。claude-code 强制 activeForm 是为了 spinner 消费（显示 "Running tests…"）。Lume 既无 spinner 消费，前端也无任何 todo 可视化（`tool-result-renderers/index.tsx:22-40` 无 TodoWrite case，走纯文本 DefaultResult）。模型被强制多产出一个易错字段，运行时完全丢弃。

### P2 — 无实时进度反馈 / 无结构化数据
todo 状态仅通过 `tool_result` 的 content 字符串流到前端，前端拿不到结构化数据，无进度面板，每次 TodoWrite 是独立纯文本块。claude-code 有 spinner 内联 + 展开列表 + 已完成 30s 淡出。

### P3 — subagent 隔离语义（与 P0 耦合）
现已查明：subagent 跑在独立 `childThreadId`（全新 UUID）上，独立调起 `createRuntimeCoreSession → buildRuntimeCoreTools`。照搬 `createTaskContractWriteTool({ threadId: input.sessionId })`（`run.ts:639-645`）的取法，TodoWrite 即可天然实现 subagent 独立 todo——**此问题在 Phase 0 接线时一并解决，无需额外设计**。主 session 与 subagent 的 sessionDir 也物理隔离（`sessions/<lumeSessionId>`）。

### P4 — todo prompt 在主路径未生效（致命断点）+ verificationNudge 缺失
- `todo-tool.ts:21-41` 的 PROMPT（含 4/5 claude-code 软约束 + activeForm 强制）是**死代码**：sidecar 用 `buildSystemPromptAppend` 组装 system prompt，SDK `engine.ts:254-266` 见 `config.systemPrompt` 非空即 return，永不拼 `tool.prompt`。LLM 实际只看到 description 一句英文。缺"被阻塞时新建任务"软约束。
- 无 verificationNudge 机制（防止模型虚假宣布完成）。Lume 仅有静态 `code-reviewer` subagent，engine loop（`engine.ts:880-1204`）无主动 hook。

### P5 — 一致性问题
- `tool-metadata.ts:477` `allowedInPlanMode: true` 与运行时（plan 模式不装配 TodoWrite）矛盾。
- 前端工具名 `todo_write` vs 实际 `TodoWrite`（`tool-metadata.ts:305`、`system-tools-state.ts:44`）。
- `isConcurrencySafe` 类型形式：代码 `false`（boolean）vs 文档 `() => false`（函数）。
- `call` 返回值 string/对象混用。

## 3. 目标与非目标

**目标**：
1. SDK 编译通过，per-session 工厂接线生效，subagent 天然隔离。
2. todo 软约束真正发到 LLM；verificationNudge 防虚假完成。
3. activeForm 被消费：sticky 实时面板 + spinner 显示当前任务。
4. 清理一致性问题。

**非目标**：
- todo 持久化 / resume 恢复（保持纯内存，未来单独设计）。
- claude-code V2 的 Task\* 体系（owner/blocks/blockedBy/文件持久化/多 agent 认领竞争）——Lume 无 swarm 需求，YAGNI。
- 跨 session todo 聚合视图——每 session 独立面板即可。

## 4. 设计

### Phase 0 — 收尾 per-session 重构

**目标**：编译通过，工厂生效，subagent 隔离。

**改动**：

1. **SDK 导出清理**：
   - `packages/sdk/src/tools/index.ts`：移除 `TodoWriteTool` 的 import（:74）、`ALL_TOOLS` 数组项（:142）、re-export（:265）。改为 re-export `createTodoTool`、`createTodoStore`、`TodoItem` / `TodoStatus` 类型。
   - `packages/sdk/src/index.ts`：移除 `TodoWriteTool` import（:150）、`getTodos` / `clearTodos` re-export（:474-478）。改为 re-export `createTodoTool`、类型。
   - 从 `ALL_TOOLS` 静态池移除（工厂需 threadId，不能进静态池）。
   - 重建 dist（`packages/sdk/dist/`）。

2. **sidecar 接线**：
   - `apps/sidecar/.../runtime-core/run.ts:28`：import 从 `TodoWriteTool` 改为 `createTodoTool`。
   - `run.ts:599`：从 `createBaseSdkAlignedTools` 的 baseTools 数组移除 `TodoWriteTool`。
   - 在 `buildRuntimeCoreTools`（`run.ts:604`，TaskContract 实例化处 `:639-649` 旁）新增：
     ```ts
     const todoTool = createTodoTool({ threadId: input.sessionId });
     ```
     挂入对应 tool group（与 `taskReportTool`、`sidecarAgentTool` 同组）。
   - subagent 隔离天然成立（`childThreadId` 流入 `input.sessionId`），无需额外改动。

**验证**：
- `bun run build`（SDK）+ typecheck 通过。
- sidecar typecheck 通过。
- `run.test.ts:467`（plan 模式不含 TodoWrite）断言成立。
- 新增集成测试：两个并发 session 的 todo 互不串台。

### Phase 1 — prompt 生效 + verificationNudge

**目标**：软约束发到 LLM；防虚假完成。

**改动**：

1. **新建 todo prompt section**：
   - 新建 `apps/sidecar/.../prompt/sections/todo-section.ts`，内容取自 `todo-tool.ts:21-41` 的 PROMPT，补"被阻塞时新建描述待解决事项的任务"软约束。
   - 挂进 `buildSystemPromptAppend`（`agent-prompt-builder.ts:326-396`），与其他 section 并列。

2. **verificationNudge**：
   - 在 `todo-tool.ts:147` 的 `call()` 返回值里附加 nudge。
   - **触发条件**：本次调用新标记为 completed 的任务数 ≥ 3（`oldTodos` vs `newTodos` 的 diff）。批处理完成违反"完成一个立即标记、不要批处理"软约束，是虚假完成的信号。
   - **触发动作**：在返回的渲染文本后附加一条 nudge，提示派 `code-reviewer` subagent 验证。
   - 不需要访问 session 历史，纯靠 store 内 diff 计算。
   - 零架构改动，与 claude-code 的 tool_result 文本附加机制一致。

**验证**：
- 快照测试：最终 system prompt 含 todo section 内容。
- 单测：nudge 在"一次标 ≥3 completed"时触发；逐个正常完成时不触发。

### Phase 2 — todo UX 可视化（L3）

**目标**：activeForm 被消费，sticky 实时面板 + spinner。

**改动**（复刻 `TaskContractWrite` 回调范式，5 处）：

1. **`packages/sdk/src/tools/todo-tool.ts`**：
   - 工厂签名加 `onTodoUpdated?: (todos: TodoItem[]) => void` 回调。
   - `call()` 在 `store.set` 后 `await opts.onTodoUpdated?.(store.getAll())`。
   - 返回值仍为 `renderTodos(...)` 文本（给 LLM，不变）。

2. **`packages/shared/src/types/runtime-event.ts`**：
   - 新增 `RuntimeEventType` 成员 `"todo.state_updated"`。
   - 新增 `TodoStateUpdatedRuntimeEvent` 接口：`{ type, threadId, todos: TodoItem[], currentActiveForm: string | null }`。

3. **`apps/sidecar/.../runner/run-observer.ts`**：
   - 新增 `recordTodoState(state, emitRuntimeEvent)` 方法，复刻 `recordPlanPreview`（`:176-202`）模式：存 run item + 投影成 `todo.state_updated` 事件。

4. **`apps/sidecar/.../runner/run-loop.ts`**：
   - emitter 加 `onTodoUpdated` 分支（`:103-108` 旁），调用 `observer.recordTodoState`。

5. **前端 `apps/web/src/components/agent/`**：
   - `runtime-event-message-projection.ts`：`applyRuntimeEvent` 加 `todo.state_updated` 分支，写到 `ProjectionState` 独立字段（如 `todoState`），**不进 messages 流**。
   - 新增 sticky 面板组件，订阅 `todoState`，展示列表 + 当前 in_progress（用 activeForm）。
   - `RuntimeEventContentBlock.tsx:648-655`：spinner 文案从 `runningTool.toolName` 改为 `todoState.currentActiveForm`（fallback 到 toolName）。
   - 新增 `TodoResult` 渲染器（`tool-result-renderers/`），tool_result 渲染成历史卡片。

**关键决策**：
- todo state 走 sidecar 专用回调（`onTodoUpdated`），**不走** `tool_result` payload（content 会发给 LLM 污染上下文），**不走** 新 SDKMessage emitEvent（sidecar 回调范式更直接，与 TaskContractWrite 一致）。
- todo state 进 `ProjectionState` 独立字段而非 messages 流——sticky 面板与 spinner 共享同一数据源，不污染对话历史。

**验证**：
- 面板随 LLM 调用 TodoWrite 实时刷新。
- spinner 显示当前 in_progress 的 activeForm。
- 多并发 session 的面板互不串台（threadId 隔离）。

### Phase 3 — 一致性清理

- `apps/sidecar/.../tools/tool-metadata.ts:477`：`allowedInPlanMode` 改 `false`。
- `apps/web/.../settings/tool-metadata.ts:305` + `system-tools-state.ts:44`：`todo_write` → `TodoWrite`。
- `todo-tool.ts:121`：`isConcurrencySafe` 统一为 `false`（boolean），同步文档。
- `todo-tool.ts` 的 `call`：返回值形态统一（错误与成功路径一致）。

**验证**：相关单测通过；前端设置页工具元数据正确显示。

## 5. 实现顺序与依赖

```
Phase 0 (前提，修复编译)
  ↓
Phase 1 (prompt + nudge，行为层)
  ↓
Phase 2 (UX 可视化，依赖 Phase 0 的工厂)
  ↓
Phase 3 (清理，独立)
```

- Phase 0 是硬前提（当前编译不过）。
- Phase 1、2 可部分并行（不同层），但建议 1 先（行为约束生效后再可视化）。
- Phase 3 独立，可任意时机插入。

## 6. 风险与待定项

- **Phase 2 前端面板的位置**：Lume web 是对话式布局，sticky 面板的放置位置（顶栏/侧栏/消息流内）需在实现时结合现有布局确定。本设计只定"sticky + 实时"，具体位置留给实现计划。
- **verificationNudge 触发阈值**：≥3 是初始值，可能需根据实际效果调整。可在实现后观察模型行为再调。
- **spinner activeForm 时机**：TodoWrite 工具运行期间新 todo 尚未确定，spinner 此期间显示上一次的 activeForm 或 fallback 到 toolName。实现计划需处理这个过渡。
