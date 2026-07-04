# TodoWrite 工具重设计

> 日期：2026-06-26
> 范围：正确性修复 + 设计整改（不含 web 端 todo 面板、不含 resume 恢复）

## 背景与问题

Lume 当前的 `TodoWrite` 工具（`packages/sdk/src/tools/todo-tool.ts`）对照 claude-code（`packages/builtin-tools/src/tools/TodoWriteTool/`）存在以下问题：

1. **状态全局单例 → 跨会话串台**：`const todoList: TodoItem[] = []` 是模块级常量。sidecar 把同一个 `TodoWriteTool` 单例放进每个会话的工具集（`apps/sidecar/.../run.ts:599`），导致所有 thread / session / subagent 共享同一数组——会话 A 写的 todo 会出现在会话 B。
2. **`isConcurrencySafe: () => true` 语义错误**：工具会 mutate 状态，并非并发安全。
3. **双 API 面**：同时接受 `todos[]` 全量替换与 legacy `action: add/toggle/remove/list/clear`，违反「单一约定」原则。
4. **无 schema 校验**：`normalizeTodos(inputTodos: any[])` 用 `||` 强转，JSON schema 无 `required`，模型可传空对象。
5. **activeForm 未强制 + prompt 一句话**：模型不知道要写双形态、不知道何时该用。
6. **无 allDone 自动清理**：完成的条目永远挂着。
7. **result 灌全量 before/after 文本**：污染对话上下文。

## 范围

- **含**：状态隔离、并发标记修正、删 legacy API、strict schema、prompt 重写 + 强制 activeForm、allDone 自动清理、result 紧凑列表。
- **不含**：web 端 todo 进度面板、resume（会话恢复）。

## 设计

### §1 架构与状态模型

将单例导出改为 per-session 工厂，镜像 sidecar 现有同类模式（`createTaskContractWriteTool({ threadId })`、`createTaskReportTool({ sessionDir, threadId })`）：

```ts
export function createTodoTool(opts: { threadId: string }): ToolDefinition
```

状态进闭包——工厂内 `const todos: TodoItem[] = []`。每个会话构建自己的工具实例，拥有独立数组；会话结束随 toolset 被 GC，无全局泄漏、无 Map 清理负担。

`TodoItem` 精简为三字段：

```ts
interface TodoItem {
  content: string    // 祈使句，描述要做什么（如 "Run tests"）
  activeForm: string // 现在进行时，执行时展示（如 "Running tests"）
  status: 'pending' | 'in_progress' | 'completed'
}
```

删除 `id` / `priority` / `text` / `done`——全仓库零外部消费者（已确认），列表位置即身份。删除 `getTodos` / `clearTodos` 导出及内部用法（前者仅用于 before/after 文本、后者仅用于 legacy `clear`，均随整改消失）。

### §2 工具契约（schema + call）

strict JSON schema：

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["todos"],
  "properties": {
    "todos": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["content", "activeForm", "status"],
        "properties": {
          "content":    { "type": "string", "minLength": 1 },
          "activeForm": { "type": "string", "minLength": 1 },
          "status":     { "enum": ["pending", "in_progress", "completed"] }
        }
      }
    }
  }
}
```

删除全部 legacy `action` / `text` / `id` / `priority` 分支。

`call({ todos }, context)` 行为：

- `allDone`（所有项 `completed`）→ 存 `[]`（自动清理，对齐 claude-code）。
- 任一项缺 `content` 或 `activeForm` → `is_error: true` + 明确提示信息。
- 返回**紧凑当前列表**（单态，去掉 before/after 对照）：
  ```
  [~] Run tests
  [ ] Build the project
  [x] Write docs
  ```
  marker：`[~]` in_progress / `[x]` completed / `[ ]` pending；展示 `content`。

元数据：`isConcurrencySafe: () => false`、`isReadOnly: () => false`、`tool_use_id: ''`（由 engine 填充，项目约定）。

### §3 Sidecar 接线

- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts:28` 删除 `TodoWriteTool` import。
- `createBaseSdkAlignedTools`（run.ts:591-601）从返回数组移除 `TodoWriteTool`（`{ source: "sdk" }` 组不再含 todo）。
- `buildRuntimeCoreTools`（run.ts:604）内新增：
  ```ts
  const todoTool = createTodoTool({ threadId: input.sessionId })
  ```
  挂进 `ToolRuntime.build` 的 `{ source: "task", tools: [taskReportTool, sidecarAgentTool, todoTool] }` 组（与同类 per-session 工厂并列）。
- **保留现状**：plan 模式不提供 todo（与现 `createBaseSdkAlignedTools` plan 分支行为一致）。

### §4 Prompt

替换一句话 prompt 为聚焦版（精简自 claude-code），覆盖：

- **何时用**：3+ 步的复杂任务、用户一次提供多个任务、收到新指令后立即记为 todo、开始一项任务前先标记 in_progress。
- **何时不用**：单一琐碎任务、纯信息问答、少于 3 个琐碎步骤。
- **状态规则**：pending / in_progress / completed；同一时刻仅一个 in_progress；完成即标记 completed；不要批量标记。
- **双形态**：`content`（祈使句）+ `activeForm`（现在进行时），两者均必填。

### §5 错误处理与测试

- 工厂缺 `threadId` → 构造时抛错（fail fast，一个会话必有 id）。
- 缺 `content` / `activeForm` → `is_error` + 明确信息；空数组合法（清空列表）。

新增测试（`packages/sdk/src/tools/todo-tool.test.ts`）：

1. 两个不同 `threadId` 的工厂实例状态互不串扰（核心隔离断言）。
2. `allDone`（全部 completed）→ 存储清空为 `[]`。
3. 缺 `activeForm` 的 item → `is_error: true`。
4. result 为紧凑单态列表（无 before/after 对照）。
5. `isConcurrencySafe()` 返回 `false`。

## 验证

- 新增 `todo-tool.test.ts` 全绿。
- sidecar 构建工具集时 `createTodoTool` 被正确调用、出现在 `task` 组。
- 现有引用 `TodoWrite` 名称的 skill / 示例（`executing-plans/SKILL.md`、`examples/web/feature-catalog.ts`、`sdk/src/agent.ts` 工具白名单）名称不变，无需改动。

## 非目标 / 后续

- web 端 todo 进度面板：未来单独设计（届时 tool_result 可改为通用语，由面板渲染）。
- resume 恢复：会话重启后从 transcript 重建 todo，未来单独设计。
