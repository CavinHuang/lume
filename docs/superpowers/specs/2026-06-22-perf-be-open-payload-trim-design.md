# 后端性能：打开会话 payload 裁剪（GET_THREAD_MESSAGES 去全量 sdkMessages）

> **日期**：2026-06-22
> **分支**：`feat/new-ui`（长期开发分支，勿合并 main）
> **路线图位置**：Phase 6 子项目 A（打开会话 payload 裁剪）。承接 `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`。

## 一句话目标

在 RPC 边界把 `GET_THREAD_MESSAGES` 响应里每条消息的全量 `sdkMessages`（assistant/user/result 原始交换）裁掉，仅保留前端打开时唯一需要的 **compaction system 消息**。大幅缩小打开长会话的传输/解析体积 → 打开 80-turn 会话 <200ms。

## 现状与前提（已核实）

### 打开会话 payload 链路
- RPC：`AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES`（`apps/sidecar/src/rpc/agent-handlers.ts:586-588`）→ `getAgentThreadMessages(input.threadId)`。
- `getAgentThreadMessages`（`apps/sidecar/src/services/agent/agent-thread-manager.ts:231`）→ `getVisibleAgentMessages(id)`（`agent-message-versioning-service.ts:297`）→ 返回 `AgentMessage[]`，**每条带全量 `sdkMessages`**（`toAgentMessage` 第 38 行 `sdkMessages: record.sdkMessages`）。
- `AgentMessage = AgentThreadMessage`（`packages/shared/src/types/agent.ts:196`），`sdkMessages?: SDKMessage[]`（`:181`，**可选**）。

### 前端打开时对 sdkMessages 的真实消费（关键）
- 深度 grep `apps/web/src`（非测试）：**唯一**生产消费点是 `apps/web/src/components/agent/agent-message-state.ts:337` 的 `projectPersistedCompactionMessages`。
- 该函数把 `message.sdkMessages` **过滤为 compaction system 子类型**（`context_compaction_started` / `context_compaction_progress` / `compact_boundary`），其余 sdkMessages 一律丢弃。
- 另两个 `getThreadMessages()` 消费方均不读 `sdkMessages` 字段：
  - `AgentMessages.tsx:234` → `setVisibleThreadMessages(messages)`（渲染，下游仅经 compaction 投影读 sdkMessages）。
  - `AgentInput.tsx:341` → `setHistoryMessages(messages)`（"线程上下文估算"，只用渲染内容）。
- 编辑/重试/重发：前端不回传 `sdkMessages`；sidecar 从磁盘版本库重建 engine 上下文（`getVisibleAgentMessages` 服务端内部用全量）。⇒ **前端打开时不需要全量 sdkMessages，只需 compaction system 消息。**
- `apps/desktop/src-tauri/src/main.rs:1101/1187` 是**通用** `sidecar_call` 传输代码，非 sdkMessages 专属消费方。

### 既有机理
- 已有分页 `GET_RECENT_THREAD_MESSAGES`（`AgentRecentThreadMessagesResult`，"首次仅加载尾部 N 条"）。本裁剪与其互补：即便全量加载，也不应传输全量 sdkMessages。
- `sidecar_call` 响应**无 zod 输出 schema**（仅 input 经 `validateInput` 校验）；返回原始对象。⇒ 裁剪对前端透明（`sdkMessages?` 可选，子集合法）。

## 方案

**服务端边界裁剪，前端零改动。**

### 改动 1：共享 compaction 谓词（`packages/shared`）

`@lume/shared` 已有 runtime 导出（`canonicalizeAgentToolName`、`isAfterglowLine` 等），故谓词放此。新建 `packages/shared/src/agent-compaction.ts`：

```ts
import type { SDKMessage } from "./types/agent"

/** compaction system 消息的 SDK 子类型（打开会话时前端唯一需要的 sdkMessages 子集）。 */
const COMPACTION_SYSTEM_SUBTYPES = new Set([
  "context_compaction_started",
  "context_compaction_progress",
  "compact_boundary",
])

/** 判断一条 SDKMessage 是否为 compaction system 消息（打开会话渲染所需）。 */
export function isCompactionSdkMessage(message: SDKMessage): boolean {
  return message.type === "system" && COMPACTION_SYSTEM_SUBTYPES.has(message.subtype)
}
```

从 `packages/shared/src/index.ts` 导出（`export * from "./agent-compaction"`）。子类型字面量与前端 `projectPersistedCompactionMessage` 的过滤集**逐字一致**（已在 agent-message-state.ts 核实）。

> 注：`SDKMessage` 的 `subtype` 在 SDK 类型里是联合；用 `Set<string>.has(message.subtype)` 需 `message.subtype` 为 string。`system` 类型消息的 subtype 为字符串联合，运行时 `.has()` 安全（类型层面可窄化或 `as string`，plan 落实）。

### 改动 2：RPC 边界裁剪（`apps/sidecar/src/rpc/agent-handlers.ts`）

新增本地裁剪 helper 并在 `GET_THREAD_MESSAGES` 处理器套用：

```ts
import { isCompactionSdkMessage } from "@lume/shared"   // 现有 import 块追加
import type { AgentMessage } from "@lume/shared"

/** 传输裁剪：sdkMessages 仅保留 compaction system 消息（前端打开时唯一所需），余下丢弃。 */
function trimSdkMessagesForTransport(message: AgentMessage): AgentMessage {
  const sdk = message.sdkMessages
  if (!sdk || sdk.length === 0) return message
  const compactionOnly = sdk.filter(isCompactionSdkMessage)
  return compactionOnly.length === sdk.length
    ? message
    : { ...message, sdkMessages: compactionOnly.length > 0 ? compactionOnly : undefined }
}
```

`GET_THREAD_MESSAGES` 处理器（约 586-588 行）：

```ts
[AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES]: async (params) => {
  const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES);
  return getAgentThreadMessages(input.threadId).map(trimSdkMessagesForTransport);
},
```

- `getAgentThreadMessages` / `getVisibleAgentMessages`（服务端内部，engine 上下文重建用）**不变**，仍返回全量 sdkMessages。裁剪**只**在 RPC 响应边界。
- 前端 `projectPersistedCompactionMessages` 对 trimmed 数组过滤结果与对全量过滤结果**逐条一致**（它本就只留 compaction 子类型）⇒ **前端零改动，行为等价**。

## 验收（TDD + 零回归）

### 裁剪正确性（等价性，核心）
- **裁剪保留 compaction、丢弃其余**（自包含，sidecar 内可测，无需跨包导入前端投影）：`trimSdkMessagesForTransport` 对含混合 sdkMessages（assistant/user/result + 3 类 compaction system）的消息，**仅保留 compaction system 子集**、丢弃其余；对全为非-compaction 的消息置 `sdkMessages: undefined`；对无 sdkMessages 的消息原样返回（同引用）。
- **等价性论证**（无需运行时跨包测试）：前端 `projectPersistedCompactionMessages` 用**同一组** compaction 子类型谓词过滤 sdkMessages；裁剪后 sdkMessages 恰为 `{m ∈ full | isCompactionSdkMessage(m)}`，故前端再过滤为 no-op ⇒ 前端产出与裁剪前**逐条一致**。谓词单测 + 裁剪单测共同守护此不变量。

### payload 缩减（acceptance 代理）
- 构造代表性多轮 `AgentMessage[]`（含 tool_use/tool_result/assistant 文本 + 少量 compaction），断言 `JSON.stringify(trimmed).length < JSON.stringify(full).length`，且缩减比例显著（如 >50%，取决于 compaction 占比）。这是自动化护栏；**运行时 <200ms** 为手动/基准目标（同 Phase 4 的 <1s 性质）。

### 谓词单测
- `isCompactionSdkMessage` 对 3 类 compaction system 返回 true；对 assistant/user/result/其他 system 子类型返回 false。

### 零回归基线
| 范围 | 基线 | 命令 |
|------|------|------|
| agent-handlers / agent-thread-manager / versioning | 现有 pass 数（改前记录） | `bun test apps/sidecar/src/services/agent/`、`bun test apps/sidecar/src/rpc/` |
| shared | 现有 pass 数 | `bun test packages/shared/` |
| memory-v2（无关域） | 147 pass / 0 fail | `bun test apps/sidecar/src/services/memory-v2/` |
| typecheck | exit 0 | `bun run --filter @lume/sidecar typecheck`；shared/sdk 用 `npx tsc --noEmit` |

## 风险

- **低**。前端唯一消费点（compaction 投影）由等价性测试守护；裁剪在边界，内部数据不动；`sdkMessages?` 可选使裁剪类型安全；无响应 zod 被破坏。
- **唯一关注**：遗漏前端 sdkMessages 消费点。已用深度 `rg` + 两个 `getThreadMessages` 消费方核查确认仅 `agent-message-state.ts`；等价性测试兜底。
- 若未来前端需要某条消息的全量 sdkMessages（如新编辑/展开功能），再加 lazy-load RPC（`GET_THREAD_MESSAGE_SDK_MESSAGES`）——本期不做（YAGNI，当前无消费方）。

## 不在范围（YAGNI）
- 不加 lazy-load RPC（无前端消费方）。
- 不改前端（compaction 投影对 trimmed 数组等价）。
- 不改 `getVisibleAgentMessages` / `getAgentThreadMessages` 内部（engine 仍用全量）。
- 不对 `GET_RECENT_THREAD_MESSAGES` / `GET_THREAD_MESSAGE_VERSIONS` 套裁剪（留作一致性的低成本 follow-up，本期聚焦打开路径）。
- 不做磁盘读取优化（若 <200ms 仍受限于读盘 → Phase 8 异步 fs）。
- Phase 6 子项目 B（config read→write）、C（skills/notes/threads 缓存）为独立周期。

## 受影响文件

- `packages/shared/src/agent-compaction.ts`（新建：`isCompactionSdkMessage` + 子类型常量）
- `packages/shared/src/index.ts`（导出）
- `packages/shared/src/agent-compaction.test.ts`（新建：谓词单测）
- `apps/sidecar/src/rpc/agent-handlers.ts`（`trimSdkMessagesForTransport` + 套用于 `GET_THREAD_MESSAGES`）
- `apps/sidecar/src/rpc/agent-handlers.test.ts` 或相邻测试（裁剪等价性 + payload 缩减）
