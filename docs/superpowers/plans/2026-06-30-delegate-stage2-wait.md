# Delegate 阶段 2（wait 收敛）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** delegate 支持异步并行委派（run_in_background）+ WaitForDelegations 工具收敛多个子会话结果。

**Architecture:** 扩展 `subagent-run-registry` 加 completion Promise 信号量（对标 Proma DelegationRecord.completion，但复用 registry 单例）；delegate background 分支注册/resolve completion；新增 WaitForDelegations sidecar tool（async call 阻塞父）。

**Tech Stack:** TypeScript (Bun)、自研 SDK + sidecar、`bun:test`。

## Global Constraints
- `bun:test`，`cd apps/sidecar && bun test <file>`；typecheck `cd apps/sidecar && bun run typecheck`
- 不引入新依赖；复用既有（registry、runForegroundSubagentWithTimeout、buildSidecarSubagentRunContext、runSidecarSubagent）
- **不自动 commit**（项目规则，commit 需用户同意）；Lore 协议 `✨ feat(sidecar): ...`
- surgical；packageManager bun@1.3.13
- 阶段 1 已实现（commit f5701b87/e58ab15d）：delegateTool 同步、SubagentRun、registry

---

## Task S1: registry completion Promise 信号量

**Files:**
- Modify: `apps/sidecar/src/services/agent/subagents/subagent-run-registry.ts`
- Test: `apps/sidecar/src/services/agent/subagents/subagent-run-registry.test.ts`（追加）

**Interfaces:**
- Consumes: `listByParentSession(parentThreadId)`（既有，:176）、`terminalStatuses`（既有，:78）
- Produces: `createDelegationCompletion(runId)`、`resolveDelegationCompletion(runId)`、`getDelegationCompletion(runId)`、`waitForDelegations({parentThreadId, mode, minCompleted?, timeoutMs})`

- [ ] **Step 1: 写失败测试**（追加到 subagent-run-registry.test.ts）
```ts
import { getSubagentRunRegistry, resetSubagentRunRegistryForTest } from "./subagent-run-registry";

describe("delegation completion signal", () => {
  beforeEach(() => resetSubagentRunRegistryForTest());

  test("resolve 唤醒 waitForDelegations(all)", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running" });
    reg.createDelegationCompletion("r1");
    const wait = reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 1000 });
    reg.resolveDelegationCompletion("r1");
    const result = await wait;
    expect(result.status).toBe("completed");
    expect(result.completedCount).toBe(1);
  });

  test("any 模式 minCompleted=1 首个完成即返回", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running" });
    reg.create({ runId: "r2", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c2", task: "t", cleanup: "keep", status: "running" });
    reg.createDelegationCompletion("r1"); reg.createDelegationCompletion("r2");
    const wait = reg.waitForDelegations({ parentThreadId: "p1", mode: "any", minCompleted: 1, timeoutMs: 1000 });
    reg.resolveDelegationCompletion("r1");
    expect((await wait).status).toBe("completed");
  });

  test("超时返回 timeout", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running" });
    reg.createDelegationCompletion("r1");
    const result = await reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 50 });
    expect(result.status).toBe("timeout");
  });

  test("无 running 立即返回 completed", async () => {
    const reg = getSubagentRunRegistry();
    const result = await reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 1000 });
    expect(result.status).toBe("completed");
    expect(result.runningCount).toBe(0);
  });
});
```

- [ ] **Step 2: 运行验证失败** — `cd apps/sidecar && bun test src/services/agent/subagents/subagent-run-registry.test.ts` → FAIL（方法未定义）

- [ ] **Step 3: 实现**（在 SubagentRunRegistry 类内加 instance 字段 + 方法）
```ts
private delegationCompletions = new Map<string, { completion: Promise<void>; resolve: () => void }>();

createDelegationCompletion(runId: string): void {
  if (this.delegationCompletions.has(runId)) return;
  let resolveFn!: () => void;
  const completion = new Promise<void>((r) => { resolveFn = r; });
  this.delegationCompletions.set(runId, { completion, resolve: resolveFn });
}
resolveDelegationCompletion(runId: string): void {
  const entry = this.delegationCompletions.get(runId);
  if (entry) { entry.resolve(); this.delegationCompletions.delete(runId); }
}
getDelegationCompletion(runId: string): Promise<void> | undefined {
  return this.delegationCompletions.get(runId)?.completion;
}
async waitForDelegations(input: { parentThreadId: string; mode: "all" | "any"; minCompleted?: number; timeoutMs: number }): Promise<{ status: "completed" | "timeout"; completedCount: number; runningCount: number }> {
  const runs = this.listByParentSession(input.parentThreadId);
  const running = runs.filter((r) => !this.terminalStatuses.has(r.status));
  const completedCount = runs.length - running.length;
  if (running.length === 0) return { status: "completed", completedCount, runningCount: 0 };
  const target = input.mode === "any" ? Math.min(Math.max(input.minCompleted ?? 1, 1), runs.length) : runs.length;
  if (completedCount >= target) return { status: "completed", completedCount, runningCount: running.length };
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: "completed" | "timeout") => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      const cur = this.listByParentSession(input.parentThreadId);
      const curRunning = cur.filter((r) => !this.terminalStatuses.has(r.status)).length;
      resolve({ status, completedCount: cur.length - curRunning, runningCount: curRunning });
    };
    const check = () => {
      const cur = this.listByParentSession(input.parentThreadId);
      const done = cur.filter((r) => this.terminalStatuses.has(r.status)).length;
      if (done >= target) finish("completed");
    };
    for (const r of running) {
      const c = this.getDelegationCompletion(r.runId);
      if (c) c.then(check);
    }
    timer = setTimeout(() => finish("timeout"), input.timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}
```
注：`terminalStatuses` 是 registry 既有 private Set（:78），确认可见性；若 private 不可在同类访问则改用 `this.terminalStatuses`（同类可访问 private）。`resetSubagentRunRegistryForTest` 应顺带 clear delegationCompletions（确认）。

- [ ] **Step 4: 运行验证通过 + typecheck** — `bun test ...subagent-run-registry.test.ts && bun run typecheck` → PASS

- [ ] **Step 5: Commit（需同意）** — `✨ feat(sidecar): subagent-run-registry 新增 delegation completion 信号量与 waitForDelegations`

---

## Task S2: delegateTool 异步分支接入 completion

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（delegateTool）
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts`（追加）

**Interfaces:**
- Consumes: S1 的 createDelegationCompletion/resolveDelegationCompletion；既有 background 分支模式（sidecarAgentTool run.ts:713-768）
- Produces: delegateTool 支持 run_in_background=true（立即返回 + completion 注册；onSubagentEnd resolve）

- [ ] **Step 1: 读 delegateTool 当前结构**（run.ts delegateTool，确认它当前强制 runInBackground=false 约 :864，以及 onSubagentEnd）

- [ ] **Step 2: 写失败测试**（验证 delegate background 分支注册了 completion——用 spy/mock registry，或验证 run_in_background=true 时 tool_result 含 status:"started"）
```ts
test("delegate run_in_background=true 立即返回 started 且注册 completion", () => {
  // mock 或验证：delegateTool 收到 run_in_background=true 时，
  // 返回 tool_result.content 含 "started"，且 registry.createDelegationCompletion 被调
  // （具体 mock 方式参照 run.delegate.test.ts 既有风格；若难 mock，验证返回 content 含 started）
});
```
（注：delegateTool.call 深度耦合 runtime，完整 mock 代价高。务实测试：验证 run_in_background=true 的返回 content 含 "started" 字样 + createDelegationCompletion 被调用——后者可能需 spy。若 spy 困难，至少验证返回 started + 集成手动验证 completion。）

- [ ] **Step 3: 实现 delegate background 分支**

在 delegateTool.call 内，移除"强制 runInBackground=false"，加 background 分支（参照 sidecarAgentTool run.ts:713-768）：
```ts
const runInBackground = toolInput.run_in_background === true;
// ... createAgentThread + buildSidecarSubagentRunContext + registry.create（既有）...
if (runInBackground) {
  getSubagentRunRegistry().createDelegationCompletion(subagentRun.runId); // ★注册信号量
  void runSidecarSubagent({ ... })  // 复用既有 executeSubagent 构造
    .then(async (execution) => {
      await enrichedContext.onSubagentEnd?.({ runId: subagentRun.runId, status: execution.status, output: execution.output, error: execution.error });
      getSubagentRunRegistry().resolveDelegationCompletion(subagentRun.runId); // ★resolve
    })
    .catch(async (err: any) => {
      getSubagentRunRegistry().update(subagentRun.runId, { status: "errored", outcome: { error: err?.message ?? String(err) } });
      getSubagentRunRegistry().resolveDelegationCompletion(subagentRun.runId);
      const run = getSubagentRunRegistry().get(subagentRun.runId); if (run) await announceSubagentCompletion({ run });
    });
  return { type: "tool_result" as const, tool_use_id: "", content: JSON.stringify({ delegationId: subagentRun.runId, childThreadId: childMeta.id, status: "started" }) };
}
// run_in_background=false: 保持阶段1 同步（既有 runForegroundSubagentWithTimeout 路径）
```
onSubagentEnd 既有（阶段1 加的，含 registry.update + announce + 标题）。background 分支复用 onSubagentEnd + 额外 resolveDelegationCompletion。

- [ ] **Step 4: 运行测试 + typecheck** — PASS

- [ ] **Step 5: Commit（需同意）** — `✨ feat(sidecar): DelegateTool 支持 run_in_background 异步委派并注册 completion 信号量`

---

## Task S3: WaitForDelegations 工具

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（新增 waitForDelegationsTool + 注册 groups）
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.delegate.test.ts`（追加）

**Interfaces:**
- Consumes: S1 waitForDelegations、listByParentSession
- Produces: WaitForDelegations sidecar tool（注册到 "task" 组）

- [ ] **Step 1: 写失败测试**（mock registry.waitForDelegations 返回，验证 tool 返回结构）
```ts
test("WaitForDelegations 返回结构化结果", async () => {
  // mock getSubagentRunRegistry().waitForDelegations → {status:"completed", completedCount:2, runningCount:0}
  // mock listByParentSession → 2 runs
  // 调 waitForDelegationsTool.call({mode:"all"}, context)
  // 解析返回 content JSON，断言 status/completedCount/delegations
});
```

- [ ] **Step 2: 运行验证失败** — FAIL（工具未定义）

- [ ] **Step 3: 实现 waitForDelegationsTool**（参照 spec §5.3）
```ts
const waitForDelegationsTool: ToolDefinition = {
  name: "WaitForDelegations",
  description: "Wait for previously delegated background child sessions to finish and return their results. Use after Delegate(run_in_background=true). Input: mode 'all'(default)|'any', min_completed (for any), timeout_seconds (default 1800, max 7200).",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["all", "any"] },
      min_completed: { type: "number" },
      timeout_seconds: { type: "number" },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return "Wait for delegated background sessions."; },
  async call(toolInput: any, context: any) {
    const parentThreadId = context.sessionId ?? "";
    const mode = toolInput.mode === "any" ? "any" : "all";
    const timeoutMs = Math.min(Math.max((toolInput.timeout_seconds ?? 1800) * 1000, 1000), 2 * 3600 * 1000);
    const result = await getSubagentRunRegistry().waitForDelegations({ parentThreadId, mode, minCompleted: toolInput.min_completed, timeoutMs });
    const runs = getSubagentRunRegistry().listByParentSession(parentThreadId);
    const delegations = runs.map((r) => ({
      delegationId: r.runId, childThreadId: r.childThreadId, label: r.label, status: r.status,
      ...(r.outcome?.output ? { outputSummary: r.outcome.output.slice(0, 2000) } : {}),
      ...(r.outcome?.error ? { error: r.outcome.error } : {}),
    }));
    return {
      type: "tool_result" as const, tool_use_id: "",
      content: JSON.stringify({ status: result.status, mode, completedCount: result.completedCount, runningCount: result.runningCount, delegations }),
    };
  },
};
```
注册：`groups` 的 `"task"` 组加 `waitForDelegationsTool`（`{ source: "task", tools: [taskReportTool, sidecarAgentTool, delegateTool, waitForDelegationsTool, todoTool] }`）。

- [ ] **Step 4: 运行测试 + typecheck** — PASS

- [ ] **Step 5: Commit（需同意）** — `✨ feat(sidecar): 新增 WaitForDelegations 工具收敛异步委托子会话`

---

## Task S4: prompt 引导

**Files:**
- Modify: `apps/sidecar/src/services/agent/prompt/sections/static-policy-sections.ts`

- [ ] **Step 1: 在阶段1 Delegate 引导后补一句**：异步并行委派用 `Delegate(run_in_background=true)` + `WaitForDelegations` 收敛（适合多个独立长任务并行）。
- [ ] **Step 2: typecheck** — PASS
- [ ] **Step 3: Commit（需同意）** — `📝 docs(sidecar): prompt 补充异步 Delegate + WaitForDelegations 引导`

---

## 阶段 3 验证（无代码，手动）

冒泡代答已实现（deliveryThreadId + approval 改派）。`bun run dev` 手动验证：
1. delegate(run_in_background=true) 子会话内 ask_user → 父会话 banner（标子来源）
2. 父代答 → 子继续
3. permission 同理

若 banner 路由有问题（前端容器未定位），做小修。

## 完成验证（spec §10）
1. delegate(bg) 立即返回 status:"started"
2. 多 delegate(bg) + WaitForDelegations(all) → 全部完成返回
3. WaitForDelegations(any,min=1) → 首个完成返回
4. wait 超时 → status:timeout
5. 阶段3 冒泡代答端到端（手动）
