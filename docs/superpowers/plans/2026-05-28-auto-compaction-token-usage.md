# Auto Compaction Token Usage Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Lume's latest token usage contract so auto-compaction, context window UI, billing details, and agent/subagent progress use separate, correct token semantics.

**Architecture:** The SDK owns normalized provider usage, billing accumulation, context usage snapshots, and auto-compaction thresholds. Sidecar maps only the latest SDK contract into runtime events and persisted message metadata. Web reads semantic `context`, `billing`, and `progress` fields directly and filters parent/subagent usage by identity.

**Tech Stack:** TypeScript, Bun test runner, Lume Agent SDK, sidecar runtime event projection, React/Jotai web frontend.

---

## File Structure

SDK:
- Create: `packages/sdk/src/utils/usage.ts` — normalized usage, identity, billing summaries, context snapshots, fixed auto-compact threshold helper.
- Test: `packages/sdk/src/utils/usage.test.ts` — normalization, cache double-count prevention, context anchor rules, progress tracker, threshold formula.
- Modify: `packages/sdk/src/types.ts` — export `NormalizedProviderUsage`, `ProviderCallKind`, `UsageIdentity`, `ContextUsageSnapshot`, `BillingUsageSummary`, `AgentProgressUsage`; update `SDKAssistantMessage` and `SDKResultMessage`.
- Modify: `packages/sdk/src/providers/types.ts` — keep provider raw shape but make downstream normalization explicit.
- Modify: `packages/sdk/src/engine.ts` — write usage into assistant messages, maintain billing/context snapshots, emit latest result contract, use context threshold for auto-compact.
- Modify: `packages/sdk/src/utils/compact.ts` — return compaction provider usage as `callerKind: "compaction"` billing data, never as context anchor.
- Test: `packages/sdk/src/engine.test.ts` — latest result contract, contextUsage-driven auto-compact, assistant usage emission, compaction call exclusion.

Shared + sidecar:
- Modify: `packages/shared/src/types/runtime-event.ts` — replace `UsageUpdatedRuntimeEvent` flat fields with `{ scope, context, billing, progress? }`.
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts` — map SDK `billingUsage/contextUsage` to latest runtime event and ignore old `usage/modelUsage`.
- Test: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts`.
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts` and `apps/sidecar/src/services/agent-runtime/runner/run-state.ts` — store semantic context/billing usage.
- Modify: `apps/sidecar/src/services/agent/agent-service.ts` — persist assistant metadata from latest usage contract.
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts`.
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` — collect child subagent usage into progress without updating parent context.
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`.

Web:
- Modify: `apps/web/src/components/agent/runtime-state-projections.ts` — read `usage.updated.context` for context progress and `usage.updated.billing.records` for details.
- Test: `apps/web/src/components/agent/runtime-state-projections.test.ts`.
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts` — assistant footer reads provider output from `billing.latestRecord`.
- Test: `apps/web/src/components/agent/runtime-event-message-projection.test.ts`.
- Modify: `apps/web/src/components/agent/agent-message-state.ts` — reopen metadata reads latest `tokenUsage.providerOutputTokens` and `contextUsage`.
- Test: `apps/web/src/components/agent/AgentMessages.test.ts`.
- Modify as needed: `apps/web/src/components/agent/ContextWindowIndicator.tsx` and its contract test if type names change.

## Chunk 1: SDK Usage Model And Context Accounting

### Task 1.1: Add normalized usage helpers

**Files:**
- Create: `packages/sdk/src/utils/usage.ts`
- Create: `packages/sdk/src/utils/usage.test.ts`
- Modify: `packages/sdk/src/types.ts`

- [ ] **Step 1: Write failing helper tests**

Add tests for:
- `normalizeProviderUsage` keeps `inputTokens` exclusive of cache tokens.
- if a provider total includes cached tokens, the adapter passes `inputIncludesCache: true` and normalization subtracts cache tokens.
- `calculateAutoCompactThreshold(200_000, 16_384)` returns `170_616` (`200000 - 16384 - 13000`).
- large windows use 30k/50k buffers.
- `createAgentProgressTracker` keeps latest input and cumulative output.

Run: `rtk bun test packages/sdk/src/utils/usage.test.ts`
Expected: FAIL because the file/functions do not exist.

- [ ] **Step 2: Implement helper types and functions**

In `packages/sdk/src/types.ts`, add:

```ts
export type ProviderCallKind =
  | 'conversation'
  | 'compaction'
  | 'subagent'
  | 'title'
  | 'memory'
  | 'classifier'
  | 'side_query'

export interface UsageIdentity {
  threadId: string
  runId?: string
  parentThreadId?: string
  parentRunId?: string
  subagentRunId?: string
  responseId?: string
  turn?: number
  callerKind: ProviderCallKind
  callerLabel?: string
}

export interface NormalizedProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
}

export interface ContextUsageSnapshot extends NormalizedProviderUsage {
  source: 'provider' | 'estimated'
  estimatedTailTokens: number
  sections?: {
    systemTokens: number
    memoryTokens: number
    toolSchemaTokens: number
    messageTokens: number
  }
  contextWindow: number
  contextWindowSource: 'model' | 'provider' | 'fallback'
}
```

In `packages/sdk/src/utils/usage.ts`, implement:
- `normalizeProviderUsage(raw, options?)`.
- `getCachedTokens(usage)`.
- `calculateAutoCompactThreshold(contextWindow, maxOutputTokens?)`.
- `createAgentProgressTracker()` with `update(usage)` and `snapshot()`.
- `createEstimatedContextUsage({ messageTokens, systemTokens, memoryTokens, toolSchemaTokens, contextWindow, contextWindowSource })`.

- [ ] **Step 3: Run helper tests**

Run: `rtk bun test packages/sdk/src/utils/usage.test.ts`
Expected: PASS.

### Task 1.2: Compute context usage from SDK messages

**Files:**
- Modify: `packages/sdk/src/utils/usage.ts`
- Modify: `packages/sdk/src/utils/usage.test.ts`
- Modify: `packages/sdk/src/types.ts`

- [ ] **Step 1: Write failing context snapshot tests**

Add tests for:
- latest `callerKind: "conversation"` assistant usage anchors context.
- `callerKind: "compaction"` is ignored.
- subagent usage with `callerKind: "subagent"` is ignored for main context.
- tail messages after the anchor are estimated and added.
- no provider anchor returns `source: "estimated"` with explicit sections.

Run: `rtk bun test packages/sdk/src/utils/usage.test.ts`
Expected: FAIL for missing `createContextUsageSnapshot`.

- [ ] **Step 2: Implement context snapshot helper**

Add `createContextUsageSnapshot(messages, options)` where `messages` are `NormalizedMessageParam[]` extended with optional usage metadata. It must:
- walk backward to find the latest assistant message with `usage` and `usageIdentity.callerKind === "conversation"`.
- require matching `threadId`.
- return `normalizedUsage.totalTokens + estimateMessagesTokens(messagesAfterAnchor)`.
- fall back to estimated sections when no provider anchor exists.

- [ ] **Step 3: Run helper tests**

Run: `rtk bun test packages/sdk/src/utils/usage.test.ts`
Expected: PASS.

## Chunk 2: SDK Engine And Compaction Integration

### Task 2.1: Emit assistant usage and latest result contract

**Files:**
- Modify: `packages/sdk/src/engine.ts`
- Modify: `packages/sdk/src/types.ts`
- Test: `packages/sdk/src/engine.test.ts`

- [ ] **Step 1: Write failing engine tests**

Extend `packages/sdk/src/engine.test.ts` with cases that assert:
- yielded assistant message has `message.usage` and `message.usageIdentity.callerKind === "conversation"`.
- final result has `billingUsage.cumulative`, `billingUsage.latestRecord`, `billingUsage.records`, and `contextUsage`.
- final result does not require consumers to read legacy `usage/model_usage/modelUsage`.
- `billingUsage.latestRecord.outputTokens` equals the latest provider call output.

Run: `rtk bun test packages/sdk/src/engine.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement engine usage recording**

In `QueryEngine`:
- replace direct mutation of `totalUsage` in `recordProviderUsage` with normalized billing accumulation.
- attach `UsageIdentity` with `threadId: this.sessionId`, `callerKind: "conversation"`, `turn: this.turnCount`, and a stable `responseId`.
- push `usageRecords` with identity fields.
- include `usage` and `usageIdentity` on yielded assistant message.
- compute `contextUsage` before final result.
- emit `billingUsage` and `contextUsage` in result.

- [ ] **Step 3: Run engine tests**

Run: `rtk bun test packages/sdk/src/engine.test.ts`
Expected: PASS for updated tests.

### Task 2.2: Switch auto-compaction to context usage

**Files:**
- Modify: `packages/sdk/src/engine.ts`
- Modify: `packages/sdk/src/utils/compact.ts`
- Test: `packages/sdk/src/engine.test.ts`

- [ ] **Step 1: Write failing auto-compact tests**

Add tests that:
- create a provider response with high billing cumulative but low `contextUsage.totalTokens`, and assert auto-compact does not trigger.
- create a context snapshot above `calculateAutoCompactThreshold`, and assert auto-compact starts.
- assert compact summary provider usage is recorded as `callerKind: "compaction"` billing data and is not used as a later context anchor.

Run: `rtk bun test packages/sdk/src/engine.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement threshold and compaction usage**

Change:
- `shouldCompactAutomatically()` to call `createContextUsageSnapshot` and compare `contextUsage.totalTokens >= calculateAutoCompactThreshold(contextUsage.contextWindow, this.config.maxTokens)`.
- `runCompaction()` `preTokens` to use `contextUsage.totalTokens`.
- compact result `postTokens` to remain compacted message estimate until next provider response.
- `compactConversation()` to return normalized compaction usage/record from the summary provider call.
- engine billing to include compaction records with `callerKind: "compaction"` but never write them as assistant context anchors.

- [ ] **Step 3: Run SDK tests**

Run: `rtk bun test packages/sdk/src/utils/usage.test.ts packages/sdk/src/engine.test.ts`
Expected: PASS.

## Chunk 3: Shared Runtime Contract And Sidecar Mapping

### Task 3.1: Replace runtime usage event shape

**Files:**
- Modify: `packages/shared/src/types/runtime-event.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts`
- Test: `apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts`

- [ ] **Step 1: Write failing sidecar event tests**

Update tests so a result payload with `billingUsage/contextUsage` maps to:
- `usage.updated.context`.
- `usage.updated.billing.cumulative`.
- `usage.updated.billing.latestRecord`.
- `scope: "main"` for main thread events.

Add a test where legacy `usage/modelUsage` exist without `contextUsage`; expect no `usage.updated` context event from those legacy fields.

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement shared type and mapper**

In `packages/shared/src/types/runtime-event.ts`, replace `UsageUpdatedRuntimeEvent` flat fields with the latest contract from the spec.

In `run-item-events.ts`:
- read only `payload.contextUsage` and `payload.billingUsage`.
- omit `contextWindow` if it is invalid, but `contextUsage.contextWindow` should normally be positive.
- copy identity/scope fields.
- map records with `callerKind`, `threadId`, `subagentRunId`, `parentThreadId`, `inputTokens`, `outputTokens`, `cachedTokens`, and `costUSD`.
- do not read old `payload.usage`, `payload.modelUsage`, or `payload.model_usage` for `usage.updated`.

- [ ] **Step 3: Run sidecar event tests**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts`
Expected: PASS.

### Task 3.2: Persist semantic usage metadata

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state.ts`
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Update/add tests asserting visible assistant metadata stores:

```ts
tokenUsage: {
  source: 'provider',
  scope: 'assistant_turn',
  providerOutputTokens: 17,
}
contextUsage: {
  source: 'provider',
  totalTokens: 1234,
  contextWindow: 200000,
}
```

Also assert legacy result usage does not produce metadata token usage.

Run: `rtk bun test apps/sidecar/src/services/agent/agent-service.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement metadata extraction**

In `agent-service.ts`:
- replace `extractAssistantTurnTokenUsage` with latest-contract extraction.
- use `billingUsage.latestRecord.outputTokens` for provider output token.
- persist `contextUsage` from result.
- ignore old `result.usage`.

In `run-observer.ts` / `run-state.ts`:
- store semantic context/billing usage if run state needs usage summary.
- avoid storing billing cumulative as `usage.totalTokens` for context.

- [ ] **Step 3: Run persistence tests**

Run: `rtk bun test apps/sidecar/src/services/agent/agent-service.test.ts`
Expected: PASS.

## Chunk 4: Subagent Progress Isolation

### Task 4.1: Track child usage without parent context pollution

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `packages/sdk/src/tools/agent-tool.ts`
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`
- Test: `packages/sdk/src/tools/agent-tool.parallel.test.ts` or add focused tests near existing AgentTool tests.

- [ ] **Step 1: Write failing subagent tests**

Add tests that:
- child result with `contextUsage` emits/updates subagent `task_progress.usage.total_tokens` using latest input + cumulative output.
- child `contextUsage` does not emit a parent-scope `usage.updated.context`.
- usage records include `callerKind: "subagent"`, `subagentRunId`, and `parentThreadId` or `parentRunId`.

Run:
- `rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`
- `rtk bun test packages/sdk/src/tools/agent-tool.parallel.test.ts`

Expected: FAIL.

- [ ] **Step 2: Implement subagent progress tracker**

Use `createAgentProgressTracker` from SDK usage helpers or a sidecar-local equivalent if import boundaries require it.

In sidecar subagent path:
- update tracker from child `billingUsage.latestRecord` or child context/billing records.
- emit `task_progress` with real `total_tokens`.
- tag usage events as `scope: "subagent"` and keep identity.

In SDK `AgentTool`:
- replace hard-coded `total_tokens: 0` with progress tracker output.
- tag subagent provider calls with `callerKind: "subagent"` where available.

- [ ] **Step 3: Run subagent tests**

Run:
- `rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`
- `rtk bun test packages/sdk/src/tools/agent-tool.parallel.test.ts`

Expected: PASS.

## Chunk 5: Web Projection And Rendering

### Task 5.1: Context window reads semantic context only

**Files:**
- Modify: `apps/web/src/components/agent/runtime-state-projections.ts`
- Modify: `apps/web/src/components/agent/ContextWindowIndicator.tsx`
- Test: `apps/web/src/components/agent/runtime-state-projections.test.ts`
- Test: `apps/web/src/components/agent/ContextWindowIndicator.contract.test.tsx`

- [ ] **Step 1: Write failing web context tests**

Update tests to use:

```ts
{
  type: 'usage.updated',
  scope: 'main',
  context: {
    source: 'provider',
    totalTokens: 800,
    inputTokens: 720,
    outputTokens: 80,
    cachedTokens: 40,
    estimatedTailTokens: 0,
    contextWindow: 1000,
    contextWindowSource: 'model',
  },
  billing: { ... }
}
```

Add a test where `scope: "subagent"` is ignored by main ContextWindowIndicator.
Add a test where old flat fields are present on an `as any` event but ignored.

Run: `rtk bun test apps/web/src/components/agent/runtime-state-projections.test.ts apps/web/src/components/agent/ContextWindowIndicator.contract.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement projection changes**

In `runtime-state-projections.ts`:
- read `event.context.totalTokens/contextWindow` for progress.
- build sections from `event.context.inputTokens`, `event.context.cachedTokens`, `event.context.outputTokens`, and optionally `estimatedTailTokens`.
- build billing records from `event.billing.records`.
- filter context updates to `scope === "main"`.
- update `formatRuntimeEvent` for the latest usage shape.

In `ContextWindowIndicator.tsx`:
- adjust labels/types only if needed; keep UI compact.

- [ ] **Step 3: Run web context tests**

Run: `rtk bun test apps/web/src/components/agent/runtime-state-projections.test.ts apps/web/src/components/agent/ContextWindowIndicator.contract.test.tsx`
Expected: PASS.

### Task 5.2: Assistant footer and reopen metadata

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`
- Modify: `apps/web/src/components/agent/agent-message-state.ts`
- Test: `apps/web/src/components/agent/runtime-event-message-projection.test.ts`
- Test: `apps/web/src/components/agent/AgentMessages.test.ts`

- [ ] **Step 1: Write failing footer/metadata tests**

Update tests so:
- `usage.updated.billing.latestRecord.outputTokens` sets assistant token count.
- provider output can be applied after assistant message closes.
- reopened message metadata reads `metadata.tokenUsage.providerOutputTokens`.
- old `metadata.tokenUsage.outputTokens` is not used unless deliberately still produced by latest sidecar metadata.

Run: `rtk bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/AgentMessages.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement footer/metadata changes**

In `runtime-event-message-projection.ts`:
- replace `event.outputTokens` reads with `event.billing.latestRecord.outputTokens`.
- ignore subagent-scope usage for main assistant footer unless explicitly associated with the current assistant message.

In `agent-message-state.ts`:
- read latest metadata shape.
- preserve estimated token fallback for messages without provider metadata.

- [ ] **Step 3: Run footer/metadata tests**

Run: `rtk bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/AgentMessages.test.ts`
Expected: PASS.

## Chunk 6: Final Verification And Cleanup

### Task 6.1: Run targeted verification

**Files:**
- No new files unless fixing failures discovered by targeted tests.

- [ ] **Step 1: Run SDK tests touched by usage work**

Run:

```bash
rtk bun test packages/sdk/src/utils/usage.test.ts packages/sdk/src/engine.test.ts packages/sdk/src/tools/agent-tool.parallel.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run sidecar tests touched by runtime mapping**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runner/run-item-events.test.ts apps/sidecar/src/services/agent/agent-service.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run web tests touched by rendering**

Run:

```bash
rtk bun test apps/web/src/components/agent/runtime-state-projections.test.ts apps/web/src/components/agent/ContextWindowIndicator.contract.test.tsx apps/web/src/components/agent/runtime-event-message-projection.test.ts apps/web/src/components/agent/AgentMessages.test.ts
```

Expected: PASS.

- [ ] **Step 4: Inspect diff scope**

Run:

```bash
rtk git diff --stat
rtk git diff --name-only
```

Expected: only SDK usage/engine/compact, shared runtime event types, sidecar mapping/persistence/subagent, web projection/rendering tests and implementation files are changed. Do not revert unrelated pre-existing dirty files.

- [ ] **Step 5: Commit implementation**

Use the Lore protocol:

```bash
rtk git add <changed files for this implementation only>
rtk git commit -m "✨ feat(sdk,sidecar,web): 实现自动压缩 token 口径" \
  -m "..." \
  -m "Tested: ..."
```

Expected: one implementation commit containing only this task's files.
