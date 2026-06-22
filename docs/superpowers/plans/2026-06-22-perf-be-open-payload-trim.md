# 打开会话 payload 裁剪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `GET_THREAD_MESSAGES` 响应里每条消息的全量 `sdkMessages` 裁成仅 compaction system 消息（前端打开时唯一所需），缩小打开长会话的传输体积。

**Architecture:** 共享谓词 `isCompactionSdkMessage`（`@lume/shared`）+ sidecar RPC 边界裁剪 helper `trimSdkMessagesForTransport`（co-located 可测模块），在 `GET_THREAD_MESSAGES` handler 套用 `.map(trimSdkMessagesForTransport)`。内部 `getAgentThreadMessages`/`getVisibleAgentMessages` 不变（engine 仍用全量）。前端零改动（compaction 投影对 trimmed 数组等价）。

**Tech Stack:** TypeScript、bun:test、`@lume/shared`（types + runtime）、`@lume/agent-sdk`（SDKMessage 源）。

## Global Constraints

- 分支 `feat/new-ui`，**勿合并 main**。每 Task 末尾 commit。
- `sdkMessages?: SDKMessage[]` 可选（`packages/shared/src/types/agent.ts:181`）⇒ 裁剪类型安全；`sidecar_call` 响应**无 zod 输出 schema** ⇒ 裁剪对前端透明。
- **不改** `getVisibleAgentMessages` / `getAgentThreadMessages` 内部（engine 重建上下文仍用全量 sdkMessages）。裁剪**只**在 RPC 响应边界。
- **不改前端**：`projectPersistedCompactionMessages`（`apps/web/src/components/agent/agent-message-state.ts:337`）用同一组 compaction 子类型过滤 ⇒ 对 trimmed 数组等价。
- compaction 子类型**逐字一致**：`context_compaction_started` / `context_compaction_progress` / `compact_boundary`（已核实与前端 `projectPersistedCompactionMessage` 同源）。
- **不在范围**（YAGNI）：不加 lazy-load RPC（无前端消费方）；不对 `GET_RECENT_THREAD_MESSAGES` / `GET_THREAD_MESSAGE_VERSIONS` 套裁剪；不做磁盘读取优化（→ Phase 8）；Phase 6 B/C 独立周期。
- **零回归基线**：shared 现有 pass 数、sidecar agent/rpc 现有 pass 数、memory-v2 147/0；typecheck：`bun run --filter @lume/shared typecheck`、`bun run --filter @lume/sidecar typecheck` 均 exit 0。

## File Structure

| 文件 | 责任 | 本计划改动 |
|------|------|-----------|
| `packages/shared/src/agent-compaction.ts` | compaction 谓词 | 新建：`isCompactionSdkMessage` + 子类型常量 |
| `packages/shared/src/index.ts` | shared 导出面 | 追加 `export * from "./agent-compaction"` |
| `packages/shared/src/agent-compaction.test.ts` | 谓词单测 | 新建 |
| `apps/sidecar/src/rpc/message-payload-trim.ts` | 传输裁剪 helper | 新建：`trimSdkMessagesForTransport` |
| `apps/sidecar/src/rpc/message-payload-trim.test.ts` | 裁剪单测 | 新建（等价 + payload 缩减） |
| `apps/sidecar/src/rpc/agent-handlers.ts` | RPC handlers | `GET_THREAD_MESSAGES` 套 `.map(trimSdkMessagesForTransport)` |
| `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md` | 进展交接 | 标记 Phase 6A 完成 |

---

### Task 1: 共享 compaction 谓词 + 单测（TDD）

**Files:**
- Create: `packages/shared/src/agent-compaction.ts`
- Modify: `packages/shared/src/index.ts`（追加 export）
- Create: `packages/shared/src/agent-compaction.test.ts`

**Interfaces:**
- Produces: `export function isCompactionSdkMessage(message: SDKMessage): boolean`（`message.type === "system"` 且 subtype ∈ 3 类 compaction）。

- [ ] **Step 1: 写失败测试**

创建 `packages/shared/src/agent-compaction.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import { isCompactionSdkMessage } from "./agent-compaction"
import type { SDKMessage } from "./types/agent"

describe("isCompactionSdkMessage", () => {
  test("true for the three compaction system subtypes", () => {
    expect(isCompactionSdkMessage({ type: "system", subtype: "context_compaction_started" } as SDKMessage)).toBe(true)
    expect(isCompactionSdkMessage({ type: "system", subtype: "context_compaction_progress" } as SDKMessage)).toBe(true)
    expect(isCompactionSdkMessage({ type: "system", subtype: "compact_boundary" } as SDKMessage)).toBe(true)
  })

  test("false for non-compaction system subtypes and other message types", () => {
    expect(isCompactionSdkMessage({ type: "system", subtype: "success" } as SDKMessage)).toBe(false)
    expect(isCompactionSdkMessage({ type: "assistant", message: { role: "assistant", content: [] } } as SDKMessage)).toBe(false)
    expect(isCompactionSdkMessage({ type: "user", message: { role: "user", content: [] } } as SDKMessage)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败（RED）**

Run: `bun test packages/shared/src/agent-compaction.test.ts`
Expected: FAIL —— `isCompactionSdkMessage` 未导出（模块不存在）。

- [ ] **Step 3: 实现谓词**

创建 `packages/shared/src/agent-compaction.ts`：

```ts
import type { SDKMessage } from "./types/agent"

/** compaction system 消息的 SDK 子类型——打开会话时前端唯一需要的 sdkMessages 子集。 */
const COMPACTION_SYSTEM_SUBTYPES = new Set([
  "context_compaction_started",
  "context_compaction_progress",
  "compact_boundary",
])

/** 判断一条 SDKMessage 是否为 compaction system 消息。 */
export function isCompactionSdkMessage(message: SDKMessage): boolean {
  return message.type === "system" && COMPACTION_SYSTEM_SUBTYPES.has(message.subtype)
}
```

（`message.type === "system"` 收窄到 `SDKSystemMessage`，其 `subtype` 为字符串联合，`Set<string>.has()` 类型安全，无需 `as string`。）

- [ ] **Step 4: 导出**

`packages/shared/src/index.ts` 现有 `export * from "./agent"` 等行附近追加：

```ts
export * from "./agent-compaction"
```

- [ ] **Step 5: 跑测试确认通过（GREEN）**

Run: `bun test packages/shared/src/agent-compaction.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 6: shared 全量 + typecheck**

Run: `bun test packages/shared/` → 现有 pass 数 + 2，无新增 fail。
Run: `bun run --filter @lume/shared typecheck` → exit 0。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agent-compaction.ts packages/shared/src/index.ts packages/shared/src/agent-compaction.test.ts
git commit -m "✨ feat(shared): isCompactionSdkMessage 谓词（compaction system 子类型判定）"
```

---

### Task 2: sidecar 传输裁剪 helper + 套用于 GET_THREAD_MESSAGES（TDD）

**Files:**
- Create: `apps/sidecar/src/rpc/message-payload-trim.ts`
- Create: `apps/sidecar/src/rpc/message-payload-trim.test.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`（import + `GET_THREAD_MESSAGES` handler）

**Interfaces:**
- Consumes: Task 1 的 `isCompactionSdkMessage`（from `@lume/shared`）。
- Produces: `export function trimSdkMessagesForTransport(message: AgentMessage): AgentMessage`。

- [ ] **Step 1: 写失败测试**

创建 `apps/sidecar/src/rpc/message-payload-trim.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import { trimSdkMessagesForTransport } from "./message-payload-trim"
import type { AgentMessage, SDKMessage } from "@lume/shared"

function msg(sdkMessages?: SDKMessage[]): AgentMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "hi",
    createdAt: 1,
    sdkMessages,
  } as unknown as AgentMessage
}

describe("trimSdkMessagesForTransport", () => {
  test("keeps compaction system messages, drops the rest", () => {
    const full: SDKMessage[] = [
      { type: "assistant", message: { role: "assistant", content: [] } } as SDKMessage,
      { type: "system", subtype: "context_compaction_started" } as SDKMessage,
      { type: "user", message: { role: "user", content: [] } } as SDKMessage,
      { type: "system", subtype: "compact_boundary" } as SDKMessage,
    ]
    const trimmed = trimSdkMessagesForTransport(msg(full))
    expect(trimmed.sdkMessages).toHaveLength(2)
    expect((trimmed.sdkMessages ?? []).every((m) => m.type === "system")).toBe(true)
  })

  test("sets sdkMessages undefined when none are compaction", () => {
    const full: SDKMessage[] = [
      { type: "assistant", message: { role: "assistant", content: [] } } as SDKMessage,
      { type: "user", message: { role: "user", content: [] } } as SDKMessage,
    ]
    expect(trimSdkMessagesForTransport(msg(full)).sdkMessages).toBeUndefined()
  })

  test("returns same reference when there are no sdkMessages", () => {
    const m = msg(undefined)
    expect(trimSdkMessagesForTransport(m)).toBe(m)
  })

  test("payload shrinks: trimmed JSON is smaller than full JSON", () => {
    const heavy: SDKMessage[] = Array.from({ length: 20 }, () => ({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(500) }] },
    } as SDKMessage))
    heavy.push({ type: "system", subtype: "compact_boundary" } as SDKMessage)
    const full = msg(heavy)
    const trimmed = trimSdkMessagesForTransport(full)
    expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(full).length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败（RED）**

Run: `bun test apps/sidecar/src/rpc/message-payload-trim.test.ts`
Expected: FAIL —— `trimSdkMessagesForTransport` 未导出（模块不存在）。

- [ ] **Step 3: 实现 helper**

创建 `apps/sidecar/src/rpc/message-payload-trim.ts`：

```ts
import type { AgentMessage } from "@lume/shared"
import { isCompactionSdkMessage } from "@lume/shared"

/**
 * 传输裁剪：把 message.sdkMessages 仅保留 compaction system 消息（前端打开会话时唯一所需），
 * 其余 assistant/user/result 原始交换丢弃。在 GET_THREAD_MESSAGES RPC 响应边界套用。
 * 内部 getVisibleAgentMessages 不受影响（engine 重建上下文仍用全量）。
 */
export function trimSdkMessagesForTransport(message: AgentMessage): AgentMessage {
  const sdk = message.sdkMessages
  if (!sdk || sdk.length === 0) return message
  const compactionOnly = sdk.filter(isCompactionSdkMessage)
  if (compactionOnly.length === sdk.length) return message
  return { ...message, sdkMessages: compactionOnly.length > 0 ? compactionOnly : undefined }
}
```

- [ ] **Step 4: 跑测试确认通过（GREEN）**

Run: `bun test apps/sidecar/src/rpc/message-payload-trim.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 套用于 GET_THREAD_MESSAGES handler**

`apps/sidecar/src/rpc/agent-handlers.ts`：

顶部 import 区追加（紧邻现有 `from "./..."` 本地 import 或 `@lume/shared` import 块）：

```ts
import { trimSdkMessagesForTransport } from "./message-payload-trim"
```

`GET_THREAD_MESSAGES` handler（约 585-588 行）改为：

```ts
    [AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES);
      return getAgentThreadMessages(input.threadId).map(trimSdkMessagesForTransport);
    },
```

- [ ] **Step 6: sidecar 回归 + typecheck**

Run: `bun test apps/sidecar/src/rpc/message-payload-trim.test.ts` → 4 pass。
Run: `bun test apps/sidecar/src/services/agent/ apps/sidecar/src/rpc/` → 现有 pass 数不变（裁剪是新增 helper + handler 一行；无既有用例受影响）。
Run: `bun run --filter @lume/sidecar typecheck` → exit 0。

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/rpc/message-payload-trim.ts apps/sidecar/src/rpc/message-payload-trim.test.ts apps/sidecar/src/rpc/agent-handlers.ts
git commit -m "⚡️ perf(sidecar): GET_THREAD_MESSAGES 裁剪全量 sdkMessages，仅留 compaction system 消息（缩小打开会话 payload）"
```

---

### Task 3: 全量零回归核验 + 更新进展交接

**Files:**
- Modify: `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`

- [ ] **Step 1: 全量基线核验**

```bash
bun test packages/shared/src/agent-compaction.test.ts   # 2 pass / 0 fail
bun test packages/shared/                                # 现有 + 2，无新增 fail
bun test apps/sidecar/src/rpc/message-payload-trim.test.ts  # 4 pass / 0 fail
bun test apps/sidecar/src/services/agent/                # 现有 pass 数不变
bun test apps/sidecar/src/rpc/                           # 现有 pass 数不变
bun test apps/sidecar/src/services/memory-v2/            # 147 pass / 0 fail（无关域）
bun run --filter @lume/shared typecheck                  # exit 0
bun run --filter @lume/sidecar typecheck                 # exit 0
```
Expected：全部与基线一致，0 回归。

- [ ] **Step 2: 更新进展交接文档**

`docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`：
1. 「一句话状态」：标记 Phase 6 子项目 A（打开会话 payload 裁剪）完成；B/C 独立周期。
2. 「已完成 Phase 详情」表新增一行：Phase 6A —— `GET_THREAD_MESSAGES` 边界裁剪 sdkMessages 仅留 compaction system（`isCompactionSdkMessage` 谓词 + `trimSdkMessagesForTransport`）；验收 = 裁剪等价性 + payload 缩减测试 + 各基线零回归。
3. 「剩余工作」Phase 6 条目：标注「A 已完成；余 B（config read→write）、C（skills/notes/threads 缓存）独立周期」。
4. 「test 基线」表：补 shared `agent-compaction` 2 pass、sidecar `message-payload-trim` 4 pass。

保持外科式编辑，勿重构无关段落。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-22-perf-progress-handoff.md
git commit -m "📝 docs(perf): Phase 6A 打开会话 payload 裁剪完成，更新进展交接文档"
```

---

## Self-Review

**1. Spec coverage：**
- 共享谓词 `isCompactionSdkMessage` → Task 1 Step 3 ✓
- index 导出 → Task 1 Step 4 ✓
- 谓词单测 → Task 1 Step 1 ✓
- sidecar 裁剪 helper → Task 2 Step 3 ✓
- 裁剪等价 + payload 缩减测试 → Task 2 Step 1 ✓
- GET_THREAD_MESSAGES 套用 → Task 2 Step 5 ✓
- 零回归基线 → Task 1 Step 6 + Task 2 Step 6（局部）+ Task 3 Step 1（全量）✓
- 非目标（不改内部/不改前端/不 lazy RPC/不裁其他 handler）→ Global Constraints，无 Task 触及 ✓
无遗漏。

**2. Placeholder scan：** 无 TBD/TODO；每 step 给出实际代码或精确 before→after；命令 + 期望输出齐全。✓

**3. Type consistency：** `isCompactionSdkMessage` Task 1 定义、Task 2 消费（via `@lume/shared`），命名一致；`trimSdkMessagesForTransport` Task 2 定义、agent-handlers 消费，命名一致；compaction 子类型字面量两处一致。SDKMessage 经 shared re-export，shared/sidecar 两端均可 `from "@lume/shared"` / `from "./types/agent"` 取得。✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-perf-be-open-payload-trim.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每 Task 派 fresh subagent，Task 间 review。
2. **Inline Execution** — 本会话内用 executing-plans 批量执行，带 checkpoint。

Which approach?
