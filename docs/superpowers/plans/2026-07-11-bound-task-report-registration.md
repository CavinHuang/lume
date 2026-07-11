# Bound TaskReport Runtime Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bound Subagent Run structurally capable of submitting exactly one correctly bound `TaskReport` without descriptor, policy, concurrency, or completion-guard mismatches.

**Architecture:** Resolve one validated `{ runId, taskId }` identity at session creation and use it for the bound tool, prompt, and completion guard. Route the host-required report through `ToolRuntime.requiredTools` so it receives a descriptor and wrapper while surviving static visibility policy. Treat the report as a serial mutation and verify the complete coordinator lifecycle.

**Tech Stack:** TypeScript, Bun test, Lume Sidecar Runtime

---

### Task 1: Validate and centralize bound Subagent identity

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`

- [ ] **Step 1: Add failing identity-pair tests**

Add two tests around `createRuntimeCoreSession`:

```ts
await expect(createRuntimeCoreSession(createHookRuntimeSessionInput({
  lumeSessionId: "missing-task-id",
  threadType: "subagent",
  subagentRunId: "run-1",
}))).rejects.toThrow("subagentRunId 与 subagentTaskId 必须同时提供")

await expect(createRuntimeCoreSession(createHookRuntimeSessionInput({
  lumeSessionId: "missing-run-id",
  threadType: "subagent",
  subagentTaskId: "task-1",
}))).rejects.toThrow("subagentRunId 与 subagentTaskId 必须同时提供")
```

- [ ] **Step 2: Run the focused tests and verify both fail**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "绑定 Subagent 身份"`

Expected: both session creations currently resolve instead of rejecting.

- [ ] **Step 3: Implement one validated identity**

Add a small resolver near the runtime input types:

```ts
interface BoundSubagentIdentity {
  runId: string
  taskId: string
}

function resolveBoundSubagentIdentity(input: Pick<CreateRuntimeCoreSessionInput,
  "threadType" | "subagentRunId" | "subagentTaskId"
>): BoundSubagentIdentity | undefined {
  const runId = input.subagentRunId?.trim()
  const taskId = input.subagentTaskId?.trim()
  if (Boolean(runId) !== Boolean(taskId)) {
    throw new Error("subagentRunId 与 subagentTaskId 必须同时提供")
  }
  return input.threadType === "subagent" && runId && taskId ? { runId, taskId } : undefined
}
```

Resolve it once at the start of `createRuntimeCoreSession`. Pass the identity into `buildRuntimeCoreTools`; use it for the bound system prompt, `createBoundSubagentTaskReportTool`, required tool, and completion guard. Remove the separate run/task optional checks in these paths.

- [ ] **Step 4: Run the identity tests and existing child-tool test**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "绑定 Subagent 身份|新运行时只暴露持久化 Agent 任务工具"`

Expected: all selected tests pass.

### Task 2: Make bound TaskReport a serial mutation

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`

- [ ] **Step 1: Add failing read-only consistency assertions**

In the bound explorer child test, retrieve the active tool and descriptor:

```ts
const taskReport = (child.agent as any).toolPool.find((tool: ToolDefinition) => tool.name === "TaskReport")
const descriptor = getRuntimeToolDescriptor("subagent-session", "TaskReport")
expect(taskReport?.isReadOnly?.()).toBe(false)
expect(taskReport?.runtimeMetadata?.isReadOnly).toBe(false)
expect(descriptor?.metadata.isReadOnly).toBe(false)
```

- [ ] **Step 2: Run the focused test and verify the wrapper assertion fails**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "新运行时只暴露持久化 Agent 任务工具"`

Expected: the bound definition currently reports read-only.

- [ ] **Step 3: Correct the bound tool declaration**

Change only the bound tool definition:

```ts
isReadOnly: false,
isConcurrencySafe: false,
```

Do not change global `TaskReport` metadata. Required descriptor creation must retain the inferred mutation metadata and only override `allowedInPlanMode`.

- [ ] **Step 4: Run the focused test and verify all three semantics agree**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "新运行时只暴露持久化 Agent 任务工具"`

Expected: definition, runtime metadata, and descriptor all report non-read-only.

### Task 3: Prove required canonical override uses the bound implementation

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`

- [ ] **Step 1: Add a canonical collision test**

Create two same-name tools with different results:

```ts
const generic = { ...makeTool("TaskReport"), async call() { return { type: "tool_result", tool_use_id: "", content: "generic" } } }
const bound = { ...makeTool("TaskReport"), async call() { return { type: "tool_result", tool_use_id: "", content: "bound" } } }
const tools = ToolRuntime.resolveDynamicTools({
  tools: [generic],
  requiredTools: [bound],
  cwd: "/tmp",
  sessionId,
  permissionMode: "default",
  policyInput: {},
})
expect(tools.filter((tool) => tool.name === "TaskReport")).toHaveLength(1)
expect(await tools.find((tool) => tool.name === "TaskReport")!.call({}, context)).toMatchObject({ content: "bound" })
```

Use the minimal valid SDK tool context already used by nearby tests. Also assert the session descriptor definition is the bound definition.

- [ ] **Step 2: Run the ToolRuntime tests**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`

Expected: required tool collision test passes with exactly one bound implementation. If it fails, correct only the canonical merge order in `ToolRuntime.resolveDynamicTools`.

### Task 4: Verify the real coordinator report and guard lifecycle

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`

- [ ] **Step 1: Add a coordinator-backed integration test**

Use a temporary `LUME_CONFIG_DIR`, reset the coordinator singleton, and create a real `runAgentTask`. Inside its executor:

```ts
expect(coordinator.getRunCompletionBlocker(run.runId)).toContain("TaskReport")
const child = await createRuntimeCoreSession(createHookRuntimeSessionInput({
  lumeSessionId: session.threadId,
  threadType: "subagent",
  subagentType: "explorer",
  subagentRunId: run.runId,
  subagentTaskId: task.taskId,
  permissionMode: "plan",
}))
const taskReport = (child.agent as any).toolPool.find((tool: ToolDefinition) => tool.name === "TaskReport")
await taskReport.call({ status: "submitted", summary: "bound report" }, toolContext)
expect(coordinator.getRunCompletionBlocker(run.runId)).toBeUndefined()
await child.session.dispose()
return { status: "completed" }
```

After `runAgentTask` resolves, assert the result and persisted Run both contain `{ status: "submitted", summary: "bound report" }`.

- [ ] **Step 2: Run the integration test**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "绑定 TaskReport 提交后解除完成守卫"`

Expected: the test passes without completion-guard retries or fallback report synthesis.

- [ ] **Step 3: Run full related verification**

Run:

```powershell
bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent/subagents/subagent-coordinator.test.ts
bun run --filter @lume/sidecar typecheck
git diff --check -- apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: all tests pass, typecheck exits 0, and diff check reports no whitespace errors. Do not commit implementation because the shared worktree contains other in-progress changes.
