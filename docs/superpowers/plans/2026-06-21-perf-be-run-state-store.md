# Phase 3a：run-state-store append-only 改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 3（后端事件存储 append-only）的第一个子 plan。Phase 3 拆为 3a/3b/3c/3d，本 plan 只做 `run-state-store`（最高频、与流式吞吐最直接）。

**Goal:** 消除 `appendItem` 每次「读全量 items → push → 整文件原子重写」的 O(n) 写放大（run-observer 对每条 SDK 事件调用），改为 append-only 单行追加 O(1)；同时让不含 `generatedItems` 的 `update`（run-observer 高频状态更新）不再冗余读写 items.jsonl。

**Architecture:** `run-state-store` 持久化为两个文件：`{runId}.json`（state 元数据，`generatedItems` 恒为 `[]`）+ `{runId}.items.jsonl`（每行一个 item 的 NDJSON）。改造点：(1) `appendItem` 不再 `get`+`update`，直接 `appendFileSync` 单行；(2) `update` 改为只读写 `state.json`，**仅当 `patch.generatedItems !== undefined` 时**才重写 items.jsonl（保留 handoff-service 的转换能力）；(3) create 写初始 items 时统一以 `\n` 结尾，保证 append-only 格式一致。`get` 不变（已用 `readJsonlFile` 读 NDJSON）。

**Tech Stack:** Bun + `node:fs`（`appendFileSync`/`writeFileSync`/`renameSync`/`existsSync`）+ `bun:test` + `mkdtempSync(tmpdir)` 文件测试。

**审查依据:** `run-state-store.ts:101-106`（appendItem 全量重写）、`:84-99`（update 无条件重写 items）、调用方 `run-observer.ts:136/193/216/231`（每事件 appendItem，高频）+ `:162/243/343`（update 不含 generatedItems）+ `handoff-service.ts:91-93`（update 含 generatedItems）。

---

## File Structure

- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.ts` — appendItem 改 append-only；update 仅按需重写 items；create 统一尾 `\n`。
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.test.ts` — 在现有 1 个用例基础上追加 characterization（多次 append 累积、update-含-generatedItems 重写、update-不含-generatedItems 不动 items）。
- Create: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts` — append N items 计时基准（改造前后对比）。

---

## Task 1：追加 characterization test 与基准

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.test.ts`
- Create: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts`

- [ ] **Step 1: 追加 characterization 用例（固定现有 + 即将改变的行为）**

现有 test 文件已有 1 个用例（`persists run state, appended items, and active run lookup`），覆盖 create + 单次 appendItem + update(状态字段) + get + listByThread + findActiveByThread。在该 `describe("run-state-store", ...)` 块内**追加**以下用例（复用现有 `makeState` helper）：

```ts
  test("多次 appendItem 累积后 get 返回全部 items（append-only 正确性）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-acc", "running"));
    for (let i = 1; i <= 5; i++) {
      await store.appendItem("run-acc", {
        type: "system_event", id: `item-${i}`, name: "n", createdAt: `2026-04-29T00:00:0${i}.000Z`
      });
    }
    const stored = await store.get("run-acc");
    expect(stored?.generatedItems.map((i) => i.id)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
  });

  test("update 不含 generatedItems 时不改动 items.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-u1", "running"));
    await store.appendItem("run-u1", { type: "system_event", id: "keep-1", name: "n", createdAt: "2026-04-29T00:00:01.000Z" });
    await store.update("run-u1", { status: "waiting_for_approval" });
    const stored = await store.get("run-u1");
    expect(stored?.status).toBe("waiting_for_approval");
    expect(stored?.generatedItems.map((i) => i.id)).toEqual(["keep-1"]);
  });

  test("update 含 generatedItems 时重写 items（handoff 兼容）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-run-state-store-"));
    const store = createFileBackedLumeRunStateStore(dir);
    await store.create(makeState("run-u2", "running"));
    await store.appendItem("run-u2", { type: "system_event", id: "orig-1", name: "n", createdAt: "2026-04-29T00:00:01.000Z" });
    // 模拟 handoff-service：传入转换后的完整 generatedItems
    await store.update("run-u2", {
      generatedItems: [
        { type: "system_event", id: "orig-1", name: "n", createdAt: "2026-04-29T00:00:01.000Z", handoff: true } as any,
        { type: "system_event", id: "new-2", name: "n", createdAt: "2026-04-29T00:00:02.000Z" }
      ]
    });
    const stored = await store.get("run-u2");
    expect(stored?.generatedItems.map((i) => i.id)).toEqual(["orig-1", "new-2"]);
    expect((stored?.generatedItems[0] as any).handoff).toBe(true);
  });
```

> 现有用例 + 这 3 个新用例共同构成护栏：它们在改造后必须全部通过（append-only 累积、update 分支行为、get 闭环）。当前实现下它们应已通过（改造前的实现也满足这些行为）——先用它们锁定基线。

- [ ] **Step 2: 运行 test 确认基线**

Run: `bun test apps/sidecar/src/services/agent-runtime/runner/run-state-store.test.ts`
Expected: 4 pass / 0 fail（原 1 + 新 3）。若某个新用例在当前实现下失败，说明对现有行为的理解有误——先修正测试再继续。

- [ ] **Step 3: 写基准脚本**

Create `apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts`:

```ts
// 手动基准脚本：bun apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts
// 不被 bun test 自动收集；用于量化 appendItem 改造前后的耗时差异。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
import type { LumeRunState } from "./run-state";

function makeState(runId: string): LumeRunState {
  const now = new Date("2026-04-29T00:00:00.000Z").toISOString();
  return {
    version: 1, runId, threadId: "thread-1", rootAgentId: "root", currentAgentId: "root",
    status: "running", input: { userMessage: "hi", permissionMode: "default" },
    generatedItems: [], pendingInterruptions: [], approvals: { alwaysAllowedTools: [] },
    traceId: `trace-${runId}`, model: { provider: "openai", modelId: "gpt-test" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, createdAt: now, updatedAt: now
  };
}

const dir = mkdtempSync(join(tmpdir(), "lume-run-state-bench-"));
const store = createFileBackedLumeRunStateStore(dir);
await store.create(makeState("bench-1"));
const N = 500;
const start = performance.now();
for (let i = 1; i <= N; i++) {
  await store.appendItem("bench-1", { type: "system_event", id: `item-${i}`, name: "n", createdAt: `2026-04-29T00:00:00.000Z` });
}
const elapsed = performance.now() - start;
const stored = await store.get("bench-1");
console.log(`appendItem x${N}: ${elapsed.toFixed(1)}ms, items=${stored?.generatedItems.length}`);
```

- [ ] **Step 4: 运行基准记录基线 B0**

Run: `bun apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts`
Expected: 打印耗时（记为 **B0**，例如 `appendItem x500: XXXms`）。当前实现是 O(n²)（每次 get 读全量 + 重写全量），N=500 应在几十~几百 ms 量级。

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runner/run-state-store.test.ts apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts
git commit -m "test(sidecar): run-state-store 追加 append-only characterization 与基准"
```

---

## Task 2：appendItem 改 append-only + create 统一尾换行

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.ts`

- [ ] **Step 1: import appendFileSync**

文件顶部 `import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";` 改为加入 `appendFileSync`：

```ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
```

- [ ] **Step 2: create 写初始 items 时统一以 \n 结尾**

修改 `create`（当前 line 67-72），让初始 items.jsonl 每行以 `\n` 结尾（保证后续 append 格式一致）：

```ts
  async create(state: LumeRunState): Promise<void> {
    mkdirSync(this.runsDir, { recursive: true });
    writeTextAtomic(this.statePath(state.runId), JSON.stringify({
      ...state,
      generatedItems: []
    }, null, 2));
    if (state.generatedItems.length > 0) {
      writeTextAtomic(
        this.itemsPath(state.runId),
        state.generatedItems.map((item) => JSON.stringify(item)).join("\n") + "\n"
      );
    }
  }
```

（唯一变化：`.join("\n")` → `.join("\n") + "\n"`。空数组时不写文件，行为不变。）

- [ ] **Step 3: appendItem 改为 append-only（核心优化）**

替换 `appendItem`（当前 line 101-106）：

```ts
  async appendItem(runId: string, item: LumeRunItem): Promise<void> {
    if (!existsSync(this.statePath(runId))) return;
    appendFileSync(this.itemsPath(runId), JSON.stringify(item) + "\n", "utf-8");
  }
```

> 不再 `get`（避免读全量 items）+ 不再 `update`（避免重写）。仅检查 run 是否存在（state.json 存在 = run 已 create）。首次 append 时 items.jsonl 不存在，`appendFileSync` 自动创建。

- [ ] **Step 4: 运行 test 确认正确性**

Run: `bun test apps/sidecar/src/services/agent-runtime/runner/run-state-store.test.ts`
Expected: 4 pass / 0 fail（append-only 后，多次 append 累积、get 闭环、现有用例均通过）。

Run: `bun apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts`
Expected: 耗时**显著低于** B0（从 O(n²) 降到 O(n)，N=500 应降到几 ms）。

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runner/run-state-store.ts
git commit -m "⚡️ perf(sidecar): run-state-store appendItem 改 append-only，消除每事件全量重写"
```

---

## Task 3：update 仅按需重写 items.jsonl

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.ts`

- [ ] **Step 1: update 改为只读 state.json 元数据，仅 patch.generatedItems 提供时重写 items**

替换 `update`（当前 line 84-99）：

```ts
  async update(runId: string, patch: Partial<LumeRunState>): Promise<void> {
    const state = readJsonFile<LumeRunState>(this.statePath(runId));
    if (!state) return;
    const next: LumeRunState = {
      ...state,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    writeTextAtomic(this.statePath(runId), JSON.stringify({
      ...next,
      generatedItems: []
    }, null, 2));
    if (patch.generatedItems !== undefined) {
      const items = patch.generatedItems;
      writeTextAtomic(
        this.itemsPath(runId),
        items.length > 0 ? items.map((item) => JSON.stringify(item)).join("\n") + "\n" : ""
      );
    }
  }
```

> 关键变化：(1) 不再调 `this.get()`（避免读 items.jsonl 全量），改用 `readJsonFile`（只读 state.json 元数据）；(2) 仅当 `patch.generatedItems !== undefined` 才重写 items.jsonl——run-observer 的高频状态更新（不含 generatedItems）从此只读写 state.json（O(1)），handoff-service 的转换（含 generatedItems）仍正确重写。空数组写空串（等价清空）。

- [ ] **Step 2: 运行 test 确认正确性**

Run: `bun test apps/sidecar/src/services/agent-runtime/runner/run-state-store.test.ts`
Expected: 4 pass / 0 fail（update 分支行为：不含 generatedItems 不动 items、含 generatedItems 重写、状态字段更新）。

- [ ] **Step 3: 跑 runner 相关回归（确保调用方无回归）**

Run: `bun test apps/sidecar/src/services/agent-runtime/runner/`
Expected: 现有 runner 测试（run-observer.test.ts、lume-runner.test.ts 等）全绿。特别确认 handoff 相关路径（若有 test）仍通过。

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runner/run-state-store.ts
git commit -m "⚡️ perf(sidecar): update 仅按需重写 items，状态更新不再冗余读写"
```

---

## Task 4：集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: 全量 runner 回归**

Run: `bun test apps/sidecar/src/services/agent-runtime/runner/ 2>&1 | tail -5`
Expected: 无新增失败（既有失败若存在需记录，但不应由本次改造引起）。

- [ ] **Step 2: bench 最终对比**

Run: `bun apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts`
Expected: 耗时远低于 B0（改造前）。记录改造后数字。

- [ ] **Step 3: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 通过。

- [ ] **Step 4: 验证调用方契约未被破坏（代码审查式检查）**

确认 5 处 `appendItem` 调用方（run-observer ×4 + handoff-service ×1）与 4 处 `update` 调用方（run-observer ×3 + handoff-service ×1）的语义在改造后保持：
- `appendItem` 仍是「追加单条 item，run 不存在则 no-op」✓
- `update` 不含 generatedItems → 只更新状态 ✓；含 generatedItems → 重写 items ✓
- `get` 仍返回完整 state + items ✓

---

## 注意事项与边界

- **格式一致性**：create 与 appendItem 都以 `\n` 结尾每行（Task 2 Step 2/3），`readJsonlFile` 的 `split("\n").filter(Boolean)` 容忍尾随空行，新旧文件兼容。
- **handoff 兼容**：`handoff-service.ts:91-93` 传完整转换后的 `generatedItems`，store 直接整体重写——语义不变（get 读回转换后的数组）。
- **同步 fs 仍在热路径**：本 plan 聚焦消除 O(n²) 重写；`appendFileSync` 仍同步阻塞事件循环（但单行 append 远快于全量重写）。进一步异步化（`fs/promises`）属 Phase 9（启动/日志 fs），不在本 plan 范围。
- **get 仍 O(n)**：`get` 读全量 items.jsonl（按需，频率远低于 appendItem）。若 get 也成瓶颈，可后续加内存缓存或游标读取，不在本 plan。
- **不动 trace-store / transcript / markdown-store**：那是 Phase 3b/3c/3d。
