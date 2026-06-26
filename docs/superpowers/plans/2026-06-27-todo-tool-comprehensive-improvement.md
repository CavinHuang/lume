# TodoWrite 工具全面改进 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TodoWrite 的行为约束真正生效（prompt + verificationNudge）、activeForm 被 UI 消费（实时面板 + spinner），并清理 `allowedInPlanMode` 等一致性问题。

**Architecture:** 分 3 阶段。Phase 1（prompt 生效 + nudge）纯后端；Phase 2（UX 可视化 L3）复刻 `TaskContractWrite` 的「工具回调 → emitter/observer → `LumeRuntimeEvent` → 前端 block」数据流，6 个连接点逐字镜像 `onTaskContractUpdated`；Phase 3 清理。todo 状态作为 **per-message block**（`todo_update`，不计入 text，复用 `task_progress` 模式）——这比 spec 原写的「ProjectionState 独立字段」更贴合现有架构，spinner 从当前消息的 block 读 activeForm，面板从 messages 取最新 block。

**Tech Stack:** TypeScript、Bun（`bun:test`）、React、jotai、`@lume/agent-sdk`、`@lume/shared`。

**关联文档：**
- Spec：`docs/superpowers/specs/2026-06-26-todo-tool-comprehensive-improvement-design.md`
- 前序 plan（Phase 0）：`docs/superpowers/plans/2026-06-26-todo-tool-redesign.md`

---

## 前置条件：Phase 0（必须先完成）

当前 HEAD（`ee72ffc9`）SDK 包**编译断裂**。Phase 1/2/3 全部依赖 SDK 可编译 + `createTodoTool` 工厂在 sidecar 接线生效。

执行前序 plan `2026-06-26-todo-tool-redesign.md` 的 **Task 2 / Task 3 / Task 4**：
- 清理 `packages/sdk/src/tools/index.ts:74,142,265`、`packages/sdk/src/index.ts:150,474-478` 的悬挂导出，改为导出 `createTodoTool` / `createTodoStore` / `TodoItem`。
- sidecar `run.ts:28` 改 import `createTodoTool`；`run.ts:599` 移出 baseTools；在 `buildRuntimeCoreTools`（`:639` TaskContract 同位置）实例化 `const todoTool = createTodoTool({ threadId: input.sessionId })` 挂入 tool group。
- `bun run build`（SDK）+ 全仓 typecheck 通过。

**验证 Phase 0 完成的命令：**
```bash
bun run build             # SDK 构建无悬挂符号
bunx tsc --noEmit         # 全仓 typecheck 通过（确认 sidecar run.ts 不再引用 TodoWriteTool）
```

未通过则先做 Phase 0，不要开始下面的任务。

---

## Phase 1 — todo prompt 生效 + verificationNudge

### Task 1.1: 新建 todo prompt section 并挂载到 system prompt

**背景：** `todo-tool.ts:21-41` 的 `PROMPT` 是死代码——sidecar 用 `buildSystemPromptAppend` 组装 system prompt，SDK `engine.ts` 见 `config.systemPrompt` 非空就 return，从不拼 `tool.prompt`。需新建 section 挂载，让软约束真正发到 LLM。

**Files:**
- Create: `apps/sidecar/src/services/agent/prompt/sections/todo-section.ts`
- Create: `apps/sidecar/src/services/agent/prompt/sections/todo-section.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`（import + `:339` 附近挂载）

- [ ] **Step 1: 写失败测试**

创建 `apps/sidecar/src/services/agent/prompt/sections/todo-section.test.ts`：
```typescript
import { describe, test, expect } from 'bun:test'
import { buildTodoSection } from './todo-section'

describe('buildTodoSection', () => {
  test('returns a string starting with a markdown heading', () => {
    const out = buildTodoSection()
    expect(typeof out).toBe('string')
    expect(out.startsWith('## ')).toBe(true)
  })

  test('contains the exactly-one-in_progress rule', () => {
    expect(buildTodoSection()).toContain('EXACTLY ONE task in_progress')
  })

  test('contains the do-not-batch rule', () => {
    expect(buildTodoSection()).toContain('do not batch')
  })

  test('contains the blocked-creates-new-task rule', () => {
    expect(buildTodoSection()).toContain('blocked')
    expect(buildTodoSection()).toContain('new task')
  })

  test('requires both content and activeForm', () => {
    expect(buildTodoSection()).toContain('activeForm')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test apps/sidecar/src/services/agent/prompt/sections/todo-section.test.ts`
Expected: FAIL（`Cannot find module './todo-section'`）

- [ ] **Step 3: 实现 section**

创建 `apps/sidecar/src/services/agent/prompt/sections/todo-section.ts`（内容取自 `todo-tool.ts:21-41` 的 PROMPT，补「被阻塞新建任务」软约束）：
```typescript
export function buildTodoSection(): string {
  return `## TodoWrite — session task list
Use this tool to manage a structured task list for the current session. It tracks progress on multi-step work and shows the user what is being done.

### When to use
- Complex tasks with 3+ distinct steps
- The user provides multiple tasks (numbered or comma-separated)
- After receiving new instructions — capture them as todos immediately
- Before starting a task — mark it in_progress

### When NOT to use
- A single trivial task
- Purely informational or conversational requests
- Fewer than 3 trivial steps

### Rules
- States: pending | in_progress | completed
- Keep EXACTLY ONE task in_progress at a time
- Mark a task completed the moment it is done — do not batch completions
- When blocked on a task, create a new task describing what needs to be resolved instead of marking the blocked task complete
- Each item needs BOTH forms:
  - content: imperative ("Run tests")
  - activeForm: present continuous ("Running tests")`
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test apps/sidecar/src/services/agent/prompt/sections/todo-section.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: 挂载到 buildSystemPromptAppend**

在 `apps/sidecar/src/services/agent/agent-prompt-builder.ts`：

a) 顶部 import 区（与其它 section import 并列）加：
```typescript
import { buildTodoSection } from "./prompt/sections/todo-section";
```

b) 在 `buildSystemPromptAppend` 的 full 分支里，紧接 `buildConversationStyleSection()`（约 `:340`）之后加一行：
```typescript
  sections.push(buildConversationStyleSection());

  sections.push(buildTodoSection());
```

- [ ] **Step 6: 验证 system prompt 含 todo section**

Run: `bun test apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`（若已有；若无，手动 grep 确认）
Expected: 现有用例不回归。

手动抽查（在 sidecar 目录）：
```bash
grep -n "EXACTLY ONE task in_progress" src/services/agent/agent-prompt-builder.ts
```
确认 import 与 push 均已写入。

- [ ] **Step 7: Commit**
```bash
git add apps/sidecar/src/services/agent/prompt/sections/todo-section.ts \
        apps/sidecar/src/services/agent/prompt/sections/todo-section.test.ts \
        apps/sidecar/src/services/agent/agent-prompt-builder.ts
git commit -m "✨ feat(agent): todo prompt section 挂载，让软约束真正发到 LLM"
```

---

### Task 1.2: verificationNudge（批处理完成检测）

**背景：** 防止模型一次性把多个任务标记完成（违反「不要批处理」软约束 = 虚假完成风险）。触发条件用 `oldTodos`/`newTodos` 的 diff 计算，无需 session 历史。

**Files:**
- Modify: `packages/sdk/src/tools/todo-tool.ts`（`call` 实现 `:123-148`）
- Modify: `packages/sdk/src/tools/todo-tool.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/sdk/src/tools/todo-tool.test.ts` 的 `describe('createTodoTool', ...)` 块末尾追加：
```typescript
  test('batch-completing 3+ tasks triggers verification nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    // 先建立 3 个 in_progress/pending 任务
    await tool.call({
      todos: [
        item('A', 'in_progress', 'Doing A'),
        item('B', 'pending', 'Doing B'),
        item('C', 'pending', 'Doing C'),
      ],
    })
    // 一次性把 3 个全标完成 → 批处理
    const res = await tool.call({
      todos: [
        item('A', 'completed', 'Doing A'),
        item('B', 'completed', 'Doing B'),
        item('C', 'completed', 'Doing C'),
      ],
    })
    expect(res.content).toContain('verification')
  })

  test('completing tasks one-at-a-time does NOT trigger nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    await tool.call({ todos: [item('A', 'in_progress', 'Doing A'), item('B', 'pending', 'Doing B')] })
    // 每次只新完成 1 个
    const r1 = await tool.call({ todos: [item('A', 'completed', 'Doing A'), item('B', 'in_progress', 'Doing B')] })
    const r2 = await tool.call({ todos: [item('B', 'completed', 'Doing B')] })
    expect(r1.content).not.toContain('verification')
    expect(r2.content).not.toContain('verification')
  })

  test('batch-completing only 2 tasks does NOT trigger nudge', async () => {
    const tool = createTodoTool({ threadId: 't1' })
    await tool.call({ todos: [item('A', 'in_progress', 'Doing A'), item('B', 'pending', 'Doing B')] })
    const res = await tool.call({
      todos: [item('A', 'completed', 'Doing A'), item('B', 'completed', 'Doing B')],
    })
    expect(res.content).not.toContain('verification')
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: 3 个新用例 FAIL（`res.content` 不含 'verification'）

- [ ] **Step 3: 实现 nudge 逻辑**

修改 `packages/sdk/src/tools/todo-tool.ts`。

a) 在 `renderTodos` 函数（`:49-52`）下方加 nudge 常量与判定函数：
```typescript
const VERIFICATION_NUDGE =
  '\n\n[verification needed] 多个任务被一次性标记为完成。在结束本轮前，请派 code-reviewer 子代理验证这些任务的实现是否真正达成，避免虚假完成。'

/**
 * Detect batch completion: how many tasks became completed in this call that
 * were not already completed before. >=3 indicates likely false completion.
 */
function countNewlyCompleted(prev: TodoItem[], next: TodoItem[]): number {
  const prevCompleted = new Set(prev.filter((t) => t.status === 'completed').map((t) => t.content))
  return next.filter((t) => t.status === 'completed' && !prevCompleted.has(t.content)).length
}
```

b) 修改 `call` 函数（`:123-148`）。在循环前取 `oldTodos`，在 `store.set` 后判定并附加 nudge：
```typescript
    async call(input: { todos?: unknown }) {
      const incoming = Array.isArray(input?.todos) ? input.todos : []

      const oldTodos = store.getAll()
      const next: TodoItem[] = []
      let allDone = incoming.length > 0

      for (const t of incoming) {
        if (!isRecord(t)) {
          return { data: 'Error: each todo must be an object', is_error: true }
        }
        const { content, activeForm } = t
        if (typeof content !== 'string' || content.trim() === '') {
          return { data: 'Error: each todo requires a non-empty content', is_error: true }
        }
        if (typeof activeForm !== 'string' || activeForm.trim() === '') {
          return { data: 'Error: each todo requires a non-empty activeForm', is_error: true }
        }
        const status = coerceStatus(t.status)
        if (status !== 'completed') allDone = false
        next.push({ content, activeForm, status })
      }

      store.set(allDone ? [] : next)
      const base = renderTodos(store.getAll())
      const shouldNudge = !allDone && countNewlyCompleted(oldTodos, next) >= 3
      return shouldNudge ? base + VERIFICATION_NUDGE : base
    },
```

> 注：`!allDone` 保证「全部完成自动清空」路径（`No active todos.`）不附加 nudge——清空是合法的收尾，不是批处理虚假完成。

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: 全部 PASS（含原 7 个 + 新 3 个）

- [ ] **Step 5: 重建 SDK dist（sidecar 消费 dist）**

Run:
```bash
cd packages/sdk && bun run build && cd ../..
```
Expected: 构建成功。

- [ ] **Step 6: Commit**
```bash
git add packages/sdk/src/tools/todo-tool.ts packages/sdk/src/tools/todo-tool.test.ts packages/sdk/dist
git commit -m "✨ feat(sdk): TodoWrite verificationNudge，检测批处理完成并推动验证"
```

---

## Phase 2 — todo UX 可视化（L3）

> 数据流总览（6 个连接点镜像 `onTaskContractUpdated`）：
> ```
> todo-tool call() 内 await onTodoUpdated?(state)
>   → run.ts:644 onTodoUpdated: input.emitTodoUpdated
>   → run.ts input.emitTodoUpdated (← createRuntimeCoreSession :1008 透传)
>   → lume-runner.ts:313 emitTodoUpdated: this.emit.onTodoUpdated（装饰后）
>   → run-loop.ts:103 createObservedRuntimeEmitter 劫持 → observer.recordTodoState(state, emit.onRuntimeEvent)
>   → run-observer.recordTodoState → appendItem(todo_state) + projectRunItemToRuntimeEvents
>   → run-item-events.ts todo_state 分支 → todo.state_updated LumeRuntimeEvent
>   → 前端 applyRuntimeEvent 分支 → todo_update block（附加到 currentAssistant）
> ```

### Task 2.1: SDK 工厂加 onTodoUpdated 回调

**Files:**
- Modify: `packages/sdk/src/tools/todo-tool.ts`
- Modify: `packages/sdk/src/tools/todo-tool.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/sdk/src/tools/todo-tool.test.ts` 末尾追加：
```typescript
  test('onTodoUpdated fires with todos + currentActiveForm after call', async () => {
    let captured: { todos: TodoItem[]; currentActiveForm: string | null } | null = null
    const tool = createTodoTool({
      threadId: 't1',
      onTodoUpdated: (state) => { captured = state },
    })
    await tool.call({
      todos: [
        item('Run tests', 'in_progress', 'Running tests'),
        item('Write docs', 'pending', 'Writing docs'),
      ],
    })
    expect(captured).not.toBeNull()
    expect(captured!.todos).toHaveLength(2)
    expect(captured!.currentActiveForm).toBe('Running tests')
  })

  test('onTodoUpdated currentActiveForm is null when nothing in_progress', async () => {
    let captured: { todos: TodoItem[]; currentActiveForm: string | null } | null = null
    const tool = createTodoTool({
      threadId: 't1',
      onTodoUpdated: (state) => { captured = state },
    })
    await tool.call({ todos: [item('A', 'pending', 'Doing A')] })
    expect(captured!.currentActiveForm).toBeNull()
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: 2 个新用例 FAIL（`onTodoUpdated` 不在工厂签名里）

- [ ] **Step 3: 扩展工厂签名与 call 触发**

修改 `packages/sdk/src/tools/todo-tool.ts`。

a) 在 `TodoItem` 接口（`:13-19`）下方加 `TodoState` 类型：
```typescript
/** Snapshot pushed to the UI via onTodoUpdated. */
export interface TodoState {
  todos: TodoItem[]
  /** activeForm of the single in_progress task, or null if none. */
  currentActiveForm: string | null
}
```

b) 修改工厂签名（`:88`），加回调参数：
```typescript
export function createTodoTool(opts: {
  threadId: string
  onTodoUpdated?: (state: TodoState) => void | Promise<void>
}) {
```

c) 在 `call` 内 `store.set` 之后、返回之前，计算 state 并触发回调。把 Task 1.2 的返回段改为：
```typescript
      store.set(allDone ? [] : next)
      const todos = store.getAll()
      const inProgress = todos.find((t) => t.status === 'in_progress')
      const state: TodoState = {
        todos,
        currentActiveForm: inProgress ? inProgress.activeForm : null,
      }
      await opts.onTodoUpdated?.(state)

      const base = renderTodos(todos)
      const shouldNudge = !allDone && countNewlyCompleted(oldTodos, next) >= 3
      return shouldNudge ? base + VERIFICATION_NUDGE : base
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test packages/sdk/src/tools/todo-tool.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 重建 SDK dist + Commit**
```bash
cd packages/sdk && bun run build && cd ../..
git add packages/sdk/src/tools/todo-tool.ts packages/sdk/src/tools/todo-tool.test.ts packages/sdk/dist
git commit -m "✨ feat(sdk): TodoWrite onTodoUpdated 回调，推送结构化 todo 状态"
```

---

### Task 2.2: 定义 todo 事件类型 + run item + 投影分支

**Files:**
- Modify: `packages/shared/src/types/runtime-event.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-items.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`

- [ ] **Step 1: 加 RuntimeEventType 字面量 + 事件接口 + union 成员**

修改 `packages/shared/src/types/runtime-event.ts`：

a) 在 `RuntimeEventType`（`:5-30`）里，紧接 `| "plan.preview"` 之后加：
```typescript
  | "plan.preview"
  | "todo.state_updated"
```

b) 在 `PlanPreviewRuntimeEvent`（`:153-162`）下方加事件接口（需 import `TodoItem`；若 `@lume/agent-sdk` 在 shared 不可引用，则在此文件本地定义等价的 `TodoItemView`，见下方注）：
```typescript
export interface TodoStateUpdatedRuntimeEvent extends RuntimeEventBase {
  type: "todo.state_updated";
  todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[];
  currentActiveForm: string | null;
}
```
> 注：shared 包不应反向依赖 sdk。这里用内联字面量类型定义 todo item，避免循环依赖。字段与 sdk 的 `TodoItem` 一致。

c) 在 `LumeRuntimeEvent` union（`:359-382`）里，紧接 `| PlanPreviewRuntimeEvent` 之后加：
```typescript
  | PlanPreviewRuntimeEvent
  | TodoStateUpdatedRuntimeEvent
```

- [ ] **Step 2: 加 LumeRunItem 成员**

修改 `apps/sidecar/src/services/agent-runtime/runner/run-items.ts`：

a) 在 `LumeRunItem` union（`:1-11`）加成员：
```typescript
export type LumeRunItem =
  | LumeUserMessageItem
  | LumeAssistantMessageItem
  | LumeToolCallItem
  | LumeToolResultItem
  | LumeModelStreamItem
  | LumePlanPreviewItem
  | LumeTodoStateItem
  | LumeSystemEventItem
  | LumeApprovalItem
  | LumeSubagentItem
  | LumeHandoffItem;
```

b) 在 `LumePlanPreviewItem`（`:73-84`）下方加：
```typescript
export interface LumeTodoStateItem {
  type: "todo_state";
  id: string;
  todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[];
  currentActiveForm: string | null;
  createdAt: string;
}
```

- [ ] **Step 3: 加投影分支**

修改 `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`，在 `projectRunItemToRuntimeEvents` 内、`plan_preview` 分支（`:221-236`）之后加：
```typescript
  if (item.type === "todo_state") {
    return [{
      id: `${run.runId}:${item.id}:todo.state_updated`,
      type: "todo.state_updated",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      todos: item.todos,
      currentActiveForm: item.currentActiveForm
    }];
  }
```

- [ ] **Step 4: typecheck**

Run: `bunx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 5: Commit**
```bash
git add packages/shared/src/types/runtime-event.ts \
        apps/sidecar/src/services/agent-runtime/runner/run-items.ts \
        apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts
git commit -m "✨ feat(shared): todo.state_updated 事件类型与 run item 投影"
```

---

### Task 2.3: observer 新增 recordTodoState

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`

- [ ] **Step 1: 新增 recordTodoState 方法**

修改 `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`，在 `recordPlanPreview`（`:176-202`）下方加（逐字镜像其结构）：
```typescript
  recordTodoState(
    state: { todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[]; currentActiveForm: string | null },
    emitRuntimeEvent?: (event: LumeRuntimeEvent) => void
  ): void {
    this.enqueue(async () => {
      const item: LumeRunItem = {
        type: "todo_state",
        id: `todo:${this.state.runId}:${new Date().toISOString()}`,
        todos: state.todos,
        currentActiveForm: state.currentActiveForm,
        createdAt: new Date().toISOString()
      };
      await this.stateStore.appendItem(this.state.runId, item);
      for (const event of projectRunItemToRuntimeEvents(this.state, item, {
        includeAssistantText: true,
        includeAssistantThinking: true,
        includeModelStreamText: true
      })) {
        emitRuntimeEvent?.(event);
      }
    });
  }
```

> 注：`LumeRunItem` / `LumeRuntimeEvent` / `projectRunItemToRuntimeEvents` 在该文件顶部已 import（`recordPlanPreview` 用到同样的符号）。若 `LumeRunItem` 未 import，参照文件现有 import 补上。

- [ ] **Step 2: typecheck**

Run: `bunx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 3: Commit**
```bash
git add apps/sidecar/src/services/agent-runtime/runner/run-observer.ts
git commit -m "✨ feat(sidecar): run-observer recordTodoState，落盘+投影 todo 状态"
```

---

### Task 2.4: emitter 链路打通（6 个连接点）

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/types.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: AgentRuntimeEmitter 接口加字段**

修改 `apps/sidecar/src/services/agent-runtime/runner/types.ts`，在 `onTaskContractUpdated?`（`:16`）下方加：
```typescript
  onTaskContractUpdated?: (contract: TaskContractRecord, preview?: TaskContractPlanPreview) => void;
  onTodoUpdated?: (state: { todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[]; currentActiveForm: string | null }) => void;
```

- [ ] **Step 2: createObservedRuntimeEmitter 加装饰分支**

修改 `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts` 的 `createObservedRuntimeEmitter`（`:93-110`），在 `onTaskContractUpdated` 分支后加 `onTodoUpdated` 分支：
```typescript
export function createObservedRuntimeEmitter(
  emit: AgentRuntimeEmitter,
  observer: LumeRunObserver
): AgentRuntimeEmitter {
  return {
    ...emit,
    onSdkMessage: (message) => {
      observer.recordSdkMessage(message, emit.onRuntimeEvent);
      emit.onSdkMessage(message);
    },
    onTaskContractUpdated: (contract, preview) => {
      if (preview) {
        observer.recordPlanPreview(preview, emit.onRuntimeEvent);
      }
      emit.onTaskContractUpdated?.(contract, preview);
    },
    onTodoUpdated: (state) => {
      observer.recordTodoState(state, emit.onRuntimeEvent);
      emit.onTodoUpdated?.(state);
    }
  };
}
```

- [ ] **Step 3: lume-runner 透传装饰后字段**

修改 `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts:310-314`，在 `emitTaskContractUpdated` 下方加：
```typescript
      emitSdkMessage: this.emit.onSdkMessage,
      emitAskUserQuestion: this.emit.onAskUserQuestion,
      emitToolPermissionRequest: this.emit.onToolPermissionRequest,
      emitTaskContractUpdated: this.emit.onTaskContractUpdated,
      emitTodoUpdated: this.emit.onTodoUpdated,
      runId: this.observer.getRunId(),
```

- [ ] **Step 4: run.ts input 类型 + 透传 + 实例化传参**

修改 `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` 四处：

a) `CreateRuntimeCoreSessionInput`（`:134` 后）加字段：
```typescript
  emitTaskContractUpdated?: Parameters<typeof createTaskContractWriteTool>[0]["onTaskContractUpdated"];
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
```

b) `buildRuntimeCoreTools` 的 input 类型（`:619` 后）加：
```typescript
  emitTaskContractUpdated?: (contract: TaskContractRecord) => void;
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
```

c) `createRuntimeCoreSession` 透传（`:1008` 后）加：
```typescript
   emitTaskContractUpdated: input.emitTaskContractUpdated,
   emitTodoUpdated: input.emitTodoUpdated,
```

d) 在 `buildRuntimeCoreTools` 内实例化 `createTodoTool`（Phase 0 接线处，约 `:644` 旁）传入回调。定位 Phase 0 已写入的 `const todoTool = createTodoTool({ threadId: input.sessionId })`，改为：
```typescript
  const todoTool = createTodoTool({
    threadId: input.sessionId,
    onTodoUpdated: input.emitTodoUpdated,
  });
```

> 如果 Phase 0 尚未在 `buildRuntimeCoreTools` 内创建 `todoTool`（即还在 baseTools 静态数组里），先回到 Phase 0 完成 wiring，再做本步。

- [ ] **Step 5: typecheck**

Run: `bunx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 6: Commit**
```bash
git add apps/sidecar/src/services/agent-runtime/runner/types.ts \
        apps/sidecar/src/services/agent-runtime/runner/run-loop.ts \
        apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts \
        apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): 打通 onTodoUpdated emitter 链路（工具回调→observer→前端）"
```

---

### Task 2.5: 前端 todo block 类型 + projection 分支

**Files:**
- Modify: `apps/web/src/components/agent/runtime-message-view.ts`
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`

- [ ] **Step 1: 加 block 类型 + view 类型**

修改 `apps/web/src/components/agent/runtime-message-view.ts`：

a) 在 `PlanPreviewView`（约 `:20-23`）下方加：
```typescript
export interface TodoBlockData {
  todos: { content: string; activeForm: string; status: 'pending' | 'in_progress' | 'completed' }[]
  currentActiveForm: string | null
}
```

b) 在 `RuntimeAssistantBlock` 联合（`:25-31`）末尾加成员：
```typescript
export type RuntimeAssistantBlock =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool_call'; id: string; toolCall: RuntimeToolCallView }
  | { type: 'task_progress'; id: string; event: TaskProgressViewEvent }
  | { type: 'memory_context_used'; id: string; event: MemoryContextUsedViewEvent }
  | { type: 'plan_preview'; id: string; preview: PlanPreviewView }
  | { type: 'todo_update'; id: string; data: TodoBlockData }
```

- [ ] **Step 2: applyRuntimeEvent 加 todo.state_updated 分支**

修改 `apps/web/src/components/agent/runtime-event-message-projection.ts`，在 `plan.preview` 分支（`:154-171`）之后加（仿 `task.progress` 的 filter 去重 + push 模式，**不计入 text**）：
```typescript
  if (event.type === 'todo.state_updated') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    state.currentAssistant.blocks = state.currentAssistant.blocks.filter((block) => block.type !== 'todo_update')
    state.currentAssistant.blocks.push({
      type: 'todo_update',
      id: `todo:${event.runId}:${event.createdAt}`,
      data: {
        todos: event.todos,
        currentActiveForm: event.currentActiveForm,
      },
    })
    return
  }
```

> 注：不调用 `recomputeAssistantContent`——todo 块不计入 `assistant.text`，与 `task_progress` 一样只作 UI 展示。

- [ ] **Step 3: 补 token 估算分支**

同文件 `estimateAssistantBlockTokens`（`:644-652`）末尾的 `return 0` 前加：
```typescript
  if (block.type === 'todo_update') {
    return estimateTextTokens(block.data.currentActiveForm ?? '') + estimateValueTokens(block.data.todos)
  }
  return 0
```

- [ ] **Step 4: typecheck**

Run: `bunx tsc --noEmit -p apps/web`（或仓库 web typecheck 命令）
Expected: 无类型错误。

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/agent/runtime-message-view.ts \
        apps/web/src/components/agent/runtime-event-message-projection.ts
git commit -m "✨ feat(web): todo_update block 类型与 projection 分支"
```

---

### Task 2.6: TodoResult 渲染器（tool_result 历史卡片）

**Files:**
- Create: `apps/web/src/components/agent/tool-result-renderers/todo-result.tsx`
- Modify: `apps/web/src/components/agent/tool-result-renderers/index.tsx`

- [ ] **Step 1: 新建渲染器组件**

创建 `apps/web/src/components/agent/tool-result-renderers/todo-result.tsx`（结构照抄 `read-result.tsx`）：
```tsx
interface Props { input: Record<string, unknown>; result: unknown }

interface RenderedTodo { content: string; status?: string }

export function TodoResult({ result }: Props) {
  const raw = String(result ?? '')
  // tool_result.content 形如 "[x] A\n[~] B\n[ ] C"（renderTodos 输出）
  const lines = raw.split('\n').filter((l) => l.trim().length > 0 && l !== 'No active todos.')
  // 只认 [x]/[~]/[ ] 开头的行；忽略其它（如 verificationNudge 文本）
  const todos: RenderedTodo[] = lines.flatMap((line) => {
    const m = line.match(/^\[(x|~| )\]\s+(.*)$/)
    if (!m) return []
    const marker = m[1]!
    const status = marker === 'x' ? 'completed' : marker === '~' ? 'in_progress' : 'pending'
    return [{ content: m[2]!, status }]
  })

  if (todos.length === 0) {
    return <div className="px-3 py-2 text-[12px] text-foreground/50">无活跃任务</div>
  }

  return (
    <div className="space-y-0.5 px-1 py-1">
      {todos.map((t, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px]">
          <span className="font-mono text-foreground/40 w-4">
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◉' : '○'}
          </span>
          <span className={t.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70'}>
            {t.content}
          </span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 注册到 dispatch**

修改 `apps/web/src/components/agent/tool-result-renderers/index.tsx`：

a) import 区（`:13` `DefaultResult` 之前）加：
```tsx
import { TodoResult } from './todo-result'
```

b) switch（`default` 之前）加 case：
```tsx
    case 'TodoWrite': return <TodoResult input={input} result={result} />
```

- [ ] **Step 3: 验证渲染**

Run: `bunx tsc --noEmit -p apps/web`
Expected: 无类型错误。

（可选）若有渲染器测试先例（如 `default-result.test.tsx`），照其模式加一个 `todo-result.test.tsx` 断言 `[~] Run tests` 渲染出 `◉ Run tests`。

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/components/agent/tool-result-renderers/todo-result.tsx \
        apps/web/src/components/agent/tool-result-renderers/index.tsx
git commit -m "✨ feat(web): TodoWrite tool_result 渲染器（历史卡片）"
```

---

### Task 2.7: TodoPanel + spinner 接入 activeForm

**Files:**
- Create: `apps/web/src/components/agent/TodoPanel.tsx`
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`（spinner 文案 `:648-655`、block 分发 `:576-582`、展开行 `:729-747`）

> sticky 面板放在消息列表容器顶部——具体容器组件位置结合现有布局定，本 task 提供 `TodoPanel` 组件与集成接口。

- [ ] **Step 1: 新建 TodoPanel 组件**

创建 `apps/web/src/components/agent/TodoPanel.tsx`：
```tsx
import { Check, Circle, Loader2 } from 'lucide-react'
import type { TodoBlockData } from './runtime-message-view'

export function TodoPanel({ data }: { data: TodoBlockData | null }) {
  if (!data || data.todos.length === 0) return null
  return (
    <div className="mb-2 rounded-lg border border-[#e1e4ec] bg-white px-3 py-2 text-[12px] shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground/60">
        {data.currentActiveForm ? (
          <>
            <Loader2 size={12} className="animate-spin text-[#7567ff]" />
            <span>{data.currentActiveForm}</span>
          </>
        ) : (
          <span>任务列表</span>
        )}
      </div>
      <div className="space-y-0.5">
        {data.todos.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            {t.status === 'completed' ? (
              <Check size={12} className="text-foreground/40" />
            ) : t.status === 'in_progress' ? (
              <Loader2 size={12} className="animate-spin text-[#7567ff]" />
            ) : (
              <Circle size={12} className="text-foreground/30" />
            )}
            <span className={t.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70'}>
              {t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 从消息列表提取最新 todo block 供面板消费**

在渲染消息列表的顶层组件中（持有 `messages: RuntimeMessageView[]` 的容器，结合现有布局定位），取最新 assistant 消息的 `todo_update` block：
```tsx
import { TodoPanel } from './TodoPanel'
import type { TodoBlockData } from './runtime-message-view'

// 在 messages 渲染前，提取最新 todo 状态
const latestTodo: TodoBlockData | null = (() => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const block = [...m.blocks].reverse().find((b) => b.type === 'todo_update')
    if (block && block.type === 'todo_update') return block.data
  }
  return null
})()

// 在消息列表顶部渲染
<TodoPanel data={latestTodo} />
```
> 若消息列表容器不便修改，可改为 jotai atom：在 `applyRuntimeEvent` 侧维护一个 `todoStateAtom`，`TodoPanel` 用 `useAtomValue` 订阅。两种皆可，选改动更小的。

- [ ] **Step 3: spinner 文案改用 activeForm（折叠摘要）**

修改 `apps/web/src/components/agent/RuntimeEventContentBlock.tsx` 的 `MinimalProcessGroup`（`:648-655`）。

在 `summaryUnits` 构造前，从当前 blocks 取 todo activeForm：
```tsx
  // 在 const runningTool = ... 之后、summaryUnits 构造之前加：
  const todoBlock = blocks.find((b): b is Extract<RuntimeAssistantBlock, { type: 'todo_update' }> => b.type === 'todo_update')
  const todoActiveForm = todoBlock?.data.currentActiveForm ?? null
```

把 `:651-655` 的 `正在执行 {runningTool.toolName}` 改为优先显示 activeForm：
```tsx
    summaryUnits.push(
      <span key="run" className="inline-flex items-center gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
        {todoActiveForm ?? `正在执行 ${runningTool.toolName}`}
      </span>,
    )
```

> `RuntimeAssistantBlock` 已在文件顶部 import（`:9`）。

- [ ] **Step 4: 块分发器处理 todo_update（避免落入 tool_call 兜底）**

同文件 `RuntimeEventBlock`（`:576-582`），在 `task_progress` 分支后加：
```tsx
  if (block.type === 'todo_update') {
    return null
  }
```
（todo 实时状态由 sticky 面板 + spinner 承担，对话流内不重复渲染整块。）

- [ ] **Step 5: typecheck**

Run: `bunx tsc --noEmit -p apps/web`
Expected: 无类型错误。

- [ ] **Step 6: 手动验证（开发服务器）**

Run: `bun run dev`（或仓库 web dev 命令）
在对话中触发多步任务，确认：
- 顶部 sticky 面板随 TodoWrite 调用实时刷新。
- spinner 显示 `currentActiveForm`（如「Running tests」）而非「正在执行 TodoWrite」。
- tool_result 卡片渲染为 ✓/◉/○ 列表。

- [ ] **Step 7: Commit**
```bash
git add apps/web/src/components/agent/TodoPanel.tsx \
        apps/web/src/components/agent/RuntimeEventContentBlock.tsx
git commit -m "✨ feat(web): TodoPanel 实时面板 + spinner 接入 activeForm"
```

---

## Phase 3 — 一致性清理

> 经精确代码核查（见 spec self-review 修正），spec 的 P5 多数为伪问题：工具名靠 `canonicalizeAgentToolName` 对齐、`isConcurrencySafe` 经 `defineTool` 包装自洽、call 返回值混用是 `defineTool` 允许的联合类型。唯一真问题：`allowedInPlanMode`。

### Task 3.1: 修正 allowedInPlanMode（真问题）

**背景：** sidecar `tool-metadata.ts:477` 标 `allowedInPlanMode: true`，但 `run.ts:583-588` plan 模式分支不装配 TodoWrite，且 `run.test.ts:467` 断言 plan 模式不含。元数据与运行时矛盾。

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts:471-478`

- [ ] **Step 1: 改元数据**

修改 `apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts:471-478`：
```typescript
// TodoWrite 工具
registerToolMetadata({
  name: "TodoWrite",
  category: "control",
  riskLevel: "low",
  description: "管理任务列表",
  allowedInPlanMode: false
});
```

- [ ] **Step 2: 验证**

Run:
```bash
bunx tsc --noEmit
bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```
Expected: typecheck 通过；`run.test.ts:467`（plan 模式不含 TodoWrite）断言成立。

- [ ] **Step 3: Commit**
```bash
git add apps/sidecar/src/services/agent-runtime/tools/tool-metadata.ts
git commit -m "🐛 fix(sidecar): TodoWrite allowedInPlanMode 改为 false，对齐运行时"
```

---

### Task 3.2: 核查其余「不一致」并记录结论

**背景：** 下列三项经核查判定为**非问题**，本 task 仅做验证并留下证据，不改动代码（避免无谓改动违反 surgical-changes 原则）。

- [ ] **Step 1: 核查工具名 canonical 对齐**

Run:
```bash
grep -rn "canonicalizeAgentToolName" packages/shared/src | head -5
```
读 `canonicalizeAgentToolName` 实现，确认它把 `TodoWrite` → `todo_write`（或反向统一）。结论：前端 `todo_write`（canonical）与 sidecar `TodoWrite`（注册时 canonicalize）经此函数对齐，**无需改动**。

- [ ] **Step 2: 核查 isConcurrencySafe 包装**

确认 `packages/sdk/src/tools/types.ts:24` 的 `isConcurrencySafe: () => config.isConcurrencySafe ?? false`，`todo-tool.ts:121` 传 `false`（boolean）→ 包装成方法 → `todo-tool.test.ts:38` `tool.isConcurrencySafe() === false`。代码自洽，**无需改动**。

- [ ] **Step 3: 核查 call 返回值**

确认 `packages/sdk/src/tools/types.ts:14` 的 call 签名 `Promise<string | { data: unknown; is_error?: boolean }>`，`defineTool` 内部 `:32-37` 统一处理两种形态。混用类型合法，**无需改动**。

- [ ] **Step 4: 记录结论**

在 spec 文件 `docs/superpowers/specs/2026-06-26-todo-tool-comprehensive-improvement-design.md` 的「问题诊断 → P5」末尾追加一行说明三项已核查为非问题（可选；若不想动 spec，本 step 可跳过）。

- [ ] **Step 5:（仅当 Step 1 发现真不对齐才执行）**

若 `canonicalizeAgentToolName` 实际不对齐（如根本不做 case 转换），则把前端 `tool-metadata.ts:306-307` 与 `system-tools-state.ts:44` 的 `todo_write` 统一为与 sidecar 注册名经 canonical 后一致的形式。否则跳过本 step。

> 若 Step 1-3 均确认无需改动，本 task 不产生 commit（纯核查任务）。

---

## 全量验证（所有 Phase 完成后）

- [ ] `bun run build`（SDK）无悬挂符号。
- [ ] `bunx tsc --noEmit` 全仓 typecheck 通过。
- [ ] `bun test`（SDK todo-tool 测试 + sidecar prompt/observer 测试）全过。
- [ ] `bun run dev` 手动验证：多 session 并发不串台；sticky 面板实时刷新；spinner 显示 activeForm；批处理完成触发 nudge。
- [ ] 两个并发 session 的 todo 互不串台（Phase 0 集成测试 + Phase 2 前端隔离）。

---

## 风险与待定项（来自 spec）

- **TodoPanel 放置位置**：sticky 面板放消息列表顶部的具体容器需结合现有布局确认（Task 2.7 Step 2 给了两种集成方式，选改动小的）。
- **verificationNudge 阈值**：≥3 是初始值，实现后观察模型行为再调。
- **spinner activeForm 时机**：TodoWrite 运行期间新 todo 尚未确定，spinner 显示上一次的 activeForm（来自最新 todo block），过渡自然。
