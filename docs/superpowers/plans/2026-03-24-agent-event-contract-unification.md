# Agent Event Contract Unification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Agent 链路收敛为“共享事件契约 + 最小共享运行时状态契约”两层模型，由 sidecar 单点保证语义，前端只消费稳定合同。

**Architecture:** 保持 `pi-coding-agent AgentSessionEvent` 只在 sidecar 内部存在；`packages/shared` 定义唯一跨层 `AgentEvent` 和新增的 `AgentRuntimeStatus`。sidecar 维护事件归一化与状态快照，web 通过 `desktop-api` 和 atoms 只消费共享合同，不再自行推断关键交互状态。

**Tech Stack:** Bun、TypeScript、Jotai、JSON-RPC、Tauri sidecar、`@mariozechner/pi-coding-agent`

---

## Chunk 1: 共享运行时状态契约

### Task 1: 为最小运行时状态合同写失败测试

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Create: `apps/web/atoms/agent-runtime-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("agent runtime status 应覆盖 streaming / awaiting_permission / awaiting_user_answer", () => {
  const status: AgentRuntimeStatus = {
    phase: "awaiting_permission",
    sessionId: "s1"
  };
  expect(status.phase).toBe("awaiting_permission");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/atoms/agent-runtime-status.test.ts`
Expected: FAIL，因为 `AgentRuntimeStatus` 尚不存在。

- [ ] **Step 3: Write minimal implementation**

```ts
export type AgentRuntimePhase =
  | "idle"
  | "streaming"
  | "awaiting_permission"
  | "awaiting_user_answer"
  | "compacting"
  | "completed"
  | "errored";

export interface AgentRuntimeStatus {
  sessionId: string;
  phase: AgentRuntimePhase;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/atoms/agent-runtime-status.test.ts`
Expected: PASS

### Task 2: 扩展 shared Agent 合同

**Files:**
- Modify: `packages/shared/src/types/agent.ts`

- [ ] **Step 1: 在 shared 中新增 `AgentRuntimePhase`**
- [ ] **Step 2: 新增 `AgentRuntimeStatus` 和最小上下文字段**
- [ ] **Step 3: 为状态订阅/读取预留 IPC 契约类型**
- [ ] **Step 4: Run `bun run --filter @lume/shared typecheck`**

当前状态：
- 已完成 `AgentRuntimePhase` / `AgentRuntimeStatus`
- 已增加 `GET_RUNTIME_STATUS` / `RUNTIME_STATUS_CHANGED`
- 已跑通 `@lume/shared typecheck`

## Chunk 2: sidecar 运行时状态单点维护

### Task 3: 为 sidecar 状态机写失败测试

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime-status-manager.test.ts`
- Create: `apps/sidecar/src/services/agent-runtime-status-manager.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("收到 tool permission request 时应进入 awaiting_permission", () => {
  const manager = createAgentRuntimeStatusManager();
  manager.markAwaitingPermission("s1", "req-1");
  expect(manager.get("s1")?.phase).toBe("awaiting_permission");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/sidecar/src/services/agent-runtime-status-manager.test.ts`
Expected: FAIL，因为状态管理器尚不存在。

- [ ] **Step 3: Write minimal implementation**

```ts
class AgentRuntimeStatusManager {
  private statuses = new Map<string, AgentRuntimeStatus>();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/sidecar/src/services/agent-runtime-status-manager.test.ts`
Expected: PASS

### Task 4: 把 sidecar runtime 事件接入状态机

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/services/agent-service.ts`
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`
- Modify: `apps/sidecar/src/services/pi-agent/subagents/subagent-announce-service.ts`
- Create: `apps/sidecar/src/services/agent-runtime-status-manager.ts`

- [ ] **Step 1: 在 send-message 启动时把状态置为 `streaming`**
- [ ] **Step 2: 在 complete/error/stop/compact 路径更新状态**
- [ ] **Step 3: 在 `onToolPermissionRequest` 路径置为 `awaiting_permission`**
- [ ] **Step 4: 在 `onAskUserQuestion` 路径置为 `awaiting_user_answer`**
- [ ] **Step 5: 在提交 permission/question 答案后恢复到 `streaming` 或终态**
- [ ] **Step 6: 为 subagent announce 后的 delivery/completed 做最小状态对齐**
- [ ] **Step 7: Run `bun test apps/sidecar/src/services/agent-runtime-status-manager.test.ts`**

### Task 5: 暴露 sidecar 状态读取/订阅 IPC

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`

- [ ] **Step 1: 增加 runtime status 的 IPC 常量**
- [ ] **Step 2: 提供按 session 获取状态的 RPC**
- [ ] **Step 3: 如需要，增加状态变化通知 method**
- [ ] **Step 4: Run `bun run --filter @lume/sidecar typecheck`**

当前状态：
- 已完成 sidecar 状态查询/通知 IPC
- 已有 `agent-runtime-status-manager.test.ts`
- 已跑通 `@lume/sidecar typecheck`

## Chunk 3: web 改为消费共享状态

### Task 6: 为 desktop-api/runtime status 写失败测试

**Files:**
- Modify: `apps/web/lib/desktop-api.ts`
- Create: `apps/web/lib/desktop-api.agent-runtime-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("应暴露 getAgentRuntimeStatus", async () => {
  expect(typeof getAgentRuntimeStatus).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/lib/desktop-api.agent-runtime-status.test.ts`
Expected: FAIL，因为 API 尚不存在。

- [ ] **Step 3: Write minimal implementation**

```ts
export async function getAgentRuntimeStatus(sessionId: string) {
  return sidecarCall(...);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/lib/desktop-api.agent-runtime-status.test.ts`
Expected: PASS

### Task 7: 收 front-end 对关键交互状态的本地推断

**Files:**
- Modify: `apps/web/lib/desktop-api.ts`
- Modify: `apps/web/atoms/agent-atoms.ts`
- Modify: `apps/web/components/agent/AgentView.tsx`
- Modify: `apps/web/components/agent/AgentMessages.tsx`

- [ ] **Step 1: 在 web 增加 runtime status 的读取/订阅入口**
- [ ] **Step 2: 在 atoms 中建立当前 session 的共享状态源**
- [ ] **Step 3: 把 `awaiting_permission / awaiting_user_answer / streaming / compacting` 改为共享状态驱动**
- [ ] **Step 4: 删除 atoms 中与这些状态重复的本地推断**
- [ ] **Step 5: Run `bun run --filter @lume/web typecheck`**

当前状态：
- 已完成 `desktop-api` 的 runtime status 读取/订阅入口
- 已将 `streaming / compacting / ask-user / tool-permission` 关键控制面开始切到共享状态/共享请求载荷
- 尚未完全清除所有本地运行态派生逻辑
- 已跑通 `@lume/web typecheck`

## Chunk 4: 验证与文档回写

### Task 8: 回归测试与 smoke

**Files:**
- Modify: `docs/plans/openclaw-alignment-full-refactor-plan.md`
- Modify: `docs/superpowers/specs/2026-03-24-agent-event-contract-unification-design.md`

- [ ] **Step 1: 运行 sidecar 事件/状态相关测试**

Run: `bun test apps/sidecar/src/services/pi-agent/runtime-core/stream-wrappers.test.ts apps/sidecar/src/services/pi-agent/runtime-core/subscribe.test.ts apps/sidecar/src/services/pi-agent/subscribe/map-pi-session-event.test.ts apps/sidecar/src/services/agent-runtime-status-manager.test.ts`
Expected: PASS

- [ ] **Step 2: 运行共享/前端 typecheck**

Run: `bun run --filter @lume/shared typecheck && bun run --filter @lume/web typecheck && bun run --filter @lume/sidecar typecheck`
Expected: PASS

- [ ] **Step 3: 运行运行级 smoke**

Run: `bun run --filter @lume/sidecar smoke:agent-new-runtime && bun run --filter @lume/sidecar smoke:agent-new-runtime:bridges && bun run --filter @lume/sidecar smoke:agent-new-runtime:compact`
Expected: PASS

- [ ] **Step 4: 更新计划文档中的事件/状态统一进展**

Run: 手动更新 `docs/plans/openclaw-alignment-full-refactor-plan.md`
Expected: 文档反映“共享事件 + 共享运行时状态”已经启动实施

当前状态：
- 已完成 `smoke:agent-new-runtime:bridges`
- 已覆盖 `permission / ask-user / subagent announce / runtime status`
