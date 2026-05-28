# 自动压缩与 Token Usage 统一能力 - 设计文档

> 日期: 2026-05-28
> 状态: 已确认
> 分支: feat/new-ui

## 1. 背景与目标

Lume 已有自动压缩、`usage.updated` 运行时事件、ContextWindowIndicator 和 provider usage 记录，但当前实现把多个 token 口径混在一起使用:

- `result.usage` 是 provider 调用累计 usage, 却被 sidecar/web 当成 context window 占用。
- SDK assistant message 没有携带本次 provider response 的 `usage`, 后续上下文计算只能回退到粗估。
- `modelUsage.contextWindow` 当前可能是 `0`, sidecar 会继续转发, 前端会得到无意义的 `x / 0 tokens`。
- subagent/task progress 的 token 多数是 `0`, 没有按 agent 对话进度真实计算。

目标是把自动压缩作为完整能力修正, 同时完成 token 计算、运行时事件、持久化和前端渲染的端到端联动。

## 2. 参考实现

参考 claude-code 的三个核心做法:

1. Context fullness 不是累计账单。它取最近一次真实 assistant API response 的 usage, 再加之后新增消息的估算。
2. Provider billing usage 可以累加, 但只用于成本和明细。
3. Agent/subagent progress 用 `latest input + cumulative output`: input 是每轮累计上下文, 只保留最新值; output 是每轮新增输出, 需要累加。

Lume 不照搬 claude-code 的全部 compaction 系统, 例如 reactive compact、snip compact、cached microcompact 暂不进入本次范围。

## 3. 非目标

- 不做旧字段兼容层。
- 不保留无意义的 usage 转发。
- 不把 billing total 当成 context window usage。
- 不引入新依赖。
- 不实现 reactive prompt-too-long compaction。

## 4. Token 口径

### 4.0 Provider usage 归一化

SDK/provider adapter 必须先把不同 provider 的 usage 归一化, 后续所有 token 口径只读归一化结果。

```ts
type NormalizedProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
};
```

归一化规则:

- `inputTokens` 表示非缓存输入 token, 不包含 `cacheReadInputTokens` 或 `cacheCreationInputTokens`。
- 如果 provider 的 prompt/input 总数已经包含 cached tokens, adapter 必须先扣除 cached 部分再写入 `inputTokens`。
- `cacheReadInputTokens` 和 `cacheCreationInputTokens` 始终单独保存。
- `totalTokens = inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens`。
- 缺失字段使用 `0`, 但 usage 的 `source` 不能因此标记为 provider 真实值, 除非 provider 确实返回了可用 usage。

### 4.1 `contextUsage`

用途:

- 自动压缩阈值判断。
- `context.compaction.started/completed` 的 `preTokens/postTokens`。
- 前端 context window 进度条。

计算规则:

1. 优先读取最近一次真实 assistant provider response usage。
2. 从该 response 后一个 message 开始, 对新增 user/tool/assistant 消息做估算。
3. `totalTokens = normalizedLastResponse.totalTokens + estimatedTailTokens`。
4. 如果当前会话还没有任何 provider usage, 使用全量 history 估算, 并标记 `source: "estimated"`。
5. provider 没返回 usage 时不能伪装成 provider usage。
6. 只允许 `callerKind: "conversation"` 且属于当前主线程的 assistant response 成为 context anchor。

不得作为 `contextUsage` anchor 的 provider call:

- compact summary call。
- subagent child run call。
- title generation、memory extraction、classifier、side query 等非主对话 call。
- 已经被 compact boundary 归档到历史之前的旧 response。

### 4.2 `billingUsage`

用途:

- provider 调用成本。
- usage 明细表。
- run result 汇总。

计算规则:

- 每次 provider response 返回 usage 后累加。
- `usageRecords` 保留每次 provider call 的 model、turn、input/output/cache/cost。
- compact summary provider call 进入 billing, 但不能作为 compact 后 context size。
- billing 明细同时提供累计值和最近一次 provider call, 避免 web 从累计总量反推出当前响应。

### 4.3 `agentProgressUsage`

用途:

- 主 agent/subagent/task progress。
- subagent 面板进度展示。

计算规则:

- `latestInputTokens = latest(input + cacheRead + cacheCreation)`。
- `cumulativeOutputTokens += output`。
- `totalTokens = latestInputTokens + cumulativeOutputTokens`。
- subagent progress 不参与父线程 `contextUsage`。

## 5. Usage identity 与调用类型

所有 provider usage record 必须带身份边界:

```ts
type ProviderCallKind =
  | "conversation"
  | "compaction"
  | "subagent"
  | "title"
  | "memory"
  | "classifier"
  | "side_query";

type UsageIdentity = {
  threadId: string;
  runId?: string;
  parentThreadId?: string;
  parentRunId?: string;
  subagentRunId?: string;
  responseId?: string;
  turn?: number;
  callerKind: ProviderCallKind;
  callerLabel?: string;
};
```

规则:

- 主线程 context indicator 只接受 `callerKind: "conversation"` 且 `threadId` 等于当前线程的 `contextUsage`。
- subagent usage 必须带 `subagentRunId` 和 `parentThreadId` 或 `parentRunId`。
- sidecar 投影时不得把 child `contextUsage` 写入 parent thread context。
- billing records 可以跨 caller kind 展示, 但必须保留 identity, 让 UI 能分组或过滤。

## 6. SDK 设计

### 6.1 Provider response usage 回写

`QueryEngine` 在收到 provider `CreateMessageResponse` 后:

1. 继续调用 `recordProviderUsage` 更新 `billingUsage` 和 `usageRecords`。
2. 将本次 `response.usage` 写入 assistant SDK message。
3. 记录 assistant response id 或稳定锚点, 供 `contextUsage` 查找最近一次真实 usage。
4. 给 usage record 写入 `callerKind` 和 `UsageIdentity`。

compact summary provider call 必须使用 `callerKind: "compaction"`, 只进入 `billingUsage`, 不写入可被主对话 `contextUsage` 选中的 assistant anchor。

### 6.2 Context usage helper

新增 SDK 内部 helper:

```ts
type ContextUsageSnapshot = {
  source: "provider" | "estimated";
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedTailTokens: number;
  totalTokens: number;
  sections?: {
    systemTokens: number;
    memoryTokens: number;
    toolSchemaTokens: number;
    messageTokens: number;
  };
  contextWindow: number;
  contextWindowSource: "model" | "provider" | "fallback";
};
```

helper 负责:

- 找到最近的 assistant message usage。
- 只选择当前线程 `callerKind: "conversation"` 的 response anchor。
- 处理没有 usage 的初始会话。
- 处理 provider usage 后新增消息的估算。
- 为 auto-compact、result 和 host controller 提供同一份 snapshot。
- 保证 `totalTokens` 是当前完整请求上下文占用: provider anchor 已包含 system/tool/schema 等 provider 实际计入的上下文; 无 provider anchor 时, estimated snapshot 必须显式加上 system/memory/tool schema/message sections。

### 6.3 Context window 解析

`contextWindow` 对自动压缩是必需值, 不允许为 `0` 或 `undefined`。

解析顺序:

1. sidecar model resolution 的 `resolvedModel.contextWindow`。
2. SDK/provider model metadata。
3. 最后 fallback 为 `32_000`, 并标记 `contextWindowSource: "fallback"`。

如果只能使用 fallback, UI 可以展示估算状态, 但自动压缩仍使用该正数阈值。任何层都不得发出 `contextWindow: 0`。

### 6.4 自动压缩

`shouldCompactAutomatically` 改用 `contextUsage.totalTokens`, 不再用纯 `estimateMessagesTokens(this.messages)`。

自动压缩阈值公式固定为:

```ts
const reservedOutputTokens = Math.min(maxOutputTokens ?? 20_000, 20_000);
const effectiveContextWindow = Math.max(1, contextWindow - reservedOutputTokens);
const autoCompactBufferTokens =
  effectiveContextWindow >= 800_000 ? 50_000 :
  effectiveContextWindow >= 400_000 ? 30_000 :
  13_000;
const autoCompactThreshold = Math.max(1, effectiveContextWindow - autoCompactBufferTokens);
const shouldCompact = contextUsage.totalTokens >= autoCompactThreshold;
```

预算参与规则:

- `contextUsage.totalTokens` 必须表示完整请求上下文占用, 因此阈值比较时不得再额外叠加 system/memory/tool schema budget。
- provider-sourced `contextUsage` 使用 provider response usage 作为 anchor, 该 usage 已包含当次 provider 实际计入的 system/tool/message 输入; 之后只加 tail estimate。
- estimated `contextUsage` 必须由 SDK/host controller 在生成 snapshot 时加齐 `systemTokens + memoryTokens + toolSchemaTokens + messageTokens`, 再进入同一阈值公式。
- host controller 可以提供 section 明细给 metadata/UI, 但不能在 `shouldCompact` 时二次叠加这些 sections。

其他策略:

- 保留连续失败 circuit breaker。
- compact `preTokens` 使用 compact 前的 `contextUsage.totalTokens`。
- compact `postTokens` 使用 compact 后消息估算, 等下一次 provider response 再校准。

### 6.5 Result 输出

SDK `result` 输出最新结构:

```ts
{
  type: "result",
  billingUsage: {
    cumulative: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      totalTokens,
      costUSD,
    },
    latestRecord,
    costUSD,
    records,
  },
  contextUsage: ContextUsageSnapshot,
}
```

Lume runtime path 停止依赖旧的 `usage/model_usage/modelUsage`。sidecar/web 不读取、不转发、不 alias、不 fallback 到这些字段。测试需要覆盖旧字段即使存在也不会驱动新 UI 或 context policy。

## 7. Sidecar 设计

### 7.1 Runtime event 映射

`usage.updated` 改为最新契约:

```ts
{
  type: "usage.updated",
  threadId,
  runId,
  scope: "main" | "subagent",
  parentThreadId?,
  parentRunId?,
  subagentRunId?,
  context: {
    source,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    estimatedTailTokens,
    contextWindow,
    contextWindowSource,
  },
  billing: {
    cumulative: {
      totalTokens,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUSD,
    },
    latestRecord,
    records,
  },
  progress?: {
    totalTokens,
    latestInputTokens,
    cumulativeOutputTokens,
  }
}
```

sidecar 不再从 `result.usage` 推导 context usage。没有 `contextUsage` 时, 不发送 context window 更新。对于 subagent scope, sidecar 可以发送 progress/billing 事件, 但不得更新 parent thread context window。

### 7.2 持久化

assistant 可见消息 metadata 存:

- provider output token, 用于 assistant footer。
- context usage snapshot, 用于 reopen 后恢复 context window。
- billing summary, 如需要在历史里展示成本明细。

reopen 时前端优先读取 metadata 中的 `contextUsage`; 没有时才使用 history estimate。

### 7.3 Subagent usage

subagent runtime 监听 child result:

- 从 child `contextUsage` 和 `billingUsage.records` 更新 subagent progress。
- 使用 `latest input + cumulative output` 推 `task_progress.usage.total_tokens`。
- subagent usage 只进入 subagent/task 面板和 task result, 不污染父线程 context usage。

## 8. Web 设计

### 8.1 ContextWindowIndicator

`ContextWindowIndicator` 只读取:

- `usage.updated.context`
- `context.compaction.started/completed`
- reopen metadata `contextUsage`
- 最后 fallback history estimate

不再读取 billing total 作为 context window 占用。

### 8.2 Billing 明细

Token 明细面板读取 `usage.updated.billing.records`:

- 输入
- 缓存命中/写入
- 输出
- 成本
- model/turn/caller label

### 8.3 Assistant footer

assistant footer 继续显示本轮 provider output token。来源优先级:

1. assistant metadata 的 provider output token。
2. 当前 turn 的 `usage.updated.billing.latestRecord.outputTokens`。
3. 本地估算。

### 8.4 Parent/subagent 过滤

前端 runtime projection 必须按 identity 过滤:

- 主线程 ContextWindowIndicator 只处理 `scope: "main"` 且 `threadId` 等于当前线程的 context event。
- subagent panel 只处理匹配 `subagentRunId` 的 progress/billing event。
- billing 明细可以展示 subagent records, 但必须标识来源, 不影响 context 百分比。

### 8.5 Compaction 状态

`context.compaction.started` 显示明确状态 divider 和 header 状态。
`context.compaction.completed` 结束压缩状态, 并恢复普通 streaming/idle 表达。

## 9. 测试计划

SDK:

- provider adapter 归一化后不双算 cache tokens。
- provider usage 写入 assistant message。
- `contextUsage` 使用最近 provider usage + tail estimate。
- `contextUsage` 不选择 `callerKind: "compaction"` 或 subagent response。
- `result` 输出 `billingUsage` 和 `contextUsage`。
- auto-compact 使用 `contextUsage`, 不是 billing total。
- auto-compact 使用固定公式: `contextWindow - reservedOutputTokens - autoCompactBufferTokens`。
- estimated `contextUsage` 会包含 system/memory/tool schema/message sections, provider-sourced `contextUsage` 不会重复叠加 sections。
- compact summary usage 只进入 billing, post context 使用 compacted messages 估算。
- result path 不依赖旧 `usage/model_usage/modelUsage`。

Sidecar:

- `usage.updated` 映射新结构。
- 不再产生 `contextWindow: 0`。
- 不从旧 `result.usage` 推导 context。
- subagent scope 的 usage 不更新 parent context。
- assistant metadata 持久化 provider output token 和 context snapshot。
- subagent task progress 使用 `latest input + cumulative output`。

Web:

- ContextWindowIndicator 读取 `context`, 不读取 billing total。
- billing records 只展示在明细中。
- reopen 能从 metadata 恢复 provider token 和 context token。
- old flat usage 字段即使存在也不会驱动 context UI。
- parent/subagent usage event 过滤正确。
- compaction started/completed 状态正确闭环。

## 10. 风险

- SDK result 契约变化会影响 sidecar 测试和现有 projection 测试, 需要同一批更新。
- provider usage 缺失时必须清楚标记 estimate, 否则前端会误把估算当真实值。
- subagent usage 与父线程 context 分离后, 需要确保 task 面板仍能看到完整进度。
- 当前工作区已有大量未提交改动, 实现阶段需要严格 path-scoped, 避免混入无关变更。
