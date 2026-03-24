# Sidecar RPC Entry Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/sidecar/src/index.ts` 收敛为 sidecar 入口装配层，不再承载具体 RPC 业务逻辑。

**Architecture:** 新增按业务域拆分的 `rpc/*-handlers.ts`，并引入统一的 `createRpcHandlers(...)` 注册器聚合所有 RPC method。`index.ts` 只保留 JSON-RPC 通道、handler 装配和 sidecar 启停逻辑，不改现有服务层行为。

**Tech Stack:** Bun、TypeScript、Zod、JSON-RPC、Tauri sidecar

---

## Chunk 1: RPC 注册器与入口聚合

### Task 1: 为 RPC 注册器补最小失败测试

**Files:**
- Create: `apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("rpc:list-methods 应包含拆分后的关键 method", async () => {
  const handlers = createRpcHandlers(...);
  const methods = await handlers["rpc:list-methods"](undefined);
  expect(methods).toContain("healthcheck");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/sidecar/src/rpc/create-rpc-handlers.test.ts`
Expected: FAIL，因为 `create-rpc-handlers.ts` 尚不存在。

- [ ] **Step 3: Write minimal implementation**

```ts
export function createRpcHandlers(...) {
  return {
    healthcheck: async () => ({ ok: true }),
    "rpc:list-methods": async () => Object.keys(handlers).sort()
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/sidecar/src/rpc/create-rpc-handlers.test.ts`
Expected: PASS

### Task 2: 抽出剩余业务域 handlers 并接入统一注册器

**Files:**
- Create: `apps/sidecar/src/rpc/memory-handlers.ts`
- Create: `apps/sidecar/src/rpc/automation-handlers.ts`
- Create: `apps/sidecar/src/rpc/channel-gateway-handlers.ts`
- Create: `apps/sidecar/src/rpc/system-handlers.ts`
- Create: `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- Modify: `apps/sidecar/src/index.ts`

- [ ] **Step 1: 从 `index.ts` 提取 memory handlers**
- [ ] **Step 2: 从 `index.ts` 提取 automation handlers**
- [ ] **Step 3: 从 `index.ts` 提取 channel gateway handlers**
- [ ] **Step 4: 从 `index.ts` 提取 system/browser/github-release handlers**
- [ ] **Step 5: 创建 `createRpcHandlers(...)` 聚合所有 handler 模块**
- [ ] **Step 6: 改 `index.ts` 使用注册器，删除本地业务 handler 组装**
- [ ] **Step 7: 运行 `bun test apps/sidecar/src/rpc/create-rpc-handlers.test.ts`**

## Chunk 2: 清理与验证

### Task 3: 清理入口层遗留 schema/helper 引用

**Files:**
- Modify: `apps/sidecar/src/index.ts`

- [ ] **Step 1: 删除已迁出的 schema/helper import 与定义**
- [ ] **Step 2: 确保 `index.ts` 只保留入口装配职责**
- [ ] **Step 3: 运行 `bun run --filter @lume/sidecar typecheck`**

### Task 4: 同步过期文档并跑 sidecar 验证

**Files:**
- Modify: `docs/plans/2026-03-24-sidecar-runtime-handoff.md`
- Modify: `docs/plans/openclaw-alignment-full-refactor-plan.md`

- [ ] **Step 1: 更新 handoff 文档中的“下一步”与当前状态**
- [ ] **Step 2: 更新 full refactor plan 中的实际剩余项**
- [ ] **Step 3: 运行 `bun run --filter @lume/sidecar build`**
- [ ] **Step 4: 运行 `bun run --filter @lume/sidecar smoke:agent-new-runtime`**
- [ ] **Step 5: 运行 `bun run --filter @lume/sidecar smoke:agent-new-runtime:error`**
- [ ] **Step 6: 运行 `bun run --filter @lume/sidecar smoke:agent-new-runtime:stop`**
- [ ] **Step 7: 运行 `bun run --filter @lume/sidecar smoke:agent-new-runtime:compact`**
