# TodoWrite 工具重设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `TodoWrite` 工具从进程级全局单例改为 per-session 工厂，修复跨会话串台、并发标记错误、双 API 面与弱 schema 等问题。

**Architecture:** `todo-tool.ts` 单例导出 → `createTodoTool({ threadId })` 工厂，状态封装在每实例独立的 `createTodoStore()` 闭包里；sidecar 在 `buildRuntimeCoreTools` 里按 `input.sessionId` 构建实例，挂进 `{ source:"task" }` 工具组。Schema 收紧为 strict、删除 legacy action API、allDone 自动清空、result 改紧凑单态列表。

**Tech Stack:** TypeScript, Bun（`bun:test`）, `@lume/agent-sdk`。

设计依据：`docs/superpowers/specs/2026-06-26-todo-tool-redesign-design.md`

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/sdk/src/tools/todo-tool.ts` | todo 工具本体：类型 + `createTodoStore` + `createTodoTool` | 重写 |
| `packages/sdk/src/tools/todo-tool.test.ts` | 单元测试（隔离 / allDone / 校验 / 渲染 / 并发标记） | 新建 |
| `packages/sdk/src/tools/index.ts` | 工具注册表：移除单例引用，导出工厂 | 改 |
| `packages/sdk/src/index.ts` | SDK 根导出：`TodoWriteTool` → `createTodoTool`，删 `getTodos`/`clearTodos` | 改 |
| `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` | sidecar 接线：删单例 import 与 baseTools 引用，按会话构建工厂挂入 task 组 | 改 |

---

## Task 1: 重写 `todo-tool.ts`（工厂 + 隔离 store）+ 测试

**Files:**
- Rewrite: `packages/sdk/src/tools/todo-tool.ts`
- Test: `packages/sdk/src/tools/todo-tool.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `packages/sdk/src/tools/todo-tool.test.ts`：

```ts
import { describe, test, expect } from 'bun:test'
import { createTodoStore, createTodoTool } from './todo-tool.js'
import type { TodoItem } from './todo-tool.js'

const item = (
  content: string,
  status: TodoItem['status'] = 'in_progress',
  activeForm: string = content,
): TodoItem => ({ content, activeForm, status })

describe('createTodoStore', () => {
  test('two stores are isolated', () => {
    const a = createTodoStore()
    const b = createTodoStore()
    a.set([item('A1')])
    expect(b.getAll()).toEqual([])
    b.set([item('B1')])
    expect(a.getAll()).toHaveLength(1)
    expect(a.getAll()[0]!.content).toBe('A1')
  })

  test('set replaces; getAll returns a defensive copy', () => {
    const s = createTodoStore()
    s.set([item('A'), item('B')])
    const got = s.getAll()
    got[0]!.content = 'MUTATED'
    expect(s.getAll()[0]!.content).toBe('A')
  })
})

describe('createTodoTool', () => {
  test('throws without threadId', () => {
    expect(() => createTodoTool({} as never)).toThrow(/threadId/)
  })

  test('isConcurrencySafe is false', () => {
    const tool = createTodoTool({ threadId: 't1' })
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test('allDone clears the list', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({ todos: [item('T1', 'completed')] })
    expect(res.content).toBe('No active todos.')
  })

  test('missing activeForm returns an error', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({
      todos: [{ content: 'T1', status: 'in_progress' }],
    })
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('activeForm')
  })

  test('result is a compact single-state list', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    const res = await tool.call({
      todos: [
        item('Run tests', 'in_progress', 'Running tests'),
        item('Write docs', 'pending', 'Writing docs'),
      ],
    })
    expect(res.content).toBe('[~] Run tests\n[ ] Write docs')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ~/workspace/projects/ai-projects/Lume && bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: FAIL — `todo-tool.js` 仍导出 `TodoWriteTool`，无 `createTodoStore` / `createTodoTool`，import 报错或测试全挂。

- [ ] **Step 3: 重写 `packages/sdk/src/tools/todo-tool.ts`**

整文件替换为：

```ts
/**
 * TodoWriteTool — per-session todo/checklist management.
 *
 * Factory-based: each session builds its own tool instance via
 * createTodoTool({ threadId }). State lives in a per-instance store,
 * so sessions/threads/subagents never share todo state.
 */

import { defineTool } from './types.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** Imperative form, e.g. "Run tests" */
  content: string
  /** Present-continuous form shown during execution, e.g. "Running tests" */
  activeForm: string
  status: TodoStatus
}

const PROMPT = `Use this tool to manage a structured task list for the current session. It tracks progress on multi-step work and shows the user what is being done.

## When to use
- Complex tasks with 3+ distinct steps
- The user provides multiple tasks (numbered or comma-separated)
- After receiving new instructions — capture them as todos immediately
- Before starting a task — mark it in_progress

## When NOT to use
- A single trivial task
- Purely informational or conversational requests
- Fewer than 3 trivial steps

## Rules
- States: pending | in_progress | completed
- Keep EXACTLY ONE task in_progress at a time
- Mark a task completed the moment it is done — do not batch
- Each item needs BOTH forms:
  - content: imperative ("Run tests")
  - activeForm: present continuous ("Running tests")
`

function statusMarker(status: TodoStatus): string {
  if (status === 'completed') return '[x]'
  if (status === 'in_progress') return '[~]'
  return '[ ]'
}

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'No active todos.'
  return todos.map((t) => `${statusMarker(t.status)} ${t.content}`).join('\n')
}

function coerceStatus(value: unknown): TodoStatus {
  if (value === 'in_progress') return 'in_progress'
  if (value === 'completed') return 'completed'
  return 'pending'
}

/**
 * Isolated state container for one session's todos. Each createTodoTool
 * instance owns its own store, so state never leaks across sessions.
 */
export function createTodoStore() {
  const items: TodoItem[] = []
  return {
    set(next: TodoItem[]): void {
      items.length = 0
      for (const t of next) items.push(t)
    },
    getAll(): TodoItem[] {
      return items.slice()
    },
  }
}

/**
 * Build a per-session TodoWrite tool. State is scoped to this instance
 * via an internal store; the module no longer holds any global state.
 */
export function createTodoTool(opts: { threadId: string }) {
  if (!opts?.threadId) {
    throw new Error('createTodoTool requires a threadId')
  }
  const store = createTodoStore()

  return defineTool({
    name: 'TodoWrite',
    description:
      'Update the session todo list. Always provide content (imperative) and activeForm (present continuous) for each task, and keep exactly one task in_progress at a time.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['content', 'activeForm', 'status'],
            properties: {
              content: { type: 'string', minLength: 1 },
              activeForm: { type: 'string', minLength: 1 },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
          },
        },
      },
    },
    isConcurrencySafe: false,
    prompt: PROMPT,
    async call(input: { todos?: unknown }) {
      const incoming = Array.isArray(input?.todos) ? (input.todos as unknown[]) : []

      for (const t of incoming) {
        const todo = t as Record<string, unknown>
        if (typeof todo?.content !== 'string' || todo.content.trim() === '') {
          return { data: 'Error: each todo requires a non-empty content', is_error: true }
        }
        if (typeof todo?.activeForm !== 'string' || todo.activeForm.trim() === '') {
          return { data: 'Error: each todo requires a non-empty activeForm', is_error: true }
        }
      }

      const allDone =
        incoming.length > 0 && incoming.every((t) => coerceStatus((t as { status: unknown }).status) === 'completed')

      const next: TodoItem[] = allDone
        ? []
        : incoming.map((t) => {
            const todo = t as { content: string; activeForm: string; status: unknown }
            return {
              content: todo.content,
              activeForm: todo.activeForm,
              status: coerceStatus(todo.status),
            }
          })

      store.set(next)
      return renderTodos(store.getAll())
    },
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ~/workspace/projects/ai-projects/Lume && bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: PASS — 全部 7 个测试通过。

- [ ] **Step 5: 提交**

```bash
cd ~/workspace/projects/ai-projects/Lume
git add packages/sdk/src/tools/todo-tool.ts packages/sdk/src/tools/todo-tool.test.ts
git commit -m "♻️ refactor(sdk): TodoWrite 改为 per-session 工厂修复跨会话串台

将模块级全局 todoList 改为 createTodoTool({threadId}) 工厂 + createTodoStore 隔离状态；
strict schema 删除 legacy action API；强制 content/activeForm；allDone 自动清空；
result 改紧凑单态；isConcurrencySafe 置 false。

Constraint: 不含 web 面板/resume
Tested: bun test todo-tool.test.ts (7 用例全绿)
Not-tested: sidecar 接线（Task 3）"
```

---

## Task 2: 更新 SDK 导出

**Files:**
- Modify: `packages/sdk/src/tools/index.ts`（行 73-74 import、行 141-142 ALL_TOOLS、行 264-265 re-export）
- Modify: `packages/sdk/src/index.ts`（行 149-150 导出块、行 474-478）

- [ ] **Step 1: 改 `tools/index.ts` import**

`packages/sdk/src/tools/index.ts` 第 73-74 行：

```ts
// 改前
// Todo
import { TodoWriteTool } from './todo-tool.js'
```
改为：
```ts
// Todo
import { createTodoTool } from './todo-tool.js'
```

- [ ] **Step 2: 从 ALL_TOOLS 移除单例**

`packages/sdk/src/tools/index.ts` 第 141-142 行删除：
```ts
  // Todo
  TodoWriteTool,
```
（TodoWrite 现在是工厂，不能放入静态 ALL_TOOLS 池；SDK 独立用户通过 `createTodoTool` 显式接入。）

- [ ] **Step 3: 改 re-export**

`packages/sdk/src/tools/index.ts` 第 264-265 行：
```ts
// 改前
  // Todo
  TodoWriteTool,
```
改为：
```ts
  // Todo
  createTodoTool,
```

- [ ] **Step 4: 改 SDK 根 `index.ts` 导出块**

`packages/sdk/src/index.ts` 第 149-150 行：
```ts
// 改前
  // Todo
  TodoWriteTool,
```
改为：
```ts
  // Todo
  createTodoTool,
```

- [ ] **Step 5: 删 `getTodos`/`clearTodos` 导出**

`packages/sdk/src/index.ts` 第 474-478 行：
```ts
// 改前
export {
  getTodos,
  clearTodos,
} from './tools/todo-tool.js'
export type { TodoItem } from './tools/todo-tool.js'
```
改为（保留 TodoItem 类型导出）：
```ts
export type { TodoItem } from './tools/todo-tool.js'
```

- [ ] **Step 6: 构建验证 SDK**

Run: `cd ~/workspace/projects/ai-projects/Lume/packages/sdk && bun run build`
Expected: `tsc` 编译通过，无类型错误（无 dangling 的 `TodoWriteTool` / `getTodos` / `clearTodos` 引用）。

- [ ] **Step 7: 提交**

```bash
cd ~/workspace/projects/ai-projects/Lume
git add packages/sdk/src/tools/index.ts packages/sdk/src/index.ts
git commit -m "🔥 remove(sdk): 移除 TodoWrite 单例导出改导出 createTodoTool

ToolWrite 从静态 ALL_TOOLS 池移除（工厂需 threadId）；删 getTodos/clearTodos
无消费者导出；保留 TodoItem 类型。

Constraint: getAllBaseTools 不再含 TodoWrite，独立用户改用 createTodoTool
Tested: cd packages/sdk && bun run build 通过"
```

---

## Task 3: 重接 sidecar `run.ts`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（行 28 import、行 599 baseTools、行 ~646 与 ~800 工具组）

- [ ] **Step 1: 改 import（行 28）**

`apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` 第 28 行：
```ts
// 改前
  TodoWriteTool,
```
改为：
```ts
  createTodoTool,
```
（仍在 `from "@lume/agent-sdk"` 导入块内。）

- [ ] **Step 2: 从 `createBaseSdkAlignedTools` 移除单例（行 599）**

`run.ts` 第 598-600 行：
```ts
// 改前
    SkillTool,
    TodoWriteTool,
    LSPTool
```
改为：
```ts
    SkillTool,
    LSPTool
```
（baseTools / `{ source:"sdk" }` 组不再含 todo。）

- [ ] **Step 3: 在 `buildRuntimeCoreTools` 构建实例并挂入 task 组**

在 `buildRuntimeCoreTools` 内、`taskReportTool` 构造之后（约第 649 行后）新增一行：

```ts
  const todoTool = createTodoTool({ threadId: input.sessionId });
```

然后改 `ToolRuntime.build` 的 task 组（约第 800 行）：
```ts
// 改前
      { source: "task", tools: [taskReportTool, sidecarAgentTool] },
```
改为：
```ts
      { source: "task", tools: [taskReportTool, sidecarAgentTool, todoTool] },
```

（todo 与同类 per-session 工厂并列。plan 模式不提供 todo 的现状保持不变——`createBaseSdkAlignedTools` plan 分支本就不含。）

- [ ] **Step 4: 重建 SDK 后 typecheck sidecar**

Run: `cd ~/workspace/projects/ai-projects/Lume && bun run --filter @lume/agent-sdk build && bun run --filter @lume/sidecar typecheck`
Expected: sidecar typecheck 通过（`createTodoTool` 已从 `@lume/agent-sdk` 导出，类型匹配 `ToolDefinition`）。

- [ ] **Step 5: 提交**

```bash
cd ~/workspace/projects/ai-projects/Lume
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "♻️ refactor(sidecar): TodoWrite 按 sessionId 构建 per-session 实例

run.ts 从 @lume/agent-sdk 改 import createTodoTool；baseTools 移除单例；
buildRuntimeCoreTools 按 input.sessionId 构建实例挂入 task 组。

Constraint: plan 模式仍不提供 todo（保持现状）
Tested: sidecar typecheck 通过"
```

---

## Task 4: 全量验证 + 收尾

**Files:** 无新改动，仅验证。

- [ ] **Step 1: 跑全部相关测试**

Run: `cd ~/workspace/projects/ai-projects/Lume && bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: PASS（7 用例）。

- [ ] **Step 2: 确认无残留引用**

搜索全仓 `TodoWriteTool` / `getTodos` / `clearTodos`：
- `TodoWriteTool`：应仅剩字符串名引用（`agent.ts:744` 白名单、`tool-metadata.ts`、`examples/web/feature-catalog.ts`、`tool-approval.ts` 映射），这些是按工具名匹配，无需改动。
- `getTodos` / `clearTodos`：应零命中（已全部删除）。

Run: 在 `packages/` 与 `apps/` 范围搜索这三个符号，人工核对结果符合上述预期。

- [ ] **Step 3: sidecar 完整 typecheck**

Run: `cd ~/workspace/projects/ai-projects/Lume && bun run --filter @lume/agent-sdk build && bun run --filter @lume/sidecar typecheck`
Expected: 通过。

- [ ] **Step 4: 收尾提交（如有）**

若 Step 2 发现需清理的残留引用，单独提交；否则本 Task 无新增 commit。

---

## Self-Review（计划自审）

- **Spec 覆盖**：
  - §1 架构/状态模型 → Task 1（createTodoTool + createTodoStore + TodoItem 三字段）✓
  - §2 工具契约（strict schema / 删 legacy / allDone / 紧凑 result / isConcurrencySafe false）→ Task 1 ✓
  - §3 sidecar 接线（删 import / 移出 baseTools / 挂入 task 组 / plan 现状）→ Task 3 ✓
  - §4 prompt → Task 1 PROMPT 常量 ✓
  - §5 错误处理与测试（threadId 抛错 / 缺字段 is_error / 5 类测试）→ Task 1 测试 ✓
  - 删 getTodos/clearTodos 导出 → Task 2 ✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码 ✓
- **类型一致性**：`createTodoTool({ threadId: string })` 在 Task 1 定义、Task 3 调用签名一致；`TodoItem` 三字段（content/activeForm/status）全文一致；`createTodoStore` 的 `set`/`getAll` 命名一致 ✓
- **命令**：`bun test`、`bun run build`（SDK = tsc）、`bun run --filter @lume/sidecar typecheck` 均取自项目 package.json ✓
