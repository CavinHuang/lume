# 后端性能：每消息 token 计数缓存（消除冗余 native tokenize）

> **日期**：2026-06-22
> **分支**：`feat/new-ui`（长期开发分支，勿合并 main）
> **路线图位置**：Phase 5「SDK token 增量记账 + context 缓存」的核心子集（仅 token 增量记账；context/normalize 缓存为 Option B，本期不做）。承接 `docs/superpowers/plans/2026-06-22-perf-progress-handoff.md`。

## 一句话目标

给 `estimateMessagesTokens` 加一个**按消息对象引用**的 `WeakMap` 计数缓存，使每条消息在一次 run 内最多被 native tokenize 一次。把无 anchor 回退路径（以及 anchor 尾部、`getContextUsage`、compaction `postTokens`、sidecar budget）从 O(历史长度) 次 native 调用降为 O(新增消息数)。

## 现状与前提（已核实）

### Token 计数链路
- `packages/sdk/src/utils/tokens.ts`：
  - `estimateTokens(text)` 先调 native `countStringTokens`（来自 `@lume/natives`，真实 native 实现 `packages/natives/src/tokens.ts`），失败/返回 0 才回退字符估算。**native 调用是每个文本块的成本来源。**
  - `estimateMessagesTokens(messages)` 遍历所有消息 → `estimateContentTokens(msg.content)` → 递归内容块 → `estimateTokens`。**每次调用对整段历史做 native tokenize。**

### 每 turn 全量重算的真实路径（线性增长来源）
- `packages/sdk/src/utils/usage.ts:198` `createContextUsageSnapshot` 用「最近 provider usage anchor + 尾部估算」做增量（`:214` 仅 tokenize tail）——**已部分增量**。
- 但 anchor 判定 `findLatestConversationUsageAnchor`（usage.ts:228-237）要求 `message.role === 'assistant' && message.usage && message.usageIdentity`。`anchorIndex === -1` 时（`:201`）**回退全量 `estimateMessagesTokens(messages)`**。无 anchor 场景真实存在：
  - 首轮（尚无 assistant 响应）。
  - 不返回 usage 的 provider / 流式错误 / 重试路径。
  - 两次 usage-bearing assistant 消息之间的多 tool 轮。
- `shouldCompactAutomatically`（engine.ts:550）**每 turn 调用** `createContextUsage()` → 命中无 anchor 回退时**每 turn 全量重算** → 随历史线性增长。
- `engine.ts:1619` `getContextUsage()`（naive 全量）、`engine.ts:729` compaction `postTokens`、sidecar `context-controller.ts:64` budget 均为额外全量重算点。

### 消息不可变性（缓存安全前提，已核实）
- `engine.ts:845/1065/1109/1134/1176` `this.messages.push(...)`：**追加**新对象，既有对象不被原地修改。
- `engine.ts:724` `this.messages = result.compactedMessages`：compaction **整体替换**数组（新对象）。
- 全文无 `this.messages[i].content = ...` 式原地内容修改。
- 编辑/重试/版本化（agent-message-versioning）产生**新对象**。
- ⇒ **按消息对象引用缓存天然正确，无需显式失效**：追加 → 新对象计数一次后命中；compaction → 旧对象不可达，`WeakMap` 条目自动 GC；编辑/重试 → 新对象重新计数。

### 既有测试（等价性守护基础）
- `packages/sdk/src/utils/tokens.test.ts`：mock `@lume/natives.countStringTokens`，覆盖 `estimateTokens` / `estimateMessagesTokens`（含 CJK、富内容块）。
- `packages/sdk/src/utils/usage.test.ts`：覆盖 anchor 快照逻辑。

## 方案

模块级 `WeakMap<object, number>`，key = 消息对象引用，value = 该消息 token 总数。所有 `estimateMessagesTokens` 调用方因此自动增量，无需逐点改造（除 sidecar budget 一处需去掉 `.map`）。

### 改动 1：`packages/sdk/src/utils/tokens.ts`（唯一 chokepoint）

新增模块级缓存并改写 `estimateMessagesTokens`：

```ts
/**
 * 按消息对象引用缓存 token 计数。依赖消息不可变（追加 / 整体替换，非原地改内容）：
 * 追加的消息计数一次后命中；compaction 替换数组后旧对象不可达，条目随 WeakMap GC；
 * 编辑/重试产生新对象 → 自动重算。跨 session 安全（不同对象）。
 */
const messageTokenCache = new WeakMap<object, number>()

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

- 缓存粒度为**整条消息**（非内容块/字符串）：消息是追加/替换的单位；字符串无法作 `WeakMap` key，故字符串级缓存不可行；消息级足以捕获全量重算的冗余。
- `estimateContentTokens` / `estimateTokens` / `estimateContentBlockTokens` **不动**（仍是无状态纯函数；仅 `estimateMessagesTokens` 这一层加缓存）。

### 改动 2：`apps/sidecar/src/services/agent-runtime/context/context-controller.ts:63-66`

现状用 `.map()` 造新对象再计数，**每次调用对象都是新的 → 引用缓存必 miss**。去掉 `.map`，直接对原 `sessionMessages` 计数：

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

**等价性**：`.map` 仅做 `content: message.content ?? ""`。`estimateContentTokens(null)` 与 `estimateContentTokens(undefined)` 返回 0（见 tokens.ts 现状），`estimateTokens("")` 亦返回 0 ⇒ null/undefined content 两种写法得数一致；非空 content 原样传递 ⇒ 总数完全一致。去掉 `.map` 后，同一 `sessionMessages` 对象跨 turn 复用 → 缓存命中。

### 改动 3：测试（tokens.test.ts 扩展 + 测试用复位）

缓存是模块级、跨测试持久。为测试确定性，导出测试专用复位：

```ts
// tokens.ts 末尾
/** 测试专用：清空消息 token 缓存。生产代码勿调用。 */
export function __resetMessageTokenCacheForTests(): void {
  // WeakMap 无 clear，重新赋值模块级变量需其声明为 let
}
```
（实现上 `messageTokenCache` 声明为 `let`，复位时 `messageTokenCache = new WeakMap()`；或维护可清的内部 Map。具体写法在 plan 落实，语义 = 清空缓存。）

`tokens.test.ts` `beforeEach` 中调用 `__resetMessageTokenCacheForTests()`。

新增用例（handoff 要求的「全量 vs 增量」等价性 + 缓存命中）：

1. **缓存重算 == 全量重算**：构造 N 条消息，`estimateMessagesTokens` 得 total₁；追加 1 条再算得 total₂ = total₁ + 新消息数；全程总数与「无缓存逐次全量」一致。
2. **缓存命中跳过 native**：`nativeTokenCount` 设为 >0 使 native 路径生效；对同一 messages 数组调 `estimateMessagesTokens` 两次；第二次断言 `countStringTokensMock` 调用次数增量 = 0（已缓存消息不再触发 native；仅新增消息触发）。
3. **compaction 语义**：构造 messages A、B 计数并缓存；用**新对象** C、D 替换数组（模拟 compaction）；断言 C、D 被计数（native 触发），A、B 不残留命中（已不可达）—— 验证替换数组后无脏命中。

### 不在范围（YAGNI）
- **不缓存 `normalizeMessagesForAPI`**（engine.ts:904，每 turn 全量 normalize）—— Option B「context 缓存」，本期不做。它是 JS 变换（非 native tokenize），成本低于 native；按需后续做。
- **不缓存 tool-schema tokens**（engine.ts:475 `estimateToolSchemaTokens`）—— 受 tool 数量约束，不随历史线性增长，价值低。
- **不改 anchor 路径**（usage.ts）—— 保留；缓存只是让它的 tail / 全量回退都更便宜。
- **不做字符串级缓存** —— 字符串非对象，不能作 `WeakMap` key；消息级是正确单位。
- **不引入显式失效逻辑** —— 不可变消息 + WeakMap 已足够。

## 验收（TDD + 零回归）

### 等价性（核心，handoff 风险项「全量 vs 增量」）
- 缓存开启后 `estimateMessagesTokens` 返回值与关闭时**逐位一致**（改动 3 用例 1）。
- 缓存命中不触发 native（用例 2 直接守护「增量」语义）。
- 数组替换（compaction）后无脏命中（用例 3）。

### 性能（acceptance：80-turn 每轮 token 计算不随历史线性增长）
- 无 anchor 回退路径：每 turn native 调用数 = 该 run 内未缓存消息数（首 pass 后趋近于单 turn 新增），而非历史总量。
- 验证手法：用例 2 的 native 调用计数即回归护栏（若缓存失效，第二次调用 native 数会回升）。

### 零回归基线
| 范围 | 基线 | 命令 |
|------|------|------|
| sdk tokens | 现有 pass 数（改前记录） | `bun test packages/sdk/src/utils/tokens.test.ts` |
| sdk usage | 现有 pass 数 | `bun test packages/sdk/src/utils/usage.test.ts` |
| sdk 全量 | 现有 pass 数 | `bun test packages/sdk/` |
| sidecar context | 现有 pass 数 | `bun test apps/sidecar/src/services/agent-runtime/context/` |
| memory-v2（无关域） | 147 pass / 0 fail | `bun test apps/sidecar/src/services/memory-v2/` |
| typecheck | exit 0 | `bun run --filter @lume/agent-sdk typecheck` 与 `--filter @lume/sidecar typecheck` |

## 风险

- **低**。返回值透明不变；消息不可变（已核实）；等价性测试守护。
- **唯一细节**：缓存不得被「每 turn 重建消息对象」的调用方击败。已核实除 sidecar budget（改动 2 修掉）外，`engine.getContextUsage`/`createContextUsage`/compaction 均操作稳定对象（`this.messages` 追加 / 整体替换）。
- **模块级缓存生命周期**：随消息对象 GC（WeakMap），活消息数受 context window 约束，有界，无泄漏。

## 受影响文件

- `packages/sdk/src/utils/tokens.ts`（缓存 + `estimateMessagesTokens` + 测试复位导出）
- `packages/sdk/src/utils/tokens.test.ts`（复位 + 3 个新用例）
- `apps/sidecar/src/services/agent-runtime/context/context-controller.ts`（去 `.map`）
