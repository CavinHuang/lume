# Phase 3b：trace-store append-only（event-sourcing）改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 3 的第二个子 plan（3a 已完成 run-state-store）。本 plan 改造 `trace-store`。

**Goal:** 消除 `trace-store` 的写放大——每次 `appendSpan`/`updateSpan` 不再「读全量 trace + 重写整个 trace.json」。改为 event-sourcing：spans 拆到 `{traceId}.spans.jsonl`，`appendSpan` 追加新 span 行、`updateSpan` 追加该 span 的完整新版本行；读取按 spanId 取最后版本（dedup）。

**Architecture:** 存储从单文件 `{traceId}.json`（含 spans 数组）拆为：`{traceId}.json`（元数据，`spans` 恒为 `[]`）+ `{traceId}.spans.jsonl`（NDJSON，每行一个 span 记录；同一 span 的多次更新 = 多行，读取取最后）。`appendSpan` = `appendFileSync` 单行；`updateSpan` = readSpans(dedup) 找当前 span + merge patch + `appendFileSync` 完整新版本；`update`(元数据) 只写 trace.json；`get` = readTrace + readSpans(dedup)。

**Tech Stack:** Bun + `node:fs`（`appendFileSync`/`writeFileSync`/`renameSync`/`existsSync`/`readFileSync`/`readdirSync`）+ `bun:test` + `mkdtempSync(tmpdir)`。

**审查依据:** `trace-store.ts:58-70`（appendSpan/updateSpan 全量重写）、`:52-56`（update 重写含 spans）、调用方 `trace-recorder.ts:75`（startSpan→appendSpan）/`:84,96`（endSpan/failSpan→updateSpan）/`:57`（endTrace→update）/`:119`（findSpan→get）。

**诚实的收益边界（重要）:**
- ✅ **写放大消除**：`appendSpan` 从 O(n²) 累积降到 O(n)（每次 O(1) append）；`updateSpan` 的写从 O(n) 重写降到 O(1) append；`update`(元数据) 不再重写 spans。
- ⚠️ **读放大未消除**：`get`/`updateSpan` 需 readSpans(dedup)，仍 O(n) 读。彻底消除读需 `trace-recorder` 内存缓存 span（`endSpan` 不再 `findSpan`→get），那是 follow-up，**不在本 plan 范围**。本 plan 的 bench 主要量化 appendSpan 的写收益。

---

## File Structure

- Modify: `apps/sidecar/src/services/agent-runtime/trace/trace-store.ts` — 引入 `spans.jsonl` + `readSpans`(dedup) + 改造 create/get/update/appendSpan/updateSpan/listByThread。
- Modify: `apps/sidecar/src/services/agent-runtime/trace/trace-store.test.ts` — 在现有 1 用例基础上追加 characterization（多 span + 多次 updateSpan 的 dedup、update 元数据不碰 spans）。
- Create: `apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts` — appendSpan/updateSpan 计时基准。

---

## Task 1：追加 characterization test 与基准

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/trace/trace-store.test.ts`
- Create: `apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts`

- [ ] **Step 1: 追加 characterization 用例**

现有 test 有 1 用例（`records trace spans and final status`，通过 TraceRecorder 覆盖完整生命周期）。在该 `describe("trace-store", ...)` 块内**追加**以下直接调 store 的用例（锁定 event-sourcing 后的 dedup 与分支行为）：

```ts
  test("多次 updateSpan 后 get 返回该 span 的最后版本（dedup）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    await store.create({ id: "t-dedup", threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });
    await store.appendSpan("t-dedup", { id: "s1", traceId: "t-dedup", type: "tool_call", name: "x", status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
    await store.updateSpan("t-dedup", "s1", { status: "completed", endedAt: "2026-04-29T00:00:01.000Z", durationMs: 1000 });
    await store.updateSpan("t-dedup", "s1", { status: "failed", error: { message: "boom" } });
    const stored = await store.get("t-dedup");
    expect(stored?.spans).toHaveLength(1);
    expect(stored?.spans[0]).toMatchObject({ id: "s1", status: "failed", durationMs: 1000 });
    expect((stored?.spans[0] as any).error?.message).toBe("boom");
  });

  test("多个 span 保持 startSpan 顺序，updateSpan 不改变顺序", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    await store.create({ id: "t-order", threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });
    await store.appendSpan("t-order", { id: "s1", traceId: "t-order", type: "model_call", name: "a", status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
    await store.appendSpan("t-order", { id: "s2", traceId: "t-order", type: "tool_call", name: "b", status: "running", startedAt: "2026-04-29T00:00:01.000Z" });
    await store.updateSpan("t-order", "s2", { status: "completed", endedAt: "2026-04-29T00:00:02.000Z" });
    await store.updateSpan("t-order", "s1", { status: "completed", endedAt: "2026-04-29T00:00:03.000Z" });
    const stored = await store.get("t-order");
    expect(stored?.spans.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(stored?.spans.every((s) => s.status === "completed")).toBe(true);
  });

  test("update 元数据不改动 spans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    await store.create({ id: "t-meta", threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });
    await store.appendSpan("t-meta", { id: "s1", traceId: "t-meta", type: "model_call", name: "a", status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
    await store.update("t-meta", { status: "completed", endedAt: "2026-04-29T00:00:05.000Z" });
    const stored = await store.get("t-meta");
    expect(stored?.status).toBe("completed");
    expect(stored?.spans).toHaveLength(1);
    expect(stored?.spans[0].id).toBe("s1");
  });
```

> 现有用例 + 这 3 个共同构成护栏。当前实现下它们应已通过（锁定基线）；若某个失败，说明对现有行为理解有误，先修正测试。

- [ ] **Step 2: 运行 test 确认基线**

Run: `bun test apps/sidecar/src/services/agent-runtime/trace/trace-store.test.ts`
Expected: 4 pass / 0 fail（原 1 + 新 3）。

- [ ] **Step 3: 写基准脚本**

Create `apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts`:

```ts
// 手动基准脚本：bun apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts
// 量化 appendSpan（写放大主收益）与 updateSpan 的改造前后耗时。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeTraceStore } from "./trace-store";

const dir = mkdtempSync(join(tmpdir(), "lume-trace-bench-"));
const store = createFileBackedLumeTraceStore(dir);
const traceId = "bench-trace";
await store.create({ id: traceId, threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });

const N = 500;
const start1 = performance.now();
for (let i = 1; i <= N; i++) {
  await store.appendSpan(traceId, { id: `s${i}`, traceId, type: "tool_call", name: `n${i}`, status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
}
const appendMs = performance.now() - start1;

const start2 = performance.now();
for (let i = 1; i <= N; i++) {
  await store.updateSpan(traceId, `s${i}`, { status: "completed", endedAt: "2026-04-29T00:00:01.000Z", durationMs: 1 });
}
const updateMs = performance.now() - start2;

const stored = await store.get(traceId);
console.log(`appendSpan x${N}: ${appendMs.toFixed(1)}ms`);
console.log(`updateSpan x${N}: ${updateMs.toFixed(1)}ms`);
console.log(`final spans=${stored?.spans.length}`);
```

- [ ] **Step 4: 运行基准记录基线 B0**

Run: `bun apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts`
Expected: 打印 appendSpan 与 updateSpan 的 B0（当前实现两者都是 O(n²) 读写）。记录两个数字。

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/trace/trace-store.test.ts apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts
git commit -m "test(sidecar): trace-store 追加 event-sourcing characterization 与基准"
```

---

## Task 2：spans 迁移到 spans.jsonl（event-sourcing + dedup）

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/trace/trace-store.ts`

这是原子迁移：spans 从 trace.json 拆出，所有方法一起改（中间状态不可用）。

- [ ] **Step 1: import appendFileSync + 加 readJsonlFile + readSpans(dedup) + spansPath**

顶部 import 加 `appendFileSync`：

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

在 `readTrace` 函数之后新增 NDJSON 读取与 dedup：

```ts
function readJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((item): item is T => item !== null);
}

/**
 * 读取 spans.jsonl 并按 spanId 去重，取每个 span 的最后版本（event-sourcing）。
 * Map 保持首次插入顺序 = appendSpan(startSpan) 顺序，updateSpan 追加的新版本只更新值不改顺序。
 */
function readSpans(path: string): LumeTraceSpan[] {
  const records = readJsonlFile<LumeTraceSpan>(path);
  const byId = new Map<string, LumeTraceSpan>();
  for (const span of records) {
    byId.set(span.id, span);
  }
  return [...byId.values()];
}
```

在 class 内 `tracePath` 旁新增 `spansPath`：

```ts
  private spansPath(traceId: string): string {
    return join(this.tracesDir, `${traceId}.spans.jsonl`);
  }
```

- [ ] **Step 2: create 只写元数据（spans:[]），有初始 spans 时写 spans.jsonl**

```ts
  async create(trace: LumeTrace): Promise<void> {
    writeTextAtomic(this.tracePath(trace.id), JSON.stringify({ ...trace, spans: [] }, null, 2));
    if (trace.spans.length > 0) {
      writeTextAtomic(
        this.spansPath(trace.id),
        trace.spans.map((span) => JSON.stringify(span)).join("\n") + "\n"
      );
    }
  }
```

> startTrace 总是传 spans:[]，所以通常不写 spans.jsonl。保留初始 spans 写入是为防御性/一致性。

- [ ] **Step 3: get 读元数据 + readSpans(dedup)**

```ts
  async get(traceId: string): Promise<LumeTrace | null> {
    const trace = readTrace(this.tracePath(traceId));
    if (!trace) return null;
    return { ...trace, spans: readSpans(this.spansPath(traceId)) };
  }
```

- [ ] **Step 4: update 只写元数据，不碰 spans**

```ts
  async update(traceId: string, patch: Partial<LumeTrace>): Promise<void> {
    const trace = readTrace(this.tracePath(traceId));
    if (!trace) return;
    writeTextAtomic(this.tracePath(traceId), JSON.stringify({ ...trace, ...patch }, null, 2));
  }
```

> 不再 get（避免读 spans）+ 不再重写 spans。trace 来自 readTrace（元数据，spans:[]），patch 一般不含 spans（endTrace 传 status/endedAt）。写出的 trace.json 仍是元数据。

- [ ] **Step 5: appendSpan 改 append-only**

```ts
  async appendSpan(traceId: string, span: LumeTraceSpan): Promise<void> {
    if (!existsSync(this.tracePath(traceId))) return;
    appendFileSync(this.spansPath(traceId), JSON.stringify(span) + "\n", "utf-8");
  }
```

> 不再 get + update。trace 不存在则 no-op（等价旧行为）。首次 append 自动创建 spans.jsonl。

- [ ] **Step 6: updateSpan 改为 readSpans(dedup) + merge + append 新版本**

```ts
  async updateSpan(traceId: string, spanId: string, patch: Partial<LumeTraceSpan>): Promise<void> {
    const spans = readSpans(this.spansPath(traceId));
    const current = spans.find((span) => span.id === spanId);
    if (!current) return;
    const next: LumeTraceSpan = { ...current, ...patch };
    appendFileSync(this.spansPath(traceId), JSON.stringify(next) + "\n", "utf-8");
  }
```

> 读 dedup 找当前 span（O(n) 读，未消除——见收益边界），merge patch，追加完整新版本行（O(1) 写）。读取时 readSpans 的 Map 取最后版本即新版本。

- [ ] **Step 7: listByThread 复用 get（含 dedup）**

```ts
  async listByThread(threadId: string): Promise<LumeTrace[]> {
    if (!existsSync(this.tracesDir)) return [];
    const traces: LumeTrace[] = [];
    for (const file of readdirSync(this.tracesDir)) {
      if (!file.endsWith(".json")) continue;
      const traceId = file.slice(0, -".json".length);
      const trace = await this.get(traceId);
      if (trace?.threadId === threadId) {
        traces.push(trace);
      }
    }
    return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
```

> `get` 已含 readSpans dedup，listByThread 直接复用。注意 `.json` 过滤会跳过 `.spans.jsonl`（不以 `.json` 结尾），不会误读 spans 文件为 trace。

- [ ] **Step 8: 运行 test + 重跑基准**

Run: `bun test apps/sidecar/src/services/agent-runtime/trace/trace-store.test.ts`
Expected: 4 pass / 0 fail（dedup、顺序、元数据更新、现有生命周期用例全绿）。

Run: `bun apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts`
Expected: appendSpan **显著低于** B0（O(n²)→O(n)）；updateSpan 写改善但读仍 O(n)（dedup），故降幅小于 appendSpan——这是预期的，诚实记录。

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 通过。

- [ ] **Step 9: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/trace/trace-store.ts
git commit -m "⚡️ perf(sidecar): trace-store spans 改 event-sourcing append-only，消除写放大"
```

---

## Task 3：集成验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: trace + 间接引用方回归**

Run: `bun test apps/sidecar/src/services/agent-runtime/trace/ 2>&1 | tail -5`
Expected: trace-store.test + trace-redaction.test 全绿。

Run: `bun test apps/sidecar/src/services/agent-runtime/runner/ apps/sidecar/src/services/agent-runtime/context/ 2>&1 | tail -5`
Expected: 无新增失败（handoff-service.test / context-assembler.test 等间接用 trace 的不回归）。

- [ ] **Step 2: bench 最终对比**

Run: `bun apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts`
Expected: appendSpan 远低于 B0；spans 数 = N（dedup 正确，无丢失/重复）。

- [ ] **Step 3: typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 通过。

- [ ] **Step 4: 调用方契约检查**

确认 trace-recorder 的调用在新存储下保持：
- startSpan→appendSpan：追加 running span ✓
- endSpan/failSpan→findSpan(get 读 dedup) + updateSpan(merge + append) ✓
- endTrace→update(元数据) ✓
- get（findSpan + RPC agent-handlers:841）返回含正确 spans ✓

---

## 注意事项与边界

- **event-sourcing 的读放大未消除**：`get`/`updateSpan` 需 readSpans(dedup) O(n) 读。彻底消除需 `trace-recorder` 内存缓存 span（startSpan 存内存，endSpan 不再 findSpan→get），属 follow-up，不在本 plan。
- **dedup 顺序**：`readSpans` 用 Map 保持首次插入顺序 = startSpan 顺序；updateSpan 追加同 spanId 的新版本只更新 Map 值、不改顺序。测试用例 2 锁定此行为。
- **空 spans.jsonl**：trace 无 span 时 spans.jsonl 不存在（create 不写空文件，appendSpan 首次创建）；readSpans 对不存在文件返回 []（readJsonlFile 的 existsSync 守卫）。
- **`.json` 过滤**：listByThread 的 `file.endsWith(".json")` 天然跳过 `.spans.jsonl` 文件，不会把 spans 文件当 trace 读。
- **trace-recorder.findSpan 的 collectKnownTraces 兜底**（trace-recorder.ts:127）：它扫描 tracesDir 读所有 trace.json——改造后仍工作（读元数据 + get dedup），性能不变（低频兜底路径）。
- **同步 fs 仍在热路径**：appendFileSync 同步阻塞；进一步异步化属 Phase 9。
- **不动 transcript / markdown-store**：那是 Phase 3c/3d。
