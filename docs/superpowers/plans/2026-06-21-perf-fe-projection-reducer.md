# Phase 2a：projection 抽 applyRuntimeEvent reducer（等价重构）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 2 的第一个子 plan。Phase 2 拆为 2a（本 plan，等价重构奠基）/ 2b（AgentMessages 增量集成 + 引用稳定，性能收益）/ 2c（去 stringify + 订阅粒度）。

**Goal:** 把 `projectRuntimeEventMessages` 的 `forEach`（闭包变量 `messages`/`currentAssistant`/`terminalClosed`）重构为 `applyRuntimeEvent(state, event)` —— 一个 state 参数化的 per-event reducer。**纯等价重构**（行为完全不变，706 行 projection test 作护栏），为 Phase 2b 的增量改造奠基：2b 让 AgentMessages 维护跨 render 的 projection state、只对新事件 `applyRuntimeEvent`，而本 plan 抽出的 `applyRuntimeEvent` 正是 2b 复用的单元。

**Architecture:** 新增 `ProjectionState` 接口 `{ messages, currentAssistant, terminalClosed }` + `applyRuntimeEvent(state, event)`（把现有 forEach body line 18-241 迁移进来，闭包变量改为读/写 `state.xxx`）。`projectRuntimeEventMessages` 改为 `keepLatestVersionTurns(events)` → 循环 `applyRuntimeEvent(state, event)` → 末尾 `flushAssistant`。所有 helper（`applyAssistantProviderTokenUsage`/`appendAssistantTextBlock`/`flushAssistant`/...）不变，只是调用处传 `state.currentAssistant`/`state.messages`。

**Tech Stack:** React + TypeScript + bun:test。无新依赖。

**审查依据:** `runtime-event-message-projection.ts:12-246`（projectRuntimeEventMessages forEach）、`:372-398`（keepLatestVersionTurns）、`:400-428`（MutableAssistantMessage/createAssistantMessage）、706 行 `runtime-event-message-projection.test.ts`（等价护栏）。

**诚实的范围边界（重要）:**
- ✅ **本 plan 做什么**：纯等价重构（forEach → applyRuntimeEvent reducer）。行为零变化。
- ⚠️ **无直接性能收益**：`projectRuntimeEventMessages` 仍全量遍历（每次调都从 init state 跑全部事件）。性能收益在 **2b**（AgentMessages 维护跨 render state，只 apply 新事件）。本 plan 的价值是**抽出 `applyRuntimeEvent` 这个可复用的增量单元 + 确认 706 test 是可靠的等价护栏**——没有这个安全网，2b 改 638 行状态机的执行方式风险极高。
- ⚠️ **不改 stabilize/memo/AgentMessages**：那是 2b/2c。

---

## File Structure

- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts` — 新增 `ProjectionState` + `applyRuntimeEvent`；`projectRuntimeEventMessages` 改用 reducer 循环。
- 不改：`runtime-event-message-projection.test.ts`（706 行作为等价护栏，重构后必须仍全绿）、`agent-message-state.ts`、`AgentMessages.tsx`。

---

## Task 1：确认 706 行 test 基线 + 跑通

**Files:** 无改动（仅验证）

- [ ] **Step 1: 跑 projection test 确认基线**

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts`
Expected: **18 pass / 1 fail**（pre-existing：`keeps context compaction start and completion visible as a status timeline` 失败——production 的 `appendContextCompactionNotice` 有意把 start/progress/completed 合并成单条状态流转 notice，而该 test 期望 3 条独立 timeline，test 过时）。**等价验收 = 重构后保持同一 18 pass / 1 fail**。此失败不在 Phase 2a 范围（纯等价重构不修 test/production），作单独 follow-up。

- [ ] **Step 2: typecheck 基线**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

---

## Task 2：抽 applyRuntimeEvent reducer（等价重构）

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`

这是机械重构：把 forEach body 迁移到 `applyRuntimeEvent`，闭包变量 → state 字段。**不改变任何逻辑**。

- [ ] **Step 1: 新增 ProjectionState 接口**

在 `projectRuntimeEventMessages` 之前（或 `MutableAssistantMessage` 附近）新增：

```ts
interface ProjectionState {
  messages: RuntimeMessageView[]
  currentAssistant: MutableAssistantMessage | null
  terminalClosed: boolean
}
```

- [ ] **Step 2: 抽 applyRuntimeEvent（迁移 forEach body）**

把现有 `projectRuntimeEventMessages` 的 `events.forEach((event) => { ... })` body（line 18-241，从 `if (event.type === 'run.started')` 到 `run.failed`/`run.cancelled` 分支结束）整体迁移到一个新函数 `applyRuntimeEvent`：

```ts
function applyRuntimeEvent(state: ProjectionState, event: LumeRuntimeEvent): void {
  const { messages } = state
  // 迁移规则：原 forEach body 里所有
  //   - `messages`        → `state.messages`（已 const { messages } = state 解构，直接用 messages）
  //   - `currentAssistant`→ `state.currentAssistant`（读用 state.currentAssistant；赋值用 state.currentAssistant = ...）
  //   - `terminalClosed`  → `state.terminalClosed`（同上）
  //   - forEach body 内的 `return` → applyRuntimeEvent 内的 `return`（early return，语义不变）
  // 把 line 18-241 的全部 if/event 分支原样搬进来，只做上述变量替换。
  // 例如：
  if (event.type === 'run.started') {
    state.terminalClosed = false
    return
  }
  if (event.type === 'message.user.submitted') {
    flushAssistant(state.messages, state.currentAssistant)
    state.messages.push({ /* ... 原样 ... */ })
    state.currentAssistant = createAssistantMessage(`assistant:${event.runId}`)
    state.terminalClosed = false
    return
  }
  if (event.type === 'assistant.delta') {
    state.currentAssistant ??= createAssistantMessage(`assistant:${event.runId}`)
    state.currentAssistant.text += event.delta
    appendAssistantTextBlock(state.currentAssistant, event.delta)
    return
  }
  // ... 其余所有分支（task.progress / memory.context.used / context.compaction.* /
  //     usage.updated / im.delivery / subagentOwner / assistant.thinking_delta /
  //     assistant.final / plan.preview / tool.started/completed/failed/permission_timeout /
  //     run.completed/turn_limited/failed/cancelled）原样迁移，变量替换如上。
}
```

> **迁移要点**：
> - `currentAssistant ??= createAssistantMessage(...)` 这类短路赋值：原 `currentAssistant = createAssistantMessage(...)` 在闭包里；迁移后 `state.currentAssistant ??= ...` 或 `if (!state.currentAssistant) state.currentAssistant = ...`。**注意**：原代码用 `currentAssistant ??=` 和 `currentAssistant =`（无 ??）。仔细对照原逻辑——有些是 `currentAssistant ??=`（line 59/119/126 等，仅当 null 才建），有些分支假设 currentAssistant 已存在。**原样保留每个分支的赋值语义**（??= vs =），只把 `currentAssistant` → `state.currentAssistant`。
> - helper 调用（`applyAssistantProviderTokenUsage(messages, currentAssistant, ...)`、`applyAssistantImDelivery(messages, currentAssistant, event)`、`markSubagentToolCall(currentAssistant, ...)` 等）：传 `state.messages`/`state.currentAssistant`。
> - `getSubagentOwner(event)` 后的 `if (currentAssistant) { markSubagentToolCall(currentAssistant, ...) }` → `if (state.currentAssistant) { markSubagentToolCall(state.currentAssistant, ...) }`。
> - `terminalClosed` 的读（`if (terminalClosed) return` line 103）→ `if (state.terminalClosed) return`。

- [ ] **Step 3: projectRuntimeEventMessages 改用 reducer 循环**

替换现有 `projectRuntimeEventMessages`（line 12-246）为：

```ts
export function projectRuntimeEventMessages(events: LumeRuntimeEvent[]): RuntimeMessageView[] {
  const kept = keepLatestVersionTurns(events)
  const state: ProjectionState = {
    messages: [],
    currentAssistant: null,
    terminalClosed: false,
  }
  for (const event of kept) {
    applyRuntimeEvent(state, event)
  }
  flushAssistant(state.messages, state.currentAssistant)
  return state.messages
}
```

> `keepLatestVersionTurns` 预处理保持不变（它在 forEach 之前，line 13）。末尾 `flushAssistant(state.messages, state.currentAssistant)` 保持（原 line 244）。

- [ ] **Step 4: 运行 706 test 确认等价（核心验证）**

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts`
Expected: **与 Task 1 基线完全一致**（18 pass / 1 fail，同一个 compaction timeline 既有失败不变）。这是等价重构的核心证据——706 行 test 覆盖各种事件序列，pass/fail 与基线一致说明 applyRuntimeEvent 与原 forEach 行为一致。任何 pass→fail 或 fail→pass 的变化 = 迁移引入了行为差异，必须修。

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/runtime-event-message-projection.ts
git commit -m "♻️ refactor(web): projection 抽 applyRuntimeEvent reducer（等价重构，为增量奠基）"
```

---

## Task 3：集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: agent 相关回归**

Run: `bun test apps/web/src/components/agent/ 2>&1 | tail -5`
Expected: 无新增失败。注意：`apps/web` 有既有的非 projection 失败（如 WelcomeView 的 desktop-api openInSystem，Phase 1 已确认是 feat/new-ui 既有问题）——那些与本 plan 无关，只需确认 projection/state 相关 test 全绿。

- [ ] **Step 2: 隔离对比确认零回归（可选但推荐）**

若 Step 1 有失败且不确定是否本 plan 引起：
```bash
git stash  # 暂存（若有未提交）—— 本 plan 已 commit，工作区应干净，跳过
git checkout HEAD~1 -- apps/web/src/components/agent/runtime-event-message-projection.ts
bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts  # 旧实现
git checkout HEAD -- apps/web/src/components/agent/runtime-event-message-projection.ts  # 恢复
```
对比新旧 pass 数。

- [ ] **Step 3: 确认 applyRuntimeEvent 已为 2b 就绪**

人工确认：`applyRuntimeEvent(state, event)` 是纯函数式（接收 state，mutable 改 state，无外部依赖）——这使 2b 能让 AgentMessages 维护 `useRef<ProjectionState>`，每帧只对新事件 `applyRuntimeEvent`。确认 `applyRuntimeEvent` 不引用任何模块级可变状态（它应该是自包含的）。

---

## 注意事项与边界

- **纯等价重构**：本 plan 不改任何行为。706 行 test 是等价护栏——重构后 pass 数必须与基线一致。这是核心验收标准。
- **无性能收益**：`projectRuntimeEventMessages` 仍全量（每次从 init state 跑全部事件）。性能在 2b。本 plan 的价值是抽出可复用的 `applyRuntimeEvent` + 确认 706 test 可靠。
- **迁移风险点**：forEach 的闭包变量（`currentAssistant`/`terminalClosed`/`messages`）→ state 字段时，仔细保留每个分支的赋值语义（`??=` vs `=`，`if (currentAssistant)` 守卫等）。逐分支对照原 line 18-241。
- **keepLatestVersionTurns 不变**：它是 forEach 前的全局预处理，本 plan 保持。增量处理 version turns 是 2b/2c 的事（2b 用 fallback）。
- **不动 stabilize/memo/AgentMessages**：2b/2c。
- **applyRuntimeEvent 的可见性**：它是 `runtime-event-message-projection.ts` 内的模块级函数（非 export）。2b 若需在 AgentMessages 用，届时再决定 export 或在 2b 内联。本 plan 不 export（YAGNI）。
