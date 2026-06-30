# 委派式独立子会话（Delegate）阶段 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主 agent 可通过新增 `DelegateTool` 委派一个会话栏可见的独立子会话，会话栏以父子树展示，并支持 hover 预览消息。

**Architecture:** 复用 lume 既有的 `sidecarAgentTool` subagent 执行链路（已是独立 runtime session），增量仅"创建可见 childThread + parentThreadId 关联"。前端在 `lume-sidebar-view-model` 构建父子树，`ThreadItem` 嵌套渲染，新增 `ThreadMiniMapPopover` 做 hover 预览（复用 runtime event 投影 + `GET_RECENT_THREAD_MESSAGES`）。

**Tech Stack:** TypeScript (Bun)、自研 SDK + sidecar、React 18 + Jotai、`bun:test`。

## Global Constraints

- **测试框架**：`bun:test`（前后端统一），import 来自 `'bun:test'`。前端组件测试用 `react-dom/server` 的 `renderToStaticMarkup` + 字符串断言 + jotai `createStore`/`Provider`（**不用** DOM testing library / jsdom / vitest）。
- **测试运行**：`cd apps/sidecar && bun test <file>` 或 `cd apps/web && bun test <file>`（两个 package.json 均无 `test` script）。
- **typecheck**：`cd apps/sidecar && bun run typecheck` / `cd apps/web && bun run typecheck`。
- **commit 规则**：遵循 lume 工作协议——**未经用户显式要求不自动 commit**；commit message 用 Lore 协议：`<emoji> <type>(<scope>): <中文描述>`，scope 如 `sidecar`/`web`/`sdk`/`shared`。
- **复用优先**：不引入新依赖；复用既有 `createAgentThreadWithModelRef`、`buildSidecarSubagentRunContext`、`runSidecarSubagent`、`projectRuntimeEventMessages`、`GET_RECENT_THREAD_MESSAGES`。
- **surgical changes**：只改与本特性直接相关的代码，不重构相邻代码。
- **packageManager**：`bun@1.3.13`。

---

## Task 1: 后端 — DelegateTool 创建可见子会话

DelegateTool 复用 `sidecarAgentTool` 结构，但在 `buildSidecarSubagentRunContext` 之前调用 `createAgentThreadWithModelRef` 创建一个带 `parentThreadId` 的真实 thread，用其 `id` 作为 `childThreadId`，使子会话进入 `agent-sessions.json` 索引（会话栏可见）。

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（新增 `delegateTool` const，约 679 行后；在 805 行 groups 注册）
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts`（新建）

**Interfaces:**
- Consumes: `createAgentThreadWithModelRef(title?, modelRef?, channelId?, workspaceId?, parentThreadId?, modelId?)` from `../../../agent/agent-thread-manager`（返回 `AgentThreadMeta`）；`buildSidecarSubagentRunContext`（同文件 231-291，接受 `createChildThreadId?: () => string`）；`runSidecarSubagent`（同文件，局部函数）；`resolveSubagentSpawnPolicy`（subagent-policy.ts）；`AgentTool`（agent-tool.ts，作为 schema 模板）。
- Produces: `delegateTool: ToolDefinition`（注册到 runtime `"task"` 组，供主 agent 调用）。

- [ ] **Step 1: 写失败测试**

新建 `apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentThread, listAgentThreads } from "../../../agent/agent-thread-manager";

describe("DelegateTool child thread", () => {
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-"));
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
  });

  test("createAgentThread 携带 parentThreadId，子会话进入 listAgentThreads", () => {
    const parent = createAgentThread("父会话", undefined, "ws-1");
    const child = createAgentThread("子会话", undefined, "ws-1", parent.id);
    expect(child.parentThreadId).toBe(parent.id);
    const listed = listAgentThreads();
    expect(listed.find((t) => t.id === child.id)).toBeDefined();
    expect(listed.find((t) => t.id === child.id)?.parentThreadId).toBe(parent.id);
  });
});
```

注意：顶部需 `import { beforeEach } from "bun:test"`（补进第一行 import）。此测试先验证底层 `createAgentThread` 的 `parentThreadId` 通路（Task 1 的基石），后续 Task 在此之上加 DelegateTool 行为。

- [ ] **Step 2: 运行测试验证失败**

```
cd apps/sidecar && bun test src/services/agent-runtime/runtime-core/run.delegate.test.ts
```
Expected: PASS（`createAgentThread` 已支持 `parentThreadId`，这是验证基石已就绪）。若 PASS 说明底层通路 OK，继续；这一步是"地基确认"而非 TDD 红——因为复用的是既有函数。如果 FAIL，说明 `createAgentThread` 签名与预期不符，需先核对 `agent-thread-manager.ts:165-173`。

- [ ] **Step 3: 在 run.ts 新增 delegateTool**

在 `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` 的 `sidecarAgentTool` 定义之后（约 790 行后）新增。`delegateTool` 与 `sidecarAgentTool` 的唯一差异：先 `createAgentThreadWithModelRef` 创建可见子会话，再以其 `id` 作为 `childThreadId`。

```ts
import { createAgentThreadWithModelRef, updateAgentThreadMeta } from "../../../agent/agent-thread-manager";
// （若 run.ts 顶部已 import createAgentThreadWithModelRef 则不重复；updateAgentThreadMeta 用于 Task 3）

const delegateTool: ToolDefinition = {
  ...AgentTool,
  name: "Delegate",
  description:
    "Delegate a task to an INDEPENDENT, sidebar-visible child session. Use for long-running or important tasks that should be tracked as their own conversation. The child session appears under the parent in the sidebar. Returns the child's final result. Only one level of delegation is allowed.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task for the delegated child session" },
      description: { type: "string", description: "A short (3-5 word) description of the task" },
      thread_title: { type: "string", description: "Optional title for the child session (defaults to description)" },
      subagent_type: { type: "string" },
      model: { type: "string" },
      mode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] },
    },
    required: ["prompt", "description"],
  },
  isConcurrencySafe: () => true,
  async call(toolInput: any, context: any) {
    const parentThreadId = context.sessionId ?? "";
    const policy = resolveSubagentSpawnPolicy({ parentThreadId, parentPermissionMode: toolInput.mode });
    if (!policy.ok) {
      return { type: "tool_result" as const, tool_use_id: "", content: policy.error ?? "spawn policy rejected", is_error: true };
    }
    const modelOverride = resolveSubagentModelOverride({ toolInput, workspaceSlug: input.workspaceSlug });
    // ★ 关键差异：创建可见子会话 thread
    const childMeta = createAgentThreadWithModelRef(
      typeof toolInput.thread_title === "string" ? toolInput.thread_title
        : typeof toolInput.description === "string" ? toolInput.description : undefined,
      modelOverride.modelRef,
      modelOverride.channelId ?? input.channelId,
      input.workspaceId,
      parentThreadId, // 建立父子关系
      modelOverride.resolvedModelId ?? context.model,
    );
    const subagentRun = buildSidecarSubagentRunContext({
      parentThreadId,
      parentToolUseId: context.toolUseId,
      toolInput,
      policy,
      createChildThreadId: () => childMeta.id, // ★ 用 thread id 而非随机 uuid
    });
    const enrichedContext = {
      ...context,
      emitEvent: input.emitSdkMessage ? (event: SDKMessage) => { input.emitSdkMessage!(event); } : context.emitEvent,
      onSubagentEnd: async ({ status, output, error }: { status: string; output?: string; error?: string }) => {
        getSubagentRunRegistry().update(subagentRun.runId, { status, outcome: { output, error } });
        const run = getSubagentRunRegistry().get(subagentRun.runId);
        if (run) await announceSubagentCompletion({ run });
      },
    };
    getSubagentRunRegistry().create({
      ...subagentRun.registryInput,
      deliveryThreadId: parentThreadId,
      parentToolUseId: context.toolUseId,
      threadBound: true,
      ...(modelOverride.modelRef ? { modelRef: modelOverride.modelRef } : {}),
      ...(modelOverride.channelId ? { channelId: modelOverride.channelId } : input.channelId ? { channelId: input.channelId } : {}),
      ...(modelOverride.resolvedModelId ? { modelId: modelOverride.resolvedModelId } : context.model ? { modelId: context.model } : {}),
    });
    try {
      const execution = await runForegroundSubagentWithTimeout({
        execution: runSidecarSubagent({
          toolInput: subagentRun.forwardedToolInput,
          context: enrichedContext,
          runId: subagentRun.runId,
          childThreadId: childMeta.id,
          parentThreadId,
          deliveryThreadId: parentThreadId,
          parentToolUseId: context.toolUseId,
          subagentType: typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined,
          modelOverride,
          channelId: modelOverride.channelId ?? input.channelId,
          workspaceId: input.workspaceId,
          permissionMode: toolInput.mode,
        }),
        childThreadId: childMeta.id,
        timeoutMs: resolveForegroundSubagentTimeoutMs(),
        stopSubagent: async (threadId: string) => {
          const { stopAgentRuntime } = await import("./attempt");
          return stopAgentRuntime(threadId);
        },
      });
      await enrichedContext.onSubagentEnd?.({ runId: subagentRun.runId, status: execution.status, output: execution.output, error: execution.error });
      return execution.result;
    } catch (err: any) {
      getSubagentRunRegistry().update(subagentRun.runId, { status: "errored", outcome: { error: err?.message ?? String(err) } });
      throw err;
    }
  },
};
```

注意：`runForegroundSubagentWithTimeout`、`resolveSubagentModelOverride`、`resolveForegroundSubagentTimeoutMs`、`getSubagentRunRegistry`、`announceSubagentCompletion`、`SDKMessage`、`input`（buildRuntimeCoreTools 闭包变量）均为 run.ts 内既有标识符，直接复用；若某个标识符名与实际不符，对照 `sidecarAgentTool`（679-790）的用法修正。`threadBound: true` 字段已存在于 `SubagentRun`（`subagent-run.types.ts:28`）。

- [ ] **Step 4: 注册 delegateTool 到 groups**

在 `buildRuntimeCoreTools` 的 `groups` 数组（约 805 行）的 `"task"` 组加入 `delegateTool`：

```ts
{ source: "task", tools: [taskReportTool, sidecarAgentTool, delegateTool, todoTool] },
```

- [ ] **Step 5: typecheck**

```
cd apps/sidecar && bun run typecheck
```
Expected: PASS（无类型错误）。

- [ ] **Step 6: 运行测试**

```
cd apps/sidecar && bun test src/services/agent-runtime/runtime-core/run.delegate.test.ts
```
Expected: PASS。

- [ ] **Step 7: 手动验证（可选但推荐）**

启动 dev：`bun run dev`。在主会话让模型调用 Delegate 工具（prompt 引导在 Task 8），观察左侧会话栏出现子会话。若暂无 prompt 引导，可临时在 AgentTool 描述里提示测试。

- [ ] **Step 8: Commit（需用户同意）**

```
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts
git commit -m "✨ feat(sidecar): 新增 DelegateTool 创建会话栏可见的独立子会话"
```

---

## Task 2: 后端 — DelegateTool 一级深度拦截（D7）

`resolveSubagentSpawnPolicy` 默认 `maxDepth=3`，不足以实现"只允许一级 delegate"。DelegateTool 内显式校验：当前父 thread 若本身是某个 subagent run 的 child（即 `getLatestByChildThread(parentThreadId)` 存在），则拒绝再 delegate。

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（delegateTool.call 开头加校验）
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts`（追加）

**Interfaces:**
- Consumes: `getSubagentRunRegistry().getLatestByChildThread(threadId)`（subagent-run-registry，返回 `SubagentRun | undefined`）。
- Produces: delegateTool 在子会话上下文中调用时返回 `is_error` 的 tool_result。

- [ ] **Step 1: 追加失败测试**

在 `run.delegate.test.ts` 追加：

```ts
import { getSubagentRunRegistry } from "../../../agent/subagents/subagent-run-registry";
import { canDelegateFromThread } from "./run"; // 新导出的纯函数（Step 3）

describe("DelegateTool depth guard (D7)", () => {
  test("顶层 thread 允许 delegate", () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-delegate-depth-"));
    const parent = createAgentThread("父", undefined, "ws-1");
    expect(canDelegateFromThread(parent.id).ok).toBe(true);
  });

  test("已是子会话的 thread 禁止再 delegate", () => {
    const root = createAgentThread("root", undefined, "ws-1");
    const child = createAgentThread("child", undefined, "ws-1", root.id);
    // 模拟 child 是一个 subagent run 的 childThreadId
    getSubagentRunRegistry().create({
      runId: "run-1", parentThreadId: root.id, rootThreadId: root.id,
      depth: 1, childThreadId: child.id, task: "t", cleanup: "keep", status: "running",
    });
    expect(canDelegateFromThread(child.id).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
cd apps/sidecar && bun test src/services/agent-runtime/runtime-core/run.delegate.test.ts
```
Expected: FAIL（`canDelegateFromThread` 未定义/未导出）。

- [ ] **Step 3: 导出纯函数 canDelegateFromThread**

在 `run.ts`（`delegateTool` 定义之前）新增并 export：

```ts
export function canDelegateFromThread(parentThreadId: string): { ok: boolean; error?: string } {
  const parentRun = getSubagentRunRegistry().getLatestByChildThread(parentThreadId);
  if (parentRun) {
    return { ok: false, error: "委托子会话不能再创建新的委托子会话（仅允许一级）" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: 在 delegateTool.call 接入校验**

在 `delegateTool.call` 内、`resolveSubagentSpawnPolicy` 之后、`createAgentThreadWithModelRef` 之前插入：

```ts
    const depthGuard = canDelegateFromThread(parentThreadId);
    if (!depthGuard.ok) {
      return { type: "tool_result" as const, tool_use_id: "", content: depthGuard.error ?? "depth rejected", is_error: true };
    }
```

- [ ] **Step 5: 运行测试验证通过**

```
cd apps/sidecar && bun test src/services/agent-runtime/runtime-core/run.delegate.test.ts && cd ../.. && cd apps/sidecar && bun run typecheck
```
Expected: PASS + typecheck PASS。

- [ ] **Step 6: Commit（需用户同意）**

```
git commit -m "🐛 fix(sidecar): DelegateTool 限制仅一级委托，子会话内禁止再 delegate"
```

---

## Task 3: 后端 — 子会话完成时补标题

子会话创建时标题是 `description`（可能为空或不准）。完成时调用 `createAutoTitleJob` 或 fallback 更新标题。为保持简单（YAGNI），采用 fallback：完成时若标题仍等于初始 description 或为空，则用 `outcome.output` 前若干字更新。

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（delegateTool 的 `onSubagentEnd`）
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts`（追加）

**Interfaces:**
- Consumes: `updateAgentThreadMeta(id, updates)`（agent-thread-manager.ts:432）；`getAgentThreadMeta(id)`。
- Produces: 子会话完成后 `agent-sessions.json` 中标题更新。

- [ ] **Step 1: 追加失败测试**

```ts
import { getAgentThreadMeta, updateAgentThreadMeta } from "../../../agent/agent-thread-manager";
import { deriveDelegateTitle } from "./run"; // 新导出纯函数

describe("DelegateTool title fallback", () => {
  test("输出非空时用输出摘要作为标题", () => {
    expect(deriveDelegateTitle(undefined, "这是一段很长的子会话输出结果内容")).toBe("这是一段很长的子会话输出结");
  });
  test("输出为空时保留原标题", () => {
    expect(deriveDelegateTitle("原标题", undefined)).toBe("原标题");
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
cd apps/sidecar && bun test src/services/agent-runtime/runtime-core/run.delegate.test.ts
```
Expected: FAIL（`deriveDelegateTitle` 未定义）。

- [ ] **Step 3: 导出 deriveDelegateTitle 并接入 onSubagentEnd**

在 `run.ts` 新增：

```ts
export function deriveDelegateTitle(originalTitle: string | undefined, output: string | undefined): string | undefined {
  if (output && output.trim().length > 0) {
    const trimmed = output.trim().replace(/\s+/g, " ");
    return trimmed.slice(0, 20);
  }
  return originalTitle;
}
```

在 `delegateTool` 的 `onSubagentEnd` 回调内（`getSubagentRunRegistry().update(...)` 之后）追加：

```ts
        const newTitle = deriveDelegateTitle(childMeta.title, output);
        if (newTitle && newTitle !== childMeta.title) {
          updateAgentThreadMeta(childMeta.id, { title: newTitle });
        }
```

- [ ] **Step 4: 运行测试 + typecheck**

```
cd apps/sidecar && bun test src/services/agent-runtime/runtime-core/run.delegate.test.ts && bun run typecheck
```
Expected: PASS。

- [ ] **Step 5: Commit（需用户同意）**

```
git commit -m "✨ feat(sidecar): 委托子会话完成时用输出摘要更新标题"
```

---

## Task 4: 后端 — 父中止级联子会话（D6）

`stopAgent(threadId)` 当前只停单线程。在 `stopAgent` 中止父 thread 后，查找其所有 active 子会话（`subagent-run-registry` 中 `parentThreadId === threadId` 且 `status === 'running'`）并级联 `stopAgentRuntime`。

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`（`stopAgent`，约 994-1001）
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts`（追加）

**Interfaces:**
- Consumes: `getSubagentRunRegistry().listByParentSession(threadId)`（若不存在则用现有查询方法；返回 `SubagentRun[]`）；`stopAgentRuntime(threadId)`（attempt.ts:984）。
- Produces: `stopAgent(parentId)` 会同时中止其运行中的子会话。

- [ ] **Step 1: 确认 registry 查询方法**

先读 `apps/sidecar/src/services/agent/subagents/subagent-run-registry.ts`，确认是否有按 `parentThreadId` 列出 runs 的方法（如 `listByParentSession` / `listControlledByThread`）。记录其确切方法名与签名。若无按 parent+status 过滤的方法，本任务包含新增一个 `listActiveByParentSession(parentThreadId)` 方法。

- [ ] **Step 2: 追加失败测试**

在 `agent-service.test.ts` 追加（参照该文件既有风格；用真实 fs tmp）：

```ts
import { stopAgent } from "./agent-service";
import { getSubagentRunRegistry } from "./subagents/subagent-run-registry";

describe("stopAgent cascade (D6)", () => {
  test("中止父 thread 时级联中止运行中子会话", async () => {
    // setup: tmp LUME_CONFIG_DIR，创建父 thread + 注册 active 子 run
    const parent = createAgentThread("父", undefined, "ws-1");
    getSubagentRunRegistry().create({
      runId: "r1", parentThreadId: parent.id, rootThreadId: parent.id,
      depth: 1, childThreadId: "child-1", task: "t", cleanup: "keep", status: "running",
    });
    stopAgent(parent.id);
    // 给异步 stopAgentRuntime 一点时间
    await new Promise((r) => setTimeout(r, 50));
    // 子 run 应被标记为 canceled/aborted（在 stopAgent 内更新 registry）
    const child = getSubagentRunRegistry().get("r1");
    expect(child?.status === "aborted" || child?.status === "canceled").toBe(true);
  });
});
```

- [ ] **Step 3: 运行验证失败**

```
cd apps/sidecar && bun test src/services/agent/agent-service.test.ts
```
Expected: FAIL（子 run status 仍为 running）。

- [ ] **Step 4: 实现 stopAgent 级联**

在 `agent-service.ts` 的 `stopAgent`（994-1001）改为：

```ts
export function stopAgent(threadId: string): void {
  const sessionStateManager = getSessionStateManager();
  sessionStateManager.delete(threadId);
  getAgentRuntimeStatusManager().markIdle(threadId);
  // ★ D6: 级联中止运行中的委托子会话
  const registry = getSubagentRunRegistry();
  const activeChildren = registry.listActiveByParentSession(threadId); // Step 1 确认/新增的方法
  for (const child of activeChildren) {
    registry.update(child.runId, { status: "aborted" });
    void import("../agent-runtime/runtime-core/attempt")
      .then((m) => m.stopAgentRuntime(child.childThreadId))
      .catch(() => undefined);
  }
  void import("../agent-runtime/runtime-core/attempt")
    .then((module) => module.stopAgentRuntime(threadId))
    .catch(() => undefined);
}
```

若 Step 1 发现需新增 `listActiveByParentSession`，在 `subagent-run-registry.ts` 新增：

```ts
listActiveByParentSession(parentThreadId: string): SubagentRun[] {
  return this.runs.filter((r) => r.parentThreadId === parentThreadId && r.status === "running");
}
```
（实际存储字段名以 registry 实现为准，对照 `getLatestByChildThread`/`countActiveByParentSession` 的写法。）

- [ ] **Step 5: 运行测试 + typecheck**

```
cd apps/sidecar && bun test src/services/agent/agent-service.test.ts && bun run typecheck
```
Expected: PASS。

- [ ] **Step 6: Commit（需用户同意）**

```
git commit -m "🐛 fix(sidecar): 中止父会话时级联中止运行中的委托子会话，避免孤儿进程"
```

---

## Task 4b: 后端 — 父归档级联子会话（D8）

归档父 thread 时级联归档其委托子会话（`parentThreadId === id`），保持会话栏整洁。

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts`（`archiveAgentThread`，约 583）
- Test: `apps/sidecar/src/services/agent/agent-thread-manager.test.ts`（追加；若该文件不存在则新建）

**Interfaces:**
- Consumes: `listAgentThreads()`（返回含 `parentThreadId` 的线程）；`archiveAgentThread(id)`（现有归档）。
- Produces: 归档父会话时子会话一并归档（从 `listAgentThreads` 的 active 视图消失）。

- [ ] **Step 1: 确认归档语义**

读 `archiveAgentThread`（agent-thread-manager.ts:583-586）与 `listAgentThreads` 的过滤条件（约 154-158，`status === 'active'`），确认归档后线程如何被排除（改 `status` 还是设 `trashedAt`）。记录实际归档字段名，供 Step 4 断言。

- [ ] **Step 2: 写失败测试**

```ts
import { archiveAgentThread, createAgentThread, listAgentThreads } from "./agent-thread-manager";

test("归档父会话时级联归档委托子会话", () => {
  process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-archive-"));
  const parent = createAgentThread("父", undefined, "ws-1");
  const child = createAgentThread("子", undefined, "ws-1", parent.id);
  archiveAgentThread(parent.id);
  const listed = listAgentThreads();
  expect(listed.find((t) => t.id === parent.id)).toBeUndefined();
  expect(listed.find((t) => t.id === child.id)).toBeUndefined(); // 子也被归档
});
```

- [ ] **Step 3: 运行验证失败**

```
cd apps/sidecar && bun test src/services/agent/agent-thread-manager.test.ts
```
Expected: FAIL（子会话仍可见）。

- [ ] **Step 4: 实现级联**

在 `archiveAgentThread`（约 583）归档父 thread 之后追加：

```ts
  // ★ D8: 级联归档委托子会话（delegate 仅一级，无孙会话）
  const childThreads = listAgentThreads().filter((t) => t.parentThreadId === id);
  for (const child of childThreads) {
    archiveAgentThread(child.id);
  }
```

- [ ] **Step 5: 运行测试 + typecheck**

```
cd apps/sidecar && bun test src/services/agent/agent-thread-manager.test.ts && bun run typecheck
```
Expected: PASS。

- [ ] **Step 6: Commit（需用户同意）**

```
git commit -m "🐛 fix(sidecar): 归档父会话时级联归档委托子会话"
```

---

## Task 5: 前端 — view-model 父子树构建

扩展 `LumeSidebarThreadItem` 加 `children`/`parentThreadId`/`depth`/`isDelegate`；`buildLumeSidebarViewModel` 按 `parentThreadId` 构建树（根 = `parentThreadId == null`）。

**Files:**
- Modify: `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`
- Test: `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`（追加）

**Interfaces:**
- Consumes: `AgentThreadMeta`（含 `parentThreadId?`，`@lume/shared`）。
- Produces: `LumeSidebarThreadItem` 含 `children?: LumeSidebarThreadItem[]`、`parentThreadId?`、`depth`、`isDelegate`。

- [ ] **Step 1: 追加失败测试**

在 `lume-sidebar-view-model.test.ts` 追加（沿用其 `createThread` fixture 工厂；若工厂不含 `parentThreadId` 则扩展）：

```ts
describe("buildLumeSidebarViewModel delegate tree", () => {
  test("子会话挂在父会话 children 下，根线程不含 parentThreadId", () => {
    const ws = createWorkspace({ id: "ws-1", name: "WS" });
    const parent = createThread({ id: "p1", workspaceId: "ws-1", title: "父", updatedAt: 100 });
    const child = createThread({ id: "c1", workspaceId: "ws-1", title: "子", parentThreadId: "p1", updatedAt: 90 });
    const model = buildLumeSidebarViewModel({
      workspaces: [ws], threads: [parent, child], currentWorkspaceId: "ws-1",
      activeTabId: null, expandedWorkspaceIds: ["ws-1"], pinnedWorkspaceIds: [],
    });
    const wsItem = model.workspaces.find((w) => w.id === "ws-1")!;
    const parentItem = wsItem.threads.find((t) => t.id === "p1")!;
    expect(parentItem.parentThreadId).toBeUndefined();
    expect(parentItem.children?.map((c) => c.id)).toEqual(["c1"]);
    expect(parentItem.children?.[0].depth).toBe(1);
    expect(parentItem.children?.[0].isDelegate).toBe(true);
  });

  test("孤儿子会话（父不在列表）作为根显示", () => {
    const ws = createWorkspace({ id: "ws-1", name: "WS" });
    const orphan = createThread({ id: "o1", workspaceId: "ws-1", parentThreadId: "missing", updatedAt: 1 });
    const model = buildLumeSidebarViewModel({
      workspaces: [ws], threads: [orphan], currentWorkspaceId: "ws-1",
      activeTabId: null, expandedWorkspaceIds: ["ws-1"], pinnedWorkspaceIds: [],
    });
    const wsItem = model.workspaces.find((w) => w.id === "ws-1")!;
    expect(wsItem.threads.find((t) => t.id === "o1")).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
cd apps/web && bun test src/components/app-shell/lume-sidebar-view-model.test.ts
```
Expected: FAIL（`children`/`depth`/`isDelegate` 不存在）。

- [ ] **Step 3: 扩展类型与构建逻辑**

在 `lume-sidebar-view-model.ts` 修改：

```ts
export interface LumeSidebarThreadItem {
  id: string
  title: string
  active: boolean
  pinned: boolean
  updatedAt: number
  parentThreadId?: string
  depth: number
  isDelegate: boolean
  children?: LumeSidebarThreadItem[]
}
```

新增辅助函数（在 `buildThreadItem` 旁）：

```ts
function buildThreadItemFromMeta(thread: AgentThreadMeta, activeTabId: string | null, depth: number): LumeSidebarThreadItem {
  return {
    id: thread.id,
    title: thread.title,
    active: activeTabId === thread.id,
    pinned: !!thread.pinned,
    updatedAt: thread.updatedAt,
    parentThreadId: thread.parentThreadId,
    depth,
    isDelegate: !!thread.parentThreadId,
  }
}
```

修改 `buildLumeSidebarViewModel` 的线程组织逻辑：把每个 workspace 内的线程先按 `parentThreadId` 分桶构建树。替换原 `allThreads = workspaceThreads.map(buildThreadItem)` 段为：

```ts
function buildThreadTree(threads: AgentThreadMeta[], activeTabId: string | null): LumeSidebarThreadItem[] {
  const ids = new Set(threads.map((t) => t.id))
  const childrenByParent = new Map<string, AgentThreadMeta[]>()
  const roots: AgentThreadMeta[] = []
  for (const t of threads) {
    if (t.parentThreadId && ids.has(t.parentThreadId)) {
      const arr = childrenByParent.get(t.parentThreadId) ?? []
      arr.push(t); childrenByParent.set(t.parentThreadId, arr)
    } else {
      roots.push(t)
    }
  }
  const toDepth = (t: AgentThreadMeta, depth: number): LumeSidebarThreadItem => {
    const kids = (childrenByParent.get(t.id) ?? []).map((c) => toDepth(c, depth + 1))
    return { ...buildThreadItemFromMeta(t, activeTabId, depth), ...(kids.length ? { children: kids } : {}) }
  }
  return roots.map((t) => toDepth(t, 0))
}
```

在 workspace 分支与 `unassignedThreads` 分支都用 `buildThreadTree(workspaceThreads, activeTabId)` 替代原 `threads.map(buildThreadItem)`。原 `buildThreadItem` 可保留（其他地方可能引用）或删除（若仅此处用——删除前 grep 确认）。

- [ ] **Step 4: 运行测试 + typecheck**

```
cd apps/web && bun test src/components/app-shell/lume-sidebar-view-model.test.ts && bun run typecheck
```
Expected: PASS。

- [ ] **Step 5: Commit（需用户同意）**

```
git commit -m "✨ feat(web): 会话栏 view-model 按 parentThreadId 构建父子树"
```

---

## Task 6: 前端 — ThreadItem 嵌套渲染 + 完成计数 + 折叠

`ThreadItem` 支持渲染 `children`（缩进 + 左竖线 + 展开箭头），父项显示完成计数 `N/M`。`WorkspaceGroupItem` 递归渲染。

**Files:**
- Modify: `apps/web/src/components/app-shell/ThreadItem.tsx`
- Modify: `apps/web/src/components/app-shell/WorkspaceGroupItem.tsx`（递归渲染）
- Test: `apps/web/src/components/app-shell/ThreadItem.test.tsx`（追加）

**Interfaces:**
- Consumes: `LumeSidebarThreadItem`（含 `children`/`depth`/`isDelegate`，Task 5）；`agentSubagentRunsFamily(threadId)`（取子会话 status 算完成计数）。
- Produces: `ThreadItem` 接受 `children?`、`depth`、`isDelegate` 并递归渲染。

- [ ] **Step 1: 追加失败测试（SSR）**

在 `ThreadItem.test.tsx` 追加：

```ts
import { agentSubagentRunsAtom } from '@/atoms'

function makeDelegateThread(): LumeSidebarThreadItem {
  return { id: 'p1', title: '父', active: false, pinned: false, updatedAt: 1, depth: 0, isDelegate: false,
    children: [{ id: 'c1', title: '子', active: false, pinned: false, updatedAt: 1, parentThreadId: 'p1', depth: 1, isDelegate: true }] }
}

describe('ThreadItem delegate tree', () => {
  test('父会话含子会话时显示完成计数与折叠箭头', () => {
    const store = createStore()
    store.set(agentSubagentRunsAtom, { p1: [{ runId: 'r1', parentThreadId: 'p1', childThreadId: 'c1', status: 'completed', task: '', cleanup: 'keep', rootThreadId: 'p1', depth: 1 } as any] })
    const markup = renderToStaticMarkup(
      <Provider store={store}>
        <ThreadItem thread={makeDelegateThread()} onSelect={() => {}} onTogglePin={() => {}} onArchive={() => {}} onRename={() => {}} />
      </Provider>,
    )
    expect(markup).toContain('1/1') // 完成计数
  })

  test('子会话项有缩进竖线', () => {
    const markup = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ThreadItem thread={{ id: 'c1', title: '子', active: false, pinned: false, updatedAt: 1, parentThreadId: 'p1', depth: 1, isDelegate: true }} onSelect={() => {}} onTogglePin={() => {}} onArchive={() => {}} onRename={() => {}} />
      </Provider>,
    )
    expect(markup).toContain('border-l')
  })
})
```

- [ ] **Step 2: 运行验证失败**

```
cd apps/web && bun test src/components/app-shell/ThreadItem.test.tsx
```
Expected: FAIL（无 `1/1`、无 `border-l`）。

- [ ] **Step 3: ThreadItem 支持嵌套与计数**

在 `ThreadItem.tsx` 修改 props 与渲染（保留既有交互）：

```tsx
interface ThreadItemProps {
  thread: LumeSidebarThreadItem
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
}
```
组件内部：
- 用 `useAtomValue(agentSubagentRunsFamily(thread.id))` 取子 run，算 `completed/total`（仅当 `thread.children?.length`）：
```tsx
const childRuns = useAtomValue(agentSubagentRunsFamily(thread.id)) ?? []
const childTotal = thread.children?.length ?? 0
const childCompleted = childRuns.filter((r) => r.status === 'completed').length
const hasChildren = childTotal > 0
const [expanded, setExpanded] = useState(false)
const indent = thread.depth > 0
```
- 在标题行右侧加：`hasChildren && <span className="...">{childCompleted}/{childTotal}</span>` 与折叠箭头 `<ChevronRight className={cn('...', expanded && 'rotate-90')} />`（点击 `setExpanded(v => !v)`，阻止冒泡 `onSelect`）。
- 容器 `div` 加缩进：`indent && 'border-l-2 border-l-foreground/20 ml-3 pl-2'`，并按 `thread.depth` 加左 padding。
- 组件末尾，`hasChildren && expanded` 时递归渲染 `thread.children.map((c) => <ThreadItem key={c.id} thread={c} ... />)`。

- [ ] **Step 4: WorkspaceGroupItem 无需改（递归在 ThreadItem 内完成）**

确认 `WorkspaceGroupItem` 仍把 `threads`（根线程列表）逐个传 `<ThreadItem />`，递归由 ThreadItem 自己处理。若 `visibleThreads` 的 `slice(0, THREAD_PREVIEW_LIMIT)` 会截断导致子会话计数丢失，确认截断只作用于根线程（子会话在父的 children 内不受影响）——无需改。

- [ ] **Step 5: 运行测试 + typecheck**

```
cd apps/web && bun test src/components/app-shell/ThreadItem.test.tsx && bun run typecheck
```
Expected: PASS。

- [ ] **Step 6: Commit（需用户同意）**

```
git commit -m "✨ feat(web): ThreadItem 支持子会话嵌套渲染与完成计数"
```

---

## Task 7: 前端 — hover 预览（ThreadMiniMapPopover）

新增 hover popup：600ms 防抖；已打开 thread 走 `agentRuntimeEventsFamily` + `projectRuntimeEventMessages`，未打开走 `GET_RECENT_THREAD_MESSAGES`。

**Files:**
- Create: `apps/web/src/components/app-shell/ThreadMiniMapPopover.tsx`
- Modify: `apps/web/src/components/app-shell/ThreadItem.tsx`（接入 hover）
- Test: `apps/web/src/components/app-shell/ThreadMiniMapPopover.test.ts`（新建，纯函数部分）

**Interfaces:**
- Consumes: `agentRuntimeEventsFamily(threadId)`（agent-atoms.ts）；`projectRuntimeEventMessages(events)`（runtime-event-message-projection.ts）；`window.electronAPI.getRecentThreadMessages(threadId, limit)`（preload 暴露的 IPC，对应 `GET_RECENT_THREAD_MESSAGES`）。
- Produces: `useThreadMiniMapHover(delayMs, disabled)` hook 与 `ThreadMiniMapPopover` 组件。

- [ ] **Step 1: 写纯函数失败测试（消息 → 预览文本）**

新建 `ThreadMiniMapPopover.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { summarizeMessageForPreview } from './ThreadMiniMapPopover'

describe('summarizeMessageForPreview', () => {
  test('截断超长文本到 220 字符', () => {
    const long = 'x'.repeat(300)
    expect(summarizeMessageForPreview(long).length).toBe(220)
  })
  test('空文本返回空字符串', () => {
    expect(summarizeMessageForPreview('   ')).toBe('')
  })
})
```

- [ ] **Step 2: 运行验证失败**

```
cd apps/web && bun test src/components/app-shell/ThreadMiniMapPopover.test.ts
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 ThreadMiniMapPopover**

新建 `ThreadMiniMapPopover.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { agentRuntimeEventsFamily } from '@/atoms'
import { projectRuntimeEventMessages } from '@/components/agent/runtime-event-message-projection'

export function summarizeMessageForPreview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.slice(0, 220)
}

const PREVIEW_LIMIT = 12
const HOVER_DELAY_MS = 600

export function useThreadMiniMapHover(delayMs: number = HOVER_DELAY_MS, disabled: boolean = false) {
  const [open, setOpen] = useState(false)
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelAll = () => { if (enterTimer.current) clearTimeout(enterTimer.current); if (leaveTimer.current) clearTimeout(leaveTimer.current) }
  useEffect(() => () => cancelAll(), [])
  useEffect(() => { if (disabled) { cancelAll(); setOpen(false) } }, [disabled])
  const onMouseEnter = () => { if (disabled) return; if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null } if (open) return; enterTimer.current = setTimeout(() => setOpen(true), delayMs) }
  const onMouseLeave = () => { if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null } leaveTimer.current = setTimeout(() => setOpen(false), 160) }
  return { open, setOpen, onMouseEnter, onMouseLeave, cancelNow: () => { cancelAll(); setOpen(false) } }
}

interface PreviewItem { role: string; text: string }

export function useThreadPreviewItems(threadId: string, open: boolean): { items: PreviewItem[]; loading: boolean } {
  const events = useAtomValue(agentRuntimeEventsFamily(threadId))
  const cached = events && (events as any).events?.length > 0
  const [items, setItems] = useState<PreviewItem[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    if (cached) {
      const views = projectRuntimeEventMessages((events as any).events)
      setItems(views.slice(-PREVIEW_LIMIT).map((v: any) => ({ role: v.kind ?? 'assistant', text: summarizeMessageForPreview(typeof v.text === 'string' ? v.text : '') })))
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    void window.electronAPI.getRecentThreadMessages(threadId, PREVIEW_LIMIT)
      .then((res: any) => { if (cancelled) return; setItems((res?.messages ?? []).map((m: any) => ({ role: m.role ?? 'user', text: summarizeMessageForPreview(typeof m.content === 'string' ? m.content : '') }))); setLoading(false) })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, cached, threadId])
  return { items, loading }
}

export function ThreadMiniMapPopover({ threadId, open, anchorRef }: { threadId: string; open: boolean; anchorRef: React.RefObject<HTMLElement | null> }) {
  const { items, loading } = useThreadPreviewItems(threadId, open)
  if (!open) return null
  return createPortal(
    <div className="fixed z-[9999] w-[318px] rounded-lg border bg-popover p-2 shadow-lg" >
      <div className="mb-1 text-xs text-muted-foreground">{items.length} 条</div>
      {loading ? <div className="text-xs text-muted-foreground">加载中…</div>
        : items.map((it, i) => <div key={i} className="truncate text-xs">{it.role}: {it.text}</div>)}
    </div>,
    document.body,
  )
}
```

注意：`agentRuntimeEventsFamily` 返回的 state 结构（`{ events, terminalStatus?, updatedAt }`，见 runtime-event-state.ts）与 `projectRuntimeEventMessages` 的输入/输出字段需在执行时对照 `runtime-event-message-projection.ts` 与 `runtime-message-view.ts` 校准（`v.kind`/`v.text` 字段名以实际 `RuntimeMessageView` 为准）。`window.electronAPI.getRecentThreadMessages` 的暴露名需对照 `apps/web/src/lib/desktop-api/` 与 preload 确认。

- [ ] **Step 4: ThreadItem 接入 hover**

在 `ThreadItem.tsx`：
```tsx
import { useThreadMiniMapHover, ThreadMiniMapPopover } from './ThreadMiniMapPopover'
// 组件内：
const anchorRef = useRef<HTMLDivElement>(null)
const hover = useThreadMiniMapHover(600, editing)
// 容器 div 加 onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave} ref={anchorRef}
// 末尾加 <ThreadMiniMapPopover threadId={thread.id} open={hover.open} anchorRef={anchorRef} />
```

- [ ] **Step 5: 运行测试 + typecheck**

```
cd apps/web && bun test src/components/app-shell/ThreadMiniMapPopover.test.ts && bun run typecheck
```
Expected: PASS。定位/锚点计算可在手动验证时微调（用 `anchorRef.current.getBoundingClientRect()`，见 spec §6.3）。

- [ ] **Step 6: 手动验证**

`bun run dev`，hover 任一会话项 ≥600ms，确认 popup 出现并显示最近消息；hover 已打开 thread（有实时事件）确认走投影分支。

- [ ] **Step 7: Commit（需用户同意）**

```
git commit -m "✨ feat(web): 会话栏新增 hover 消息预览 popup（复用 runtime event 投影与最近消息）"
```

---

## Task 8: prompt 引导 — 引导模型选用 Delegate（可选，建议做）

在 agent system prompt 中说明 `Delegate` 工具的用途（显式委派长任务、需独立可见），区别于 `Agent`（临时探索）。

**Files:**
- Modify: `apps/sidecar/src/services/agent/prompt/sections/`（找到 subagent/工具说明 section，对照既有 Agent 工具说明的位置）

**Interfaces:** 无代码接口；纯 prompt 文本。

- [ ] **Step 1: 定位工具说明 section**

Grep `Delegate|subagent|Agent 工具` in `apps/sidecar/src/services/agent/prompt/sections/`，找到描述 `Agent` 工具用法的位置。

- [ ] **Step 2: 追加 Delegate 说明**

在该 section 加一段：何时用 `Delegate`（长任务、需在会话栏独立追踪、需保留为独立会话）vs `Agent`（临时探索、无需独立会话）。

- [ ] **Step 3: typecheck + 手动验证**

```
cd apps/sidecar && bun run typecheck
```
手动：`bun run dev`，给主会话一个长任务，观察模型是否选用 Delegate。

- [ ] **Step 4: Commit（需用户同意）**

```
git commit -m "📝 docs(sidecar): system prompt 补充 Delegate 工具使用引导"
```

---

## 完成验证（对照 spec §10 成功标准）

1. 主 agent 调 DelegateTool → 会话栏出现子会话（父子树）。
2. 子会话完成 → 结果回传父 + 会话栏显示完成态（`N/M` 更新）。
3. hover 任一会话项 → popup 显示最近消息。
4. 父中止 → 运行中子会话随之 aborted。
5. delegate 子会话内再调 delegate → 被 `canDelegateFromThread` 拒绝。
6. 父归档 → 委托子会话随之归档（会话栏消失）。
