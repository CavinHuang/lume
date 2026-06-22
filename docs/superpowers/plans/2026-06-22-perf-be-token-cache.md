# 每消息 token 计数缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `estimateMessagesTokens` 加按消息对象引用的 `WeakMap` 计数缓存，使每条消息一次 run 内最多 native tokenize 一次；去掉 sidecar budget 的 `.map` 让该站点命中缓存。

**Architecture:** 模块级 `WeakMap<object, number>`（key=消息对象，value=token 总数）。消息不可变（追加 / 整体替换，已核实）→ 缓存随对象生命周期正确，`WeakMap` 自动 GC，无需显式失效。`estimateMessagesTokens` 命中即累加缓存值，未命中才算并缓存。所有调用方自动增量。

**Tech Stack:** TypeScript、`@lume/natives`（native `countStringTokens`）、bun:test（`mock.module` + `mock`）。

## Global Constraints

- 分支 `feat/new-ui`，**勿合并 main**。每 Task 末尾 commit。
- **消息不可变前提**：engine 只 `this.messages.push(...)` 追加或 `this.messages = result.compactedMessages` 整体替换（已核实无原地内容修改）。缓存按对象引用安全；**不得引入显式失效逻辑**（WeakMap + 不可变已足够）。
- **不改** `estimateContentTokens` / `estimateTokens` / `estimateContentBlockTokens`（保持无状态纯函数）；只在 `estimateMessagesTokens` 加缓存。
- **不在范围**（YAGNI）：`normalizeMessagesForAPI` 缓存、tool-schema 缓存、anchor 路径改动、字符串级缓存。
- **零回归基线**（pass/fail 与基线一致）：
  - sdk tokens：现有 pass 数（改前记录）— `bun test packages/sdk/src/utils/tokens.test.ts`
  - sdk usage：现有 pass 数 — `bun test packages/sdk/src/utils/usage.test.ts`
  - sdk 全量：现有 pass 数 — `bun test packages/sdk/`
  - sidecar context：现有 pass 数 — `bun test apps/sidecar/src/services/agent-runtime/context/`（含 `context-controller.test.ts`）
  - memory-v2（无关域）：147 pass / 0 fail
  - typecheck：`bun run --filter @lume/agent-sdk typecheck` 与 `bun run --filter @lume/sidecar typecheck` 均 exit 0

## File Structure

| 文件 | 责任 | 本计划改动 |
|------|------|-----------|
| `packages/sdk/src/utils/tokens.ts` | token 估算 | + 模块级 `WeakMap` 缓存 + 改写 `estimateMessagesTokens` + 测试复位导出 |
| `packages/sdk/src/utils/tokens.test.ts` | tokens 测试 | `beforeEach` 复位 + 3 个新用例（等价 / 缓存命中 / compaction 语义） |
| `apps/sidecar/src/services/agent-runtime/context/context-controller.ts` | sidecar budget 快照 | 去 `.map`，直读 `sessionMessages` |
| `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md` | 进展交接 | 标记 Phase 5 核心子集完成 |

---

### Task 1: 消息级 token 缓存 + 等价性/命中测试（TDD）

**Files:**
- Modify: `packages/sdk/src/utils/tokens.ts`（`estimateMessagesTokens` + 模块级缓存 + 复位导出）
- Modify: `packages/sdk/src/utils/tokens.test.ts`（`beforeEach` 复位 + 3 用例）

**Interfaces:**
- Produces: `estimateMessagesTokens` 行为不变（返回值逐位一致），新增 `export function __resetMessageTokenCacheForTests(): void`。

- [ ] **Step 1: 记录基线 pass 数**

Run: `bun test packages/sdk/src/utils/tokens.test.ts`
记录现有 pass 数（用于零回归对比）。

- [ ] **Step 2: 写失败测试（缓存命中跳过 native + 等价 + compaction 语义）**

在 `tokens.test.ts` 末尾新增一个 `describe` 块。注意：每个用例构造**全新的消息对象**，故跨用例无缓存污染；`beforeEach` 已 `mockClear()`。

```ts
describe("estimateMessagesTokens per-message cache", () => {
  test("cached recount equals full recount and is stable on append", () => {
    nativeTokenCount = 5
    const messages = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: [{ type: "text", text: "response one" }] },
    ]
    const first = estimateMessagesTokens(messages)
    const second = estimateMessagesTokens(messages)
    expect(second).toBe(first)

    const appended = [...messages, { role: "user", content: "second turn" }]
    const third = estimateMessagesTokens(appended)
    expect(third).toBe(first + estimateMessagesTokens([appended[2]!]))
  })

  test("cache hit skips native tokenize on the second pass", () => {
    nativeTokenCount = 7
    const messages = [
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" },
      { role: "user", content: "gamma" },
    ]

    estimateMessagesTokens(messages) // 首次：每条消息触发 native
    countStringTokensMock.mockClear()
    estimateMessagesTokens(messages) // 再次：应全部命中缓存

    expect(countStringTokensMock).toHaveBeenCalledTimes(0)
  })

  test("replacing the array (compaction) recounts new objects, no stale hits", () => {
    nativeTokenCount = 3
    const before = [
      { role: "user", content: "old one" },
      { role: "assistant", content: "old two" },
    ]
    estimateMessagesTokens(before) // 缓存 before 的两条

    const after = [
      { role: "user", content: "compacted summary" },
      { role: "assistant", content: "resumed" },
    ]
    countStringTokensMock.mockClear()
    estimateMessagesTokens(after) // 新对象 → 重新计数

    expect(countStringTokensMock).toHaveBeenCalled()
    expect(countStringTokensMock.mock.calls.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 跑测试确认失败（RED）**

Run: `bun test packages/sdk/src/utils/tokens.test.ts`
Expected: **FAIL** —— 至少 `cache hit skips native tokenize on the second pass` 失败：当前无缓存，第二次 `estimateMessagesTokens` 仍调用 native（`toHaveBeenCalledTimes(0)` 不满足）。

- [ ] **Step 4: 实现缓存（tokens.ts）**

在 `tokens.ts` 顶部（import 之后）加模块级缓存（用 `let` 以便测试复位）：

```ts
/**
 * 按消息对象引用缓存 token 计数。依赖消息不可变（追加 / 整体替换，非原地改内容）：
 * 追加的消息计数一次后命中；compaction 替换数组后旧对象不可达，条目随 WeakMap GC；
 * 编辑/重试产生新对象 → 自动重算。跨 session 安全（不同对象）。
 */
let messageTokenCache = new WeakMap<object, number>()
```

把 `estimateMessagesTokens` 改为：

```ts
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: any }>,
): number {
  let total = 0
  for (const msg of messages) {
    const cached = messageTokenCache.get(msg)
    if (cached !== undefined) {
      total += cached
      continue
    }
    const count = estimateContentTokens(msg.content)
    messageTokenCache.set(msg, count)
    total += count
  }
  return total
}
```

在文件末尾加测试复位导出：

```ts
/** 测试专用：清空消息 token 缓存。生产代码勿调用。 */
export function __resetMessageTokenCacheForTests(): void {
  messageTokenCache = new WeakMap()
}
```

- [ ] **Step 5: 在 `beforeEach` 调用复位（确定性）**

`tokens.test.ts` 的 import 行加 `__resetMessageTokenCacheForTests`：

```ts
const { estimateMessagesTokens, estimateTokens, __resetMessageTokenCacheForTests } = await import("./tokens.js")
```

`beforeEach` 内追加一行：

```ts
  beforeEach(() => {
    nativeTokenCount = 0
    countStringTokensMock.mockClear()
    __resetMessageTokenCacheForTests()
  })
```

- [ ] **Step 6: 跑测试确认通过（GREEN）**

Run: `bun test packages/sdk/src/utils/tokens.test.ts`
Expected: PASS（原有用例 + 3 个新用例全绿；总 pass 数 = 基线 + 3）。

- [ ] **Step 7: usage.test + sdk 全量 + typecheck**

Run: `bun test packages/sdk/src/utils/usage.test.ts` → 现有 pass 数不变。
Run: `bun test packages/sdk/` → 现有 pass 数不变（无新增 fail）。
Run: `bun run --filter @lume/agent-sdk typecheck` → exit 0。

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/utils/tokens.ts packages/sdk/src/utils/tokens.test.ts
git commit -m "⚡️ perf(sdk): estimateMessagesTokens 按消息对象缓存 token 计数（每消息最多 native tokenize 一次）"
```

---

### Task 2: sidecar budget 去 `.map`，命中缓存

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-controller.ts:63-66`

**Interfaces:**
- Consumes: Task 1 的缓存版 `estimateMessagesTokens`（从 `@lume/agent-sdk` 导入）。

- [ ] **Step 1: 改 `context-controller.ts` 第 63-66 行**

```ts
// 旧
    session: sessionMessages.length > 0
      ? estimateMessagesTokens(sessionMessages.map((message) => ({
          role: message.role,
          content: message.content ?? ""
        })))
      : 0,
// 新
    session: sessionMessages.length > 0
      ? estimateMessagesTokens(sessionMessages)
      : 0,
```

等价性已核实：`.map` 仅做 `content ?? ""`；`estimateContentTokens(null/undefined)` 返回 0（== `estimateTokens("")` 的 0），非空 content 原样传递 ⇒ 总数逐位一致。去掉 `.map` 后 `sessionMessages` 原对象复用 → 命中 Task 1 缓存。

- [ ] **Step 2: sidecar context 回归门**

Run: `bun test apps/sidecar/src/services/agent-runtime/context/`
Expected: 现有 pass 数不变（含 `context-controller.test.ts`；该用例若断言 budget 数值，去 `.map` 后数值不变 → 仍绿）。

- [ ] **Step 3: typecheck**

Run: `bun run --filter @lume/sidecar typecheck` → exit 0。

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/context/context-controller.ts
git commit -m "⚡️ perf(sidecar): context budget 去 .map 直读 sessionMessages（命中 token 缓存）"
```

---

### Task 3: 全量零回归核验 + 更新进展交接

**Files:**
- Modify: `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`

- [ ] **Step 1: 全量基线核验**

```bash
bun test packages/sdk/src/utils/tokens.test.ts        # 基线+3 pass / 0 fail
bun test packages/sdk/src/utils/usage.test.ts         # 基线不变
bun test packages/sdk/                                # 无新增 fail
bun test apps/sidecar/src/services/agent-runtime/context/  # 基线不变
bun test apps/sidecar/src/services/memory-v2/         # 147 pass / 0 fail（无关域，确认未误碰）
bun run --filter @lume/agent-sdk typecheck            # exit 0
bun run --filter @lume/sidecar typecheck              # exit 0
```
Expected：全部与基线一致，0 回归。

- [ ] **Step 2: 更新进展交接文档**

`docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`：
1. 「一句话状态」：把 Phase 5 标为「核心子集（token 增量记账）已完成；context/normalize 缓存（Option B）按需」。
2. 「已完成 Phase 详情」表新增一行：Phase 5（核心子集）—— 每消息 WeakMap token 缓存 + sidecar budget 去 .map；验收 = 缓存命中跳过 native 等价性测试 + 各基线零回归。
3. 「剩余工作」Phase 5 条目：标注「token 增量记账已完成；余 normalize/context 缓存（Option B）+ tool-schema 按需」。
4. 「test 基线」表：sdk tokens 行补「+3（缓存等价/命中/compaction）」；新增 sidecar context 行（若未有）。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-22-perf-progress-handoff.md
git commit -m "📝 docs(perf): Phase 5 token 增量记账（核心子集）完成，更新进展交接文档"
```

---

## Self-Review

**1. Spec coverage：**
- 缓存 + `estimateMessagesTokens` 改写 → Task 1 Step 4 ✓
- 测试复位导出 → Task 1 Step 4（末尾）+ Step 5 ✓
- 3 个等价/命中/compaction 用例 → Task 1 Step 2 ✓
- sidecar 去 `.map` → Task 2 Step 1 ✓
- 零回归基线 → Task 1 Step 7（局部）+ Task 3 Step 1（全量）✓
- 非目标（normalize/schema/anchor/字符串级）→ Global Constraints 约束，无 Task 触及 ✓
无遗漏。

**2. Placeholder scan：** 无 TBD/TODO；每 step 给出实际代码或精确 before→after；命令 + 期望输出齐全。✓

**3. Type consistency：** `__resetMessageTokenCacheForTests` 在 Task 1 Step 4 定义、Step 5 消费，命名一致；`messageTokenCache` 为 `let`（复位可重赋值）一致；`estimateMessagesTokens` 签名不变。Task 2 消费 Task 1 产物，导入源 `@lume/agent-sdk` 不变。✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-perf-be-token-cache.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每 Task 派 fresh subagent，Task 间 review。
2. **Inline Execution** — 本会话内用 executing-plans 批量执行，带 checkpoint。

Which approach?
