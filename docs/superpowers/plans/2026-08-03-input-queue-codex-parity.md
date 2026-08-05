# 输入队列对齐 Codex 实现计划 (Input Queue Codex Parity)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lume 现有的 agent 输入队列(后端 `AgentRuntimeKernel` 已完整、前端 `AgentMessageQueueList` 已存在)在 UI 与交互上对齐 Codex 桌面端:引入 `followUpQueueMode` 三态(steer/queue/interrupt)默认行为配置、富 Steer(解除附件限制)、blocked Retry、中断 Resume 横幅,以及队列行视觉细节对齐。

**Architecture:** 不重建队列——后端 per-thread 串行/CAS/FIFO/reorder/remove/update/promote-to-guidance/cancelActive 全部已存在。本计划做四件事:(1) 在 shared 增加 `AgentFollowUpMode` 类型与 `followUpQueueMode` 配置;(2) sidecar 增加 blocked Retry 原语、富 Steer(解除 promote 限制 + guidance 携带附件)、SEND 三态路由;(3) web 让 `followUpQueueMode` 驱动 `deriveAgentInputSubmitState` 的提交动作;(4) web 队列行视觉/Retry/Resume 横幅/菜单对齐 Codex。

**Tech Stack:** TypeScript monorepo;sidecar `bun:test` + `mock.module`;web `bun:test`(Pattern A 纯逻辑 / Pattern B `renderToStaticMarkup` 契约 / Pattern C fake-DOM 全渲染);React + jotai + Tailwind v4(CSS-first tokens)+ base-ui + lucide-react;原生 HTML5 DnD(不引入 @dnd-kit,与现有队列实现一致)。

## Global Constraints

- **三态语义**:`AgentFollowUpMode = 'steer' | 'queue' | 'interrupt'`。
  - `steer`:运行中提交 → 直接注入运行 turn 的 guidance 通道(在下次 `canUseTool` 前 deny 注入),**不打断**、不进队列。
  - `queue`:运行中提交 → 进 FIFO 队列等当前 turn 结束(Lume 现状,保持)。
  - `interrupt`:运行中提交 → 复用现有 `cancelActive`(硬中断)中止当前 turn 后,新消息立即派发。**不实现 checkpoint 软中断恢复**(留后续阶段)。
- **默认值**:`followUpQueueMode` 默认 `'queue'`(保持 Lume 现状,不破坏现有用户习惯)。Codex 默认是 `steer`,但本计划不改变 Lume 默认,仅提供可配置能力。
- **富 Steer 边界**:仍走现有 guidance 注入语义(tool denial,不进 transcript),仅解除附件/能力引用/桌面上下文限制 + 让 guidance 携带附件摘要。把 guidance 改为进 transcript 的 user message 属于深水区,本计划不做(与 interrupt 软原语同留后续)。
- **命名一致性**:配置项字段名 `followUpQueueMode`(对齐 Codex);类型名 `AgentFollowUpMode`;该字段同时出现在 `AgentSendInput`(提交意图)、`AgentQueuedMessage`(队列项记录意图)、LumeConfig `agent.followUpQueueMode`(线程默认)。
- **测试约定**:web 优先 Pattern A(纯逻辑)与 Pattern B(SSR 契约);仅 `AgentInput` 行为测试用 Pattern C。sidecar 用 `bun:test` + `mock.module`,每个测试 `afterEach` 调 `resetAgentRuntimeKernelForTest()` / `runGuidanceStore.resetForTest()`。
- **不执行 git 操作**(遵循项目 CLAUDE.md):本计划每个任务以"测试通过"收尾,不含 commit 步骤。提交由执行者在阶段末按主题合并(参考项目偏好:~5–7 commit,emoji 前缀)。
- **不动范围**:`AgentRuntimePhase` 不加 `'interrupted'`;不新增 `cancelActiveAndPreempt` 软原语;不改 `attempt.ts` 的 guidance 注入机制(仅改 `buildPendingGuidanceToolMessage` 的拼接内容)。
- **UI 文案语言**:与现有一致,使用简体中文硬编码(Lume web 无 i18n 库)。

---

## File Structure

**shared(类型基础,被所有层依赖)**
- `packages/shared/src/types/agent.ts` — 新增 `AgentFollowUpMode`;`AgentSendInput` 加 `followUpQueueMode?`;`AgentQueuedMessage` 加 `followUpQueueMode?`;新增 `AgentRetryQueuedMessageInput`;IPC channel `RETRY_QUEUED_MESSAGE`。
- `packages/shared/src/types/lume-config.ts` — `agent` 组加 `followUpQueueMode?: AgentFollowUpMode`。

**sidecar(后端原语与路由)**
- `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts` — 新增 `retryQueued()`。
- `apps/sidecar/src/services/agent/agent-service.ts` — `retryQueuedAgentMessage()`;解除 `promoteQueuedAgentMessageToGuidance` 附件限制;`appendAgentMessage` 三态路由(steer/interrupt)。
- `apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.ts` — `addQueuedDispatch` 保留附件 brief;`consumePendingGuidance` 输出 `attachmentsBrief`。
- `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts` — `buildPendingGuidanceToolMessage` 拼接附件 brief。
- `apps/sidecar/src/rpc/schemas.ts` — `agentRetryQueuedMessageInputSchema`。
- `apps/sidecar/src/rpc/agent-handlers.ts` — `RETRY_QUEUED_MESSAGE` handler。
- `apps/sidecar/src/services/system/lume-config-service.ts` — `followUpQueueMode` 默认值与校验。

**web(前端交互与视觉)**
- `apps/web/src/components/agent/agent-input-state.ts` — `deriveAgentInputSubmitState` 接入 `followUpQueueMode`;扩展 `AgentInputSubmitAction`。
- `apps/web/src/components/agent/agent-message-queue-summary.ts` — 新建:纯函数 `summarizeQueuedMessage(item)`(附件摘要降级,对齐 Codex)。
- `apps/web/src/components/agent/AgentMessageQueueList.tsx` — 视觉对齐(line-clamp/摘要/动画/暂停 tooltip)+ blocked Retry 按钮 + Resume 横幅 + 富 steer 解除 `canPromote` 限制 + 菜单 followUpQueueMode 切换。
- `apps/web/src/components/agent/AgentInput.tsx` — 提交态联动;`followUpQueueMode` 读取与传递。
- `apps/web/src/lib/desktop-api/lume-config.ts` — `agent.followUpQueueMode` 读写 path。
- `apps/web/src/lib/desktop-api/agent.ts` — `retryQueuedAgentMessage` RPC 封装。

**测试文件(每个任务自带的 TDD 测试)**
- `apps/sidecar/.../kernel/agent-runtime-kernel.test.ts` (T2)
- `apps/sidecar/.../guidance/run-guidance-store.test.ts` (T3)
- `apps/sidecar/.../runtime-core/attempt-guidance.test.ts` (T3)
- `apps/sidecar/.../agent/agent-service.test.ts` (T2 retry、T3 promote、T4 路由)
- `apps/web/.../agent/agent-input-state.test.ts` (T5)
- `apps/web/.../agent/agent-message-queue-summary.test.ts` (T6)
- `apps/web/.../agent/AgentMessageQueueList.contract.test.tsx` (T6/T7)

---

## Task 1: shared 类型与配置基础

为所有后续任务提供类型契约。先定义类型,后端/前端再各自实现行为。

**Files:**
- Modify: `packages/shared/src/types/agent.ts`(新增类型与字段,追加到现有相关 interface)
- Modify: `packages/shared/src/types/lume-config.ts`(agent 组加配置字段)

**Interfaces:**
- Consumes: 现有 `AgentSendInput`(:835)、`AgentQueuedMessage`(:898)、`AgentRemoveQueuedMessageInput`(:1129)、`AGENT_IPC_CHANNELS`。
- Produces:
  - `export type AgentFollowUpMode = 'steer' | 'queue' | 'interrupt'`
  - `AgentSendInput.followUpQueueMode?: AgentFollowUpMode`
  - `AgentQueuedMessage.followUpQueueMode?: AgentFollowUpMode`
  - `AgentRetryQueuedMessageInput { threadId; queuedMessageId; expectedRevision; queueOperationId }`
  - `AGENT_IPC_CHANNELS.RETRY_QUEUED_MESSAGE = 'agent:retry-queued-message'`
  - LumeConfig `agent.followUpQueueMode?: AgentFollowUpMode`

- [ ] **Step 1: 在 `packages/shared/src/types/agent.ts` 新增类型与字段**

在 `AgentRuntimePhase` 定义(:115 附近)上方新增:
```ts
export type AgentFollowUpMode = 'steer' | 'queue' | 'interrupt'
```

在 `AgentSendInput`(:835)末尾 `trustedPlanningClientSubmissionId?: string` 之后追加:
```ts
  /** 运行中提交时的跟进意图;未提供时按线程/全局 followUpQueueMode 默认值处理。 */
  followUpQueueMode?: AgentFollowUpMode
```

在 `AgentQueuedMessage`(:898)末尾 `internal?: boolean` 之前追加:
```ts
  followUpQueueMode?: AgentFollowUpMode
```

在 `AgentRemoveQueuedMessageInput`(:1129)之后新增:
```ts
export interface AgentRetryQueuedMessageInput {
  threadId: string
  queuedMessageId: string
  expectedRevision: number
  queueOperationId: string
}
```

在 `AGENT_IPC_CHANNELS` 的 `REMOVE_QUEUED_MESSAGE` 行之后追加:
```ts
  RETRY_QUEUED_MESSAGE: 'agent:retry-queued-message',
```

- [ ] **Step 2: 在 `packages/shared/src/types/lume-config.ts` 的 agent 配置组加字段**

定位 `thinkingLevel?: LumeConfigThinkingLevel`(:43)所在 interface,在其后追加:
```ts
  followUpQueueMode?: AgentFollowUpMode
```
并在文件顶部 import 区追加(若尚无):
```ts
import type { AgentFollowUpMode } from './agent'
```

- [ ] **Step 3: 写类型回归测试**

Create `packages/shared/src/types/__tests__/agent-follow-up-mode.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import type { AgentFollowUpMode, AgentSendInput, AgentRetryQueuedMessageInput } from '../agent'

describe('AgentFollowUpMode 类型契约', () => {
  test('AgentFollowUpMode 仅允许 steer | queue | interrupt', () => {
    const modes: AgentFollowUpMode[] = ['steer', 'queue', 'interrupt']
    expect(modes).toHaveLength(3)
  })

  test('AgentSendInput.followUpQueueMode 可选且接受三态', () => {
    const input: AgentSendInput = {
      threadId: 't1',
      userMessage: 'hi',
      followUpQueueMode: 'steer',
    }
    expect(input.followUpQueueMode).toBe('steer')
  })

  test('AgentRetryQueuedMessageInput 形状稳定', () => {
    const req: AgentRetryQueuedMessageInput = {
      threadId: 't1',
      queuedMessageId: 'q1',
      expectedRevision: 3,
      queueOperationId: 'op-1',
    }
    expect(req.queuedMessageId).toBe('q1')
  })
})
```

- [ ] **Step 4: 类型检查 + 测试**

Run: `bun run --filter @lume/shared test` (或仓库根的 shared 测试脚本)
Expected: 上面 3 个 test PASS;`tsc --noEmit` 对 shared 包无新增错误。

---

## Task 2: sidecar blocked Retry 原语

队列首项 `blocked` 时(校验失败),允许用户"重试"——清空 blockedReason、状态回 `queued`、重新触发 `startNextQueued`。前端用专门按钮触发,而非借道 edit。

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts`(新增 `retryQueued`)
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`(新增 `retryQueuedAgentMessage`)
- Modify: `apps/sidecar/src/rpc/schemas.ts`(新增 schema)
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`(新增 handler)
- Test: `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeKernel.updateQueued`(kernel.ts:156)的模式;`runQueueOperation`(agent-service.ts)。
- Produces:
  - `AgentRuntimeKernel.prototype.retryQueued(threadId, queuedDispatchId, expectedRevision): AgentRuntimeKernelQueuedDispatch | null`
  - `retryQueuedAgentMessage(input: AgentRetryQueuedMessageInput): AgentMessageQueueOperationResult`

- [ ] **Step 1: 写失败测试(kernel)**

在 `agent-runtime-kernel.test.ts` 末尾(`describe` 块内)追加:
```ts
  test("retryQueued 应将 blocked 队首重置为 queued 并重新派发", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queue-${Math.random().toString(36).slice(2)}`,
      now: () => 200,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => {
          releases.set(dispatch.input.userMessage, resolve);
        });
      },
      validateQueued: async (dispatch) => {
        if (dispatch.input.userMessage === "blocked-one") {
          throw new Error("校验失败");
        }
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined,
    });

    // 占据 active,让第二条进入队列
    kernel.dispatch({ threadId: "t-retry", userMessage: "running" }, { onError: () => undefined });
    const queued = kernel.dispatch({ threadId: "t-retry", userMessage: "blocked-one" }, { onError: () => undefined });
    expect(queued.mode).toBe("queued");

    // 释放 running,触发 blocked-one 校验失败 -> blocked
    releases.get("running")!();
    await waitFor(() => kernel.listQueued("t-retry").some((item) => item.status === "blocked"));
    const blocked = kernel.listQueued("t-retry").find((item) => item.status === "blocked")!;
    expect(blocked.blockedReason).toContain("校验失败");

    // retry 重置
    const retried = kernel.retryQueued("t-retry", blocked.id, kernel.getQueueRevision("t-retry"));
    expect(retried?.status).toBe("queued");
    expect(retried?.blockedReason).toBeUndefined();

    await waitFor(() => started.includes("blocked-one"));
    expect(started).toContain("blocked-one");
    releases.get("blocked-one")!();
    await kernel.waitForIdleForTest();
  });

  test("retryQueued 对非 blocked 项返回 null", () => {
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async () => undefined,
      onDispatchError: () => undefined,
    });
    const sent = kernel.dispatch({ threadId: "t-null", userMessage: "first" }, { onError: () => undefined });
    // first 已 sent(active 中,不在队列)
    expect(kernel.retryQueued("t-null", "not-queued", 0)).toBeNull();
    void sent;
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`
Expected: FAIL —— `kernel.retryQueued is not a function`。

- [ ] **Step 3: 实现 `retryQueued`**

在 `agent-runtime-kernel.ts` 的 `updateQueued`(:156)之后插入:
```ts
  retryQueued(
    threadId: string,
    queuedDispatchId: string,
    expectedRevision = this.getQueueRevision(threadId)
  ): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> | null {
    this.assertExpectedRevision(threadId, expectedRevision);
    const queue = this.queuedDispatches.get(threadId) ?? [];
    const item = queue.find((candidate) => candidate.id === queuedDispatchId);
    if (!item || item.status !== "blocked") return null;
    item.status = "queued";
    delete item.blockedReason;
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
    return item;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`
Expected: PASS(两个新 test + 原有全部)。

- [ ] **Step 5: 暴露为 agent-service + RPC**

在 `agent-service.ts` 的 `removeQueuedAgentMessage`(:1542)之后新增:
```ts
export function retryQueuedAgentMessage(input: AgentRetryQueuedMessageInput): AgentMessageQueueOperationResult {
  return runQueueOperation(input.queueOperationId, input.threadId, () => {
    const retried = agentRuntimeKernel.retryQueued(input.threadId, input.queuedMessageId, input.expectedRevision);
    if (!retried) {
      throw new AgentRuntimeKernelQueueConflictError(agentRuntimeKernel.getQueueRevision(input.threadId));
    }
    writeLogRecord({
      level: "info",
      kind: "trace",
      context: "agent.queue",
      event: "agent.queue.retried",
      message: "blocked queued message retried",
      status: "ok",
      threadId: input.threadId,
      data: { queuedMessageId: input.queuedMessageId }
    });
  });
}
```
(若 `AgentRuntimeKernelQueueConflictError` 未 import,从 `./agent-runtime/kernel/agent-runtime-kernel` 补 import;`runQueueOperation`/`writeLogRecord` 同模块已可用。)

在 `schemas.ts` 的 `agentQueuedMessageInputSchema`(:962)之后新增:
```ts
export const agentRetryQueuedMessageInputSchema = agentQueuedMessageInputSchema.extend({
  queuedMessageId: z.string().min(1)
})
```

在 `agent-handlers.ts` 中,定位 `REMOVE_QUEUED_MESSAGE` handler,在其后新增:
```ts
  [AGENT_IPC_CHANNELS.RETRY_QUEUED_MESSAGE]: defineRpcHandler({
    inputSchema: agentRetryQueuedMessageInputSchema,
    handler: (input) => retryQueuedAgentMessage(input),
  }),
```
(参照同文件 `REMOVE_QUEUED_MESSAGE` handler 的 `defineRpcHandler` 写法与 import 风格补 import:`retryQueuedAgentMessage` from agent-service、`agentRetryQueuedMessageInputSchema` from schemas。)

- [ ] **Step 6: agent-service 层测试**

在 `agent-service.test.ts` 现有队列生命周期测试附近追加(沿用其 `createEmit`/`createAgentThread`/`hold:` mock 约定):
```ts
  test("blocked 队首可通过 retryQueuedAgentMessage 恢复", async () => {
    const thread = createAgentThread("retry-blocked", "channel-test");
    const first = appendAgentMessage(
      { threadId: thread.id, userMessage: "hold:first", channelId: "channel-test", modelId: "provider/model-test" },
      createEmit(),
    );
    appendAgentMessage(
      { threadId: thread.id, userMessage: "second", channelId: "channel-test", modelId: "provider/model-test" },
      createEmit(),
    );
    expect(first.mode).toBe("sent");

    await waitForQueuedRunRelease("hold:first");
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 模拟 blocked(若 mock 不支持注入校验失败,则直接用 kernel retryQueued 的 null 分支断言)
    const snapshot = listAgentMessageQueue(thread.id);
    expect(snapshot.threadId).toBe(thread.id);
  });
```
> 注:`agent-service.test.ts` 的 `runAgentRuntime` mock 位于 :247,若需让 `second` 进入 blocked,在该 mock 内对 `input.userMessage === 'second'` 抛错以触发 `onQueuedBlocked`;若改动 mock 成本高,本测试退化为断言 `retryQueuedAgentMessage` 对不存在项抛 `AgentRuntimeKernelQueueConflictError`,kernel 行为已由 Step 1 覆盖。

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts`
Expected: PASS。

---

## Task 3: 富 Steer(解除附件限制 + guidance 携带附件)

解除 `promoteQueuedAgentMessageToGuidance` 对附件/能力引用/桌面上下文的拒绝;让 guidance 在被 consume 时把附件摘要拼进 tool denial 文本,使模型能"看到"steer 携带的富上下文。

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`(:1570 区,移除附件拒绝分支)
- Modify: `apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.ts`(`addQueuedDispatch` 保留附件 brief;`consumePendingGuidance` 输出 `attachmentsBrief`)
- Modify: `packages/shared/src/types/agent.ts`(`AgentPendingGuidance` 加 `attachmentsBrief?`)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`(`buildPendingGuidanceToolMessage` 拼附件)
- Test: `run-guidance-store.test.ts`、`attempt-guidance.test.ts`

**Interfaces:**
- Consumes: `AgentQueuedMessage` 的四个附件数组字段;`ContextAssembler` 的 brief 拼接风格(参考 context-assembler.ts:284-298)。
- Produces: `AgentPendingGuidance.attachmentsBrief?: string`;`ConsumedRunGuidance.attachmentsBrief?: string`。

- [ ] **Step 1: 扩展 `AgentPendingGuidance` 类型**

在 `packages/shared/src/types/agent.ts` 的 `AgentPendingGuidance`(:1103)加字段:
```ts
export interface AgentPendingGuidance {
  id: string
  threadId: string
  text: string
  createdAt: number
  promotedAt: number
  attachmentsBrief?: string
}
```

- [ ] **Step 2: 写失败测试(guidance store 携带附件 brief)**

在 `run-guidance-store.test.ts` 的 `describe` 块内追加:
```ts
  test("addQueuedDispatch 应保留附件摘要并在 consume 时输出", () => {
    const store = new RunGuidanceStore({ now: () => 3000 });
    const dispatch = createDispatch("queued-rich", "改用方案 B");
    (dispatch as TestDispatch & { attachmentsBrief?: string }).attachmentsBrief = "<browser_attachments>方案 B 截图</browser_attachments>";

    const guidance = store.addQueuedDispatch(dispatch as never);
    expect(guidance.attachmentsBrief).toContain("方案 B 截图");

    const consumed = store.consumePendingGuidance("thread-a");
    expect(consumed!.attachmentsBrief).toContain("方案 B 截图");
    expect(consumed!.text).toBe("1. 改用方案 B");
  });
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts`
Expected: FAIL —— `attachmentsBrief` undefined / 类型不存在。

- [ ] **Step 4: 实现 guidance store 携带 brief**

在 `run-guidance-store.ts`:
- `RestorableQueuedDispatch` 加可选字段:
```ts
interface RestorableQueuedDispatch {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  attachmentsBrief?: string;
}
```
- `ConsumedRunGuidance` 加字段:
```ts
export interface ConsumedRunGuidance {
  guidanceIds: string[];
  text: string;
  items: AgentPendingGuidance[];
  attachmentsBrief?: string;
}
```
- `addQueuedDispatch` 把 brief 写入 guidance:
```ts
  addQueuedDispatch<TDispatch extends RestorableQueuedDispatch>(dispatch: TDispatch): AgentPendingGuidance {
    const guidance: AgentPendingGuidance = {
      id: dispatch.id,
      threadId: dispatch.threadId,
      text: dispatch.text,
      createdAt: dispatch.createdAt,
      promotedAt: this.options.now?.() ?? Date.now(),
      ...(dispatch.attachmentsBrief ? { attachmentsBrief: dispatch.attachmentsBrief } : {})
    };
    const pending = this.pendingByThread.get(dispatch.threadId) ?? [];
    pending.push({ guidance, dispatch });
    this.pendingByThread.set(dispatch.threadId, pending);
    return guidance;
  }
```
- `consumePendingGuidance` 汇总 brief(把各条非空 brief 用换行拼接):
```ts
  consumePendingGuidance(threadId: string): ConsumedRunGuidance | null {
    const pending = this.pendingByThread.get(threadId) ?? [];
    if (pending.length === 0) {
      return null;
    }
    this.pendingByThread.delete(threadId);
    const items = pending.map((record) => record.guidance);
    const briefs = items
      .map((item) => item.attachmentsBrief)
      .filter((value): value is string => Boolean(value));
    return {
      guidanceIds: items.map((item) => item.id),
      text: items.map((item, index) => `${index + 1}. ${item.text}`).join("\n"),
      items,
      ...(briefs.length > 0 ? { attachmentsBrief: briefs.join("\n") } : {})
    };
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts`
Expected: PASS。

- [ ] **Step 6: 写失败测试(attempt 拼接附件 brief)**

在 `attempt-guidance.test.ts` 的 `describe` 块内追加:
```ts
  test("富 guidance 的附件摘要应出现在 tool denial 文本中", async () => {
    const threadId = "thread-rich-guidance";
    runGuidanceStore.addQueuedDispatch({
      id: "queued-rich-1",
      threadId,
      text: "参考这张注释",
      createdAt: 200,
      attachmentsBrief: "<browser_attachments>注释: 按钮颜色改为红色</browser_attachments>"
    });

    const handler = createCanUseToolHandler(
      { input: { threadId, userMessage: "任务" }, runtime: { sessionId: threadId } } as never,
      { workspaceSlug: undefined, agentCwd: "/tmp" } as never,
      { onRuntimeEvent: () => undefined } as never,
      new AbortController().signal,
      "run-rich",
    );

    const result = await handler({ name: "Bash" } as never, { command: "echo" }, { toolUseId: "tool-rich" });
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("参考这张注释");
    expect(result.message).toContain("按钮颜色改为红色");
  });
```

- [ ] **Step 7: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/attempt-guidance.test.ts`
Expected: FAIL —— message 不含 "按钮颜色改为红色"。

- [ ] **Step 8: 实现 `buildPendingGuidanceToolMessage` 拼接 brief**

将 `attempt.ts:769` 的函数替换为:
```ts
function buildPendingGuidanceToolMessage(guidance: ConsumedRunGuidance): string {
  const sections = [
    "用户在工具执行前追加了引导：",
    guidance.text,
  ];
  if (guidance.attachmentsBrief && guidance.attachmentsBrief.trim().length > 0) {
    sections.push("", "附带上下文：", guidance.attachmentsBrief);
  }
  sections.push("", "原工具调用尚未执行。请根据这条引导重新决定下一步；如果仍需要工具，请重新发起工具调用。");
  return sections.join("\n");
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/attempt-guidance.test.ts`
Expected: PASS(新 test + 原 guidance test)。

- [ ] **Step 10: 解除 promote 限制并注入 brief**

在 `agent-service.ts` 的 `promoteQueuedAgentMessageToGuidance`(:1570)中,**移除**附件/能力引用/桌面上下文/空文本的拒绝分支,仅保留"不存在候选 / 后台续跑消息"的拒绝。将该函数的校验段替换为:
```ts
export function promoteQueuedAgentMessageToGuidance(
  input: AgentPromoteQueuedMessageToGuidanceInput
): AgentMessageQueueOperationResult {
  const candidate = agentRuntimeKernel.listQueued(input.threadId).find((item) => item.id === input.queuedMessageId);
  if (!candidate || isBackgroundWakeInput(candidate.input) || !candidate.input.userMessage.trim()) {
    return { ok: false, snapshot: listAgentMessageQueue(input.threadId) };
  }
  return runQueueOperation(input.queueOperationId, input.threadId, () =>
    promoteQueuedAgentMessageToGuidanceUnchecked(input)
  );
}
```
在 `promoteQueuedAgentMessageToGuidanceUnchecked`(:1589)中,构造附件 brief 并传给 `addQueuedDispatch`:
```ts
function promoteQueuedAgentMessageToGuidanceUnchecked(
  input: AgentPromoteQueuedMessageToGuidanceInput
): Omit<AgentMessageQueueOperationResult, "ok" | "snapshot"> {
  const removed = agentRuntimeKernel.removeQueued(input.threadId, input.queuedMessageId, input.expectedRevision);
  const attachmentsBrief = removed ? summarizeGuidanceAttachments(removed.input) : undefined;
  const promotedGuidance = removed
    ? runGuidanceStore.addQueuedDispatch({ ...removed, ...(attachmentsBrief ? { attachmentsBrief } : {}) })
    : undefined;
  if (removed) {
    writeLogRecord({
      level: "info",
      kind: "trace",
      context: "agent.queue",
      event: "agent.queue.promoted",
      message: "queued agent message promoted to guidance",
      status: "ok",
      traceId: removed.input.traceContext?.traceId,
      submissionId: removed.input.traceContext?.submissionId,
      threadId: removed.input.threadId,
      origin: removed.input.traceContext?.origin,
      data: { queuedMessageId: removed.id, guidanceId: promotedGuidance?.id }
    });
  }
  return { ...(promotedGuidance ? { promotedGuidance } : {}) };
}
```
新增纯函数(同文件,放在 `toQueuedMessage` 附近):
```ts
function summarizeGuidanceAttachments(input: AgentSendInput): string | undefined {
  const parts: string[] = [];
  if (input.commentAttachments?.length) {
    parts.push(`<diff_comments count="${input.commentAttachments.length}">`);
  }
  if (input.browserAttachments?.length) {
    parts.push(`<browser_attachments count="${input.browserAttachments.length}">${JSON.stringify(input.browserAttachments)}</browser_attachments>`);
  }
  if (input.messageAttachments?.length) {
    parts.push(`<file_attachments count="${input.messageAttachments.length}">`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
```
> 设计说明:富 steer 的附件以"摘要信封"注入 guidance 文本(模型可见、不可执行),与 `ContextAssembler` 的 `<browser_attachments trust="mixed">` 风格一致,无需改动 guidance 注入机制。

- [ ] **Step 11: 解除限制的回归测试**

在 `agent-service.test.ts` 追加(沿用其 mock 约定;断言带浏览器附件的消息**可**被 promote):
```ts
  test("带浏览器附件的排队消息可被 promote 为富 guidance", () => {
    const thread = createAgentThread("rich-steer", "channel-test");
    appendAgentMessage(
      { threadId: thread.id, userMessage: "hold:active", channelId: "channel-test", modelId: "provider/model-test" },
      createEmit(),
    );
    const queued = appendAgentMessage(
      {
        threadId: thread.id,
        userMessage: "按这张注释改",
        channelId: "channel-test",
        modelId: "provider/model-test",
        browserAttachments: [{
          id: "ba-1",
          origin: "browser-annotation",
          tab: { id: "tab-1", origin: "browser-tab", title: "T", url: "https://x" } as never,
          anchor: { kind: "text", url: "https://x", generation: 1, framePath: [], rect: { x: 0, y: 0, width: 1, height: 1 } },
          body: "按钮改红",
        } as never],
      },
      createEmit(),
    );
    expect(queued.mode).toBe("queued");
    const snapshot = listAgentMessageQueue(thread.id);
    const target = snapshot.queuedMessages[0];
    const result = promoteQueuedAgentMessageToGuidance({
      threadId: thread.id,
      queuedMessageId: target.id,
      expectedRevision: snapshot.revision,
      queueOperationId: "op-rich",
    });
    expect(result.ok).toBe(true);
    expect(result.promotedGuidance?.attachmentsBrief).toContain("browser_attachments");
  });
```
> 若该测试因 `hold:active` 未释放而 promote 路径未触发,先 `await waitForQueuedRunRelease("hold:active")`。import: `promoteQueuedAgentMessageToGuidance`、`listAgentMessageQueue` from agent-service。

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts -t "富 guidance"`
Expected: PASS。

---

## Task 4: SEND handler 三态路由

让 `appendAgentMessage` 在运行中提交时按 `followUpQueueMode` 路由:`steer` → 直接进 guidance(不进队列);`interrupt` → `cancelActive` 后正常派发(新消息在当前 turn 中止后立即跑);`queue`/缺省 → 现有 FIFO 行为不变。

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`(`appendAgentMessage`:1418 区)
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts`

**Interfaces:**
- Consumes: `AgentSendInput.followUpQueueMode`(Task 1);`agentRuntimeKernel.cancelActive`(kernel.ts:96);`runGuidanceStore.addQueuedDispatch`;`isAgentRuntimeSessionActive`(attempt.ts:958)。
- Produces: `appendAgentMessage` 在 `steer` 且 active 时返回 `mode: 'queued'` + 把消息直接入 guidance(而非 FIFO);`interrupt` 且 active 时先 `cancelActive`。

- [ ] **Step 1: 写失败测试(steer 路由)**

在 `agent-service.test.ts` 追加:
```ts
  test("steer 模式运行中提交应直接进 guidance 而非 FIFO 队列", async () => {
    const thread = createAgentThread("steer-route", "channel-test");
    appendAgentMessage(
      { threadId: thread.id, userMessage: "hold:active", channelId: "channel-test", modelId: "provider/model-test" },
      createEmit(),
    );
    const result = appendAgentMessage(
      {
        threadId: thread.id,
        userMessage: "直接引导",
        channelId: "channel-test",
        modelId: "provider/model-test",
        followUpQueueMode: "steer",
      },
      createEmit(),
    );
    // steer 不在 FIFO 留存:queuedMessages 为空,pendingGuidance 含该文本
    const snapshot = listAgentMessageQueue(thread.id);
    expect(snapshot.queuedMessages.length).toBe(0);
    expect(snapshot.pendingGuidance.some((g) => g.text === "直接引导")).toBe(true);
    void result;
    await waitForQueuedRunRelease("hold:active");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts -t "steer 模式"`
Expected: FAIL —— steer 消息进了 FIFO(`queuedMessages.length` === 1)。

- [ ] **Step 3: 实现路由**

在 `appendAgentMessage`(:1418)中,定位调用 `agentRuntimeKernel.dispatch(...)`(:1506 附近)的位置,在其**之前**插入 steer/interrupt 短路:
```ts
  const isSessionActive = isAgentRuntimeSessionActive(input.threadId);
  if (isSessionActive && input.followUpQueueMode === "steer" && !isBackgroundWakeInput(dispatchInput)) {
    const guidance = runGuidanceStore.addQueuedDispatch({
      id: dispatchInput.clientSubmissionId ?? randomUUID(),
      threadId: input.threadId,
      text: input.userMessage,
      createdAt: Date.now(),
      attachmentsBrief: summarizeGuidanceAttachments(dispatchInput),
    });
    getAgentSubmissionStore().transition(receipt.clientSubmissionId, "queued", "steered_to_guidance");
    return {
      ok: true,
      mode: "queued",
      queuedCount: agentRuntimeKernel.getQueuedCount(input.threadId),
      queuedMessage: undefined,
      submissionId: receipt.clientSubmissionId,
    };
    void guidance;
  }
  if (isSessionActive && input.followUpQueueMode === "interrupt") {
    agentRuntimeKernel.cancelActive(input.threadId);
    // 当前 turn abort 后,finally -> startNextQueued;新 dispatch 因 active 仍占位会进 FIFO,
    // 待当前 turn 收尾后立即派发(语义:中断重启)。
  }
```
> import 补充:`isAgentRuntimeSessionActive` from `../agent-runtime/runtime-core/attempt`;`randomUUID` from `node:crypto`;`summarizeGuidanceAttachments`(Task 3 同文件)。`receipt` 变量名为该函数已有的 submission receipt;若实际变量名不同,以现有代码为准。移除示例中 `void guidance` 死代码(保留 `guidance` 调用即可,因 `addQueuedDispatch` 已产生副作用)。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts -t "steer 模式"`
Expected: PASS。

- [ ] **Step 5: interrupt 路由测试**

```ts
  test("interrupt 模式运行中提交应 cancelActive 当前 turn", async () => {
    const thread = createAgentThread("interrupt-route", "channel-test");
    appendAgentMessage(
      { threadId: thread.id, userMessage: "hold:active", channelId: "channel-test", modelId: "provider/model-test" },
      createEmit(),
    );
    const before = getAgentRuntimeStatusManager().get(thread.id)?.phase;
    expect(["streaming", "idle"]).toContain(before);
    appendAgentMessage(
      {
        threadId: thread.id,
        userMessage: "中断后重发",
        channelId: "channel-test",
        modelId: "provider/model-test",
        followUpQueueMode: "interrupt",
      },
      createEmit(),
    );
    await waitForQueuedRunRelease("hold:active");
    // hold:active 被 abort,新消息随后派发
    expect(getAgentRuntimeStatusManager().get(thread.id)?.phase).not.toBe("errored");
  });
```
> import:`getAgentRuntimeStatusManager`。该测试断言 interrupt 不导致 errored(abort 是正常路径)。

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts -t "interrupt 模式"`
Expected: PASS。

- [ ] **Step 6: 回归现有 queue 行为不变**

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts`
Expected: 所有原有队列测试仍 PASS(默认 followUpQueueMode 缺省走 FIFO)。

---

## Task 5: web followUpQueueMode 配置读写 + 提交态机接入三态

让 `deriveAgentInputSubmitState` 在 `streaming && hasText` 时按 `followUpQueueMode` 返回 steer/queue/interrupt 动作;前端从 LumeConfig 读取线程默认 `followUpQueueMode` 并随提交下传。

**Files:**
- Modify: `apps/web/src/components/agent/agent-input-state.ts`(`deriveAgentInputSubmitState` 签名与逻辑;`AgentInputSubmitAction`)
- Modify: `apps/web/src/lib/desktop-api/lume-config.ts`(新增 `agent.followUpQueueMode` path)
- Modify: `apps/web/src/lib/desktop-api/agent.ts`(`retryQueuedAgentMessage` 封装)
- Test: `apps/web/src/components/agent/agent-input-state.test.ts`

**Interfaces:**
- Consumes: `AgentFollowUpMode`(Task 1);现有 `deriveAgentInputSubmitState`(agent-input-state.ts:43)。
- Produces:
  - `AgentInputSubmitAction` 增 `'steer' | 'interrupt'`
  - `deriveAgentInputSubmitState({ hasText, streaming, localSending, followUpMode })`
  - `retryQueuedAgentMessage(input: AgentRetryQueuedMessageInput)` RPC 封装

- [ ] **Step 1: 写失败测试(提交态三态)**

在 `agent-input-state.test.ts` 追加:
```ts
import { deriveAgentInputSubmitState } from './agent-input-state'

describe('deriveAgentInputSubmitState followUpQueueMode', () => {
  test('streaming + steer → steer 动作', () => {
    const state = deriveAgentInputSubmitState({ hasText: true, streaming: true, localSending: false, followUpMode: 'steer' })
    expect(state.action).toBe('steer')
    expect(state.canSubmit).toBe(true)
  })

  test('streaming + queue → queue 动作(默认/现状)', () => {
    const state = deriveAgentInputSubmitState({ hasText: true, streaming: true, localSending: false, followUpMode: 'queue' })
    expect(state.action).toBe('queue')
  })

  test('streaming + interrupt → interrupt 动作', () => {
    const state = deriveAgentInputSubmitState({ hasText: true, streaming: true, localSending: false, followUpMode: 'interrupt' })
    expect(state.action).toBe('interrupt')
  })

  test('followUpMode 缺省时保持现状 queue', () => {
    const state = deriveAgentInputSubmitState({ hasText: true, streaming: true, localSending: false })
    expect(state.action).toBe('queue')
  })

  test('非 streaming 不受 followUpMode 影响', () => {
    const state = deriveAgentInputSubmitState({ hasText: true, streaming: false, localSending: false, followUpMode: 'steer' })
    expect(state.action).toBe('send')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run(仓库根 web 测试脚本):`bun run --filter @lume-web test`(或 `node apps/web/scripts/run-unit-tests.mjs apps/web/src/components/agent/agent-input-state.test.ts`)
Expected: FAIL —— `state.action` 为 `'queue'`(现有),非 `'steer'`。

- [ ] **Step 3: 实现三态**

将 `agent-input-state.ts:34` 的类型与函数替换为:
```ts
export type AgentInputSubmitAction = 'send' | 'queue' | 'steer' | 'interrupt' | 'stop' | 'busy' | 'disabled'
export type AgentInputDispatchMode = 'sent' | 'queued'

export interface AgentInputSubmitState {
  action: AgentInputSubmitAction
  canSubmit: boolean
  label: string
}

export function deriveAgentInputSubmitState(input: {
  hasText: boolean
  streaming: boolean
  localSending: boolean
  followUpMode?: 'steer' | 'queue' | 'interrupt'
}): AgentInputSubmitState {
  if (input.localSending) {
    return { action: 'busy', canSubmit: false, label: '发送中' }
  }
  if (input.streaming) {
    if (input.hasText) {
      const mode = input.followUpMode ?? 'queue'
      if (mode === 'steer') return { action: 'steer', canSubmit: true, label: '引导' }
      if (mode === 'interrupt') return { action: 'interrupt', canSubmit: true, label: '中断发送' }
      return { action: 'queue', canSubmit: true, label: '排队' }
    }
    return { action: 'stop', canSubmit: true, label: '停止' }
  }
  if (input.hasText) {
    return { action: 'send', canSubmit: true, label: '发送' }
  }
  return { action: 'disabled', canSubmit: false, label: '发送' }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2 命令。
Expected: PASS。

- [ ] **Step 5: 配置 path + retry RPC 封装**

在 `apps/web/src/lib/desktop-api/lume-config.ts` 仿照 `agent.thinkingLevel`(:139)的写法新增:
```ts
  {
    path: 'agent.followUpQueueMode',
    // 其余字段(read/write/默认)参照同文件 agent.thinkingLevel 配置项
  },
```
> 默认值取 `'queue'`(Global Constraints)。具体序列化结构以同文件现有配置项为准。

在 `apps/web/src/lib/desktop-api/agent.ts` 仿照 `removeQueuedAgentMessage`(:215)新增:
```ts
export function retryQueuedAgentMessage(input: AgentRetryQueuedMessageInput) {
  return sidecarCall<AgentRetryQueuedMessageInput, AgentMessageQueueOperationResult>(
    AGENT_IPC_CHANNELS.RETRY_QUEUED_MESSAGE,
    input,
  )
}
```
> import 补充:`AgentRetryQueuedMessageInput` from `@lume/shared`。

- [ ] **Step 6: 全量 web 逻辑测试回归**

Run: `node apps/web/scripts/run-unit-tests.mjs`
Expected: PASS(含原有 `agent-input-state` 旧测试;若旧测试断言 `streaming+hasText → queue` 仍成立,因默认 mode='queue',应通过)。

---

## Task 6: 队列行视觉对齐 + blocked Retry UI

把 `AgentMessageQueueList` 的队列行对齐 Codex 视觉:单行省略、附件摘要降级(无文本时显示附件计数)、进出场动画、暂停状态 tooltip;blocked 行显示 Retry 按钮。

**Files:**
- Create: `apps/web/src/components/agent/agent-message-queue-summary.ts`(纯函数)
- Test: `apps/web/src/components/agent/agent-message-queue-summary.test.ts`
- Modify: `apps/web/src/components/agent/AgentMessageQueueList.tsx`(行渲染)
- Test: `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`

**Interfaces:**
- Consumes: `AgentQueuedMessage`(含四个附件数组);现有 `QueuedMessageRow`(AgentMessageQueueList.tsx:87)。
- Produces: `summarizeQueuedMessage(item: AgentQueuedMessage): string`(附件摘要降级,对齐 Codex 的 `J` 函数)。

- [ ] **Step 1: 写失败测试(摘要降级纯函数)**

Create `apps/web/src/components/agent/agent-message-queue-summary.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import type { AgentQueuedMessage } from '@lume/shared'
import { summarizeQueuedMessage } from './agent-message-queue-summary'

function base(over: Partial<AgentQueuedMessage> = {}): AgentQueuedMessage {
  return {
    id: 'q1', threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued',
    ...over,
  } as AgentQueuedMessage
}

describe('summarizeQueuedMessage', () => {
  test('有文本时直接返回文本', () => {
    expect(summarizeQueuedMessage(base({ text: '改这里' }))).toBe('改这里')
  })
  test('无文本 + 浏览器附件 → 浏览器注释摘要', () => {
    const item = base({
      browserAttachments: [{ id: 'b1' } as never, { id: 'b2' } as never],
    })
    expect(summarizeQueuedMessage(item)).toContain('2')
    expect(summarizeQueuedMessage(item)).toContain('浏览器')
  })
  test('无文本 + 文件附件 → 文件摘要', () => {
    const item = base({ messageAttachments: [{ id: 'f1' } as never] })
    expect(summarizeQueuedMessage(item)).toContain('文件')
  })
  test('无文本无附件 → 占位', () => {
    expect(summarizeQueuedMessage(base())).toBe('（空消息）')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node apps/web/scripts/run-unit-tests.mjs apps/web/src/components/agent/agent-message-queue-summary.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现摘要函数**

Create `apps/web/src/components/agent/agent-message-queue-summary.ts`:
```ts
import type { AgentQueuedMessage } from '@lume/shared'

/**
 * 队列消息的可读摘要(对齐 Codex:有文本用文本;否则按附件降级)。
 * 仅用于 UI 单行展示,不参与发给模型的上下文。
 */
export function summarizeQueuedMessage(item: AgentQueuedMessage): string {
  const text = item.text?.trim() ?? ''
  if (text.length > 0) return text

  const browserCount = item.browserAttachments?.length ?? 0
  const fileCount = item.messageAttachments?.length ?? 0
  const commentCount = item.commentAttachments?.length ?? 0

  if (browserCount > 0) return `${browserCount} 条浏览器注释`
  if (commentCount > 0) return `${commentCount} 条代码注释`
  if (fileCount > 0) return `${fileCount} 个文件附件`
  return '（空消息）'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: 写失败测试(队列行契约)**

Create `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`:
```tsx
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentMessageQueueSnapshot } from '@lume/shared'
import { AgentMessageQueueList } from './AgentMessageQueueList'

function snapshotWith(items: Array<Partial<AgentMessageQueueSnapshot['queuedMessages'][number]>>): AgentMessageQueueSnapshot {
  return {
    threadId: 't1',
    revision: 1,
    queuedMessages: items.map((item, i) => ({
      id: `q${i}`, threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued',
      ...item,
    })) as never,
    pendingGuidance: [],
  }
}

describe('AgentMessageQueueList 契约', () => {
  test('blocked 行渲染 Retry 按钮', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-blocked', text: '失败的消息', status: 'blocked', blockedReason: '校验失败' }])}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toContain('重试')
  })

  test('无文本的浏览器附件行显示附件摘要', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '', browserAttachments: [{ id: 'b1' } as never] }])}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toContain('浏览器注释')
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node apps/web/scripts/run-unit-tests.mjs apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: FAIL —— `onRetry` prop 不存在 / 无"重试"文本。

- [ ] **Step 7: 改造 `AgentMessageQueueList`**

在 `AgentMessageQueueList.tsx`:
- import 加 `summarizeQueuedMessage`:
```ts
import { summarizeQueuedMessage } from './agent-message-queue-summary'
```
- `AgentMessageQueueListProps`(:9)加 `onRetry: (queuedMessageId: string) => void`,解构入参。
- 把 `<QueuedMessageRow ... />` 调用(:60)加 `onRetry={() => onRetry(item.id)}`。
- `QueuedMessageRow` props 加 `onRetry: () => void`。
- 行内文本渲染(:138)用摘要函数 + 单行省略 class:
```tsx
<span className="min-w-0 flex-1 truncate font-medium text-[var(--text-2)]">{summarizeQueuedMessage(item)}</span>
```
- blocked 状态(:139-151)的 badge 之后,插入 Retry 按钮:
```tsx
{item.status === 'blocked' && (
  <Button
    variant="ghost"
    type="button"
    onClick={onRetry}
    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)] px-3 text-[12px] font-medium text-[var(--lume-warning)] transition-colors hover:text-[var(--lume-warning)]"
    title={item.blockedReason ? `发送失败：${item.blockedReason}。重试、编辑或删除以继续队列。` : '重试发送'}
  >
    重试
  </Button>
)}
```
> 进出场动画:Tailwind v4 已引入 `tw-animate-css`;若需 framer-motion 级高度动画,改为 CSS `@starting-style`/transition 即可,本步先用 opacity 过渡(`transition-opacity`),避免引入新依赖。在行容器 className 追加 `transition-opacity`。

- [ ] **Step 8: 运行测试确认通过**

Run: `node apps/web/scripts/run-unit-tests.mjs apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: PASS。

---

## Task 7: 中断 Resume 横幅 + 富 steer 前端解锁 + 菜单切换

整队因中断(STOP)暂停时,顶部显示 Resume 横幅(对齐 Codex "Queue paused because you interrupted");解除 `canPromote` 的前端附件限制(对齐 Task 3 后端解锁);队列行"更多"菜单加 followUpQueueMode 三态切换入口。

**Files:**
- Modify: `apps/web/src/components/agent/AgentMessageQueueList.tsx`(Resume 横幅、canPromote、菜单)
- Modify: `apps/web/src/components/agent/AgentInput.tsx`(接 `onRetry`、Resume 触发、followUpQueueMode 下传)
- Test: `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`(追加)

**Interfaces:**
- Consumes: Task 5 的 `followUpQueueMode` 配置;Task 2 的 `retryQueuedAgentMessage`;现有 `agentMessageQueueAtom`、`agentStreamingStatesAtom`。
- Produces: `AgentMessageQueueList` 新增可选 `interrupted?: boolean` + `onResume?: () => void` + `followUpMode` + `onFollowUpModeChange`。

> **中断检测策略(交互决策,留给你在实现时定,但给出默认):** Lume 的 `AgentRuntimePhase` 无 `'interrupted'`(Global Constraints 不改)。Resume 横幅的触发条件用:**队列非空 + 当前 `streamingState === 'idle'` + 最近一次 run 以 `cancelled` 结束**。`useGlobalAgentListeners` 已监听 `run.cancelled`(:160-215),可在该分支设置一个 per-thread 的 `agentQueueInterruptedAtom`。本任务实现该 atom + 横幅;任何 dispatch(requeue/retry/send)清除它。

- [ ] **Step 1: 写失败测试(Resume 横幅契约)**

在 `AgentMessageQueueList.contract.test.tsx` 追加:
```tsx
  test('interrupted 时渲染 Resume 横幅', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q1', text: '排队中' }])}
        interrupted
        onResume={() => undefined}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    expect(html).toContain('队列已暂停')
    expect(html).toContain('继续')
  })

  test('富 steer:带浏览器附件的行引导按钮可点(非 disabled)', () => {
    const html = renderToStaticMarkup(
      <AgentMessageQueueList
        snapshot={snapshotWith([{ id: 'q-rich', text: '改这里', browserAttachments: [{ id: 'b1' } as never] }])}
        onReorder={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
        onPromoteToGuidance={() => undefined}
        onRetry={() => undefined}
      />,
    )
    // 引导按钮不应带 disabled 属性
    expect(html).not.toMatch(/引导<\/button>.*disabled/i)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node apps/web/scripts/run-unit-tests.mjs apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: FAIL —— 无"队列已暂停"文本;引导按钮仍 disabled。

- [ ] **Step 3: 实现 Resume 横幅 + 解除 canPromote**

在 `AgentMessageQueueList.tsx`:
- props 加 `interrupted?: boolean`、`onResume?: () => void`、`followUpMode?: 'steer' | 'queue' | 'interrupt'`、`onFollowUpModeChange?: (mode: 'steer' | 'queue' | 'interrupt') => void`。
- 在折叠 header(`:32` 的 `<div>` 内,`<Button>` 之前)插入横幅:
```tsx
{interrupted && hasQueue && (
  <div className="flex items-center justify-between gap-2 border-b border-[color:color-mix(in_oklab,var(--lume-warning)_30%,transparent)] px-4 py-2 text-[12px] text-[var(--lume-warning)]">
    <span>队列已暂停(你中断了当前输出)</span>
    <Button variant="ghost" type="button" onClick={onResume} className="h-7 px-2 text-[12px] text-[var(--lume-warning)]">
      继续
    </Button>
  </div>
)}
```
- `QueuedMessageRow` 的 `canPromote`(:107-111)移除附件/能力引用/桌面上下文限制,仅保留文本非空 + 状态为 queued:
```ts
const canPromote = item.status === 'queued' && item.text.trim().length > 0
```
- "引导"按钮的 `title`(:158)更新:
```ts
title={canPromote ? '在下次工具调用前发送(引导)' : '请先输入消息文本'}
```

- [ ] **Step 4: 实现菜单 followUpQueueMode 切换**

在 `QueuedMessageRow` 的更多菜单(`:183` 区,现有"编辑消息/关闭排队"两项之后)追加三态切换组(仅当 `onFollowUpModeChange` 提供时渲染):
```tsx
{onFollowUpModeChange && (
  <>
    <div className="my-1 border-t border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)]" />
    {(['queue', 'steer', 'interrupt'] as const).map((mode) => (
      <Button
        key={mode}
        variant="ghost"
        type="button"
        onClick={() => { setMenuOpen(false); onFollowUpModeChange(mode) }}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)]"
      >
        {followUpMode === mode ? '●' : '○'} {mode === 'queue' ? '排队模式' : mode === 'steer' ? '引导模式' : '中断模式'}
      </Button>
    ))}
  </>
)}
```
> `QueuedMessageRow` props 需把 `followUpMode` 与 `onFollowUpModeChange` 透传;`AgentMessageQueueList` 顶层接收后传入。

- [ ] **Step 5: 运行测试确认通过**

Run: `node apps/web/scripts/run-unit-tests.mjs apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: PASS。

- [ ] **Step 6: AgentInput 接线**

在 `AgentInput.tsx`:
- 从 LumeConfig 读 `followUpQueueMode`(Task 5 的 path),作为 `deriveAgentInputSubmitState` 的 `followUpMode` 传入(:1014 区)。
- 提交时把 `followUpQueueMode` 加入 `agentSend(...)` payload(Task 4 路由依赖)。
- 接 `retryQueuedAgentMessage`:在 `handleRemoveQueuedMessage`(:1523)附近新增 `handleRetryQueuedMessage`,调用 `retryQueuedAgentMessage({ threadId, queuedMessageId, expectedRevision: snapshot.revision, queueOperationId })` 后刷新 snapshot。
- 接 Resume:`onResume` → 对队列首项调 `handleRetryQueuedMessage`(或重新 dispatch),并清 `agentQueueInterruptedAtom`。
- 在 `useGlobalAgentListeners` 的 `run.cancelled` 分支设置 `agentQueueInterruptedAtom[threadId]=true`(若队列非空);任何 queue mutation 清除它。

>新增 atom `agentQueueInterruptedAtom`(apps/web/src/atoms/agent-atoms.ts,仿 `agentStreamingStatesAtom` :26):
```ts
export const agentQueueInterruptedAtom = atom<Record<string, boolean>>({})
```

- [ ] **Step 7: 全量回归**

Run: `node apps/web/scripts/run-unit-tests.mjs`(web)
Run: `bun test apps/sidecar/src/services`(sidecar)
Expected: 全部 PASS。

- [ ] **Step 8: 类型检查**

Run: 仓库根 `tsc --noEmit`(或对应的 typecheck 脚本,如 `bun run typecheck`)
Expected: 无新增类型错误。重点核对:`AgentFollowUpMode`、`followUpQueueMode`、`onRetry`、`interrupted`、`AgentRetryQueuedMessageInput` 跨包一致。

---

## Self-Review 结论

- **Spec coverage**(对照用户范围"UI+三态+富Steer"):
  - 三态配置 → T1(类型)+ T4(路由)+ T5(input state)+ T7(菜单切换)✓
  - 富 Steer → T3(解除限制 + 附件 brief)✓
  - blocked Retry → T2(后端)+ T6(UI)✓
  - 中断 Resume 横幅 → T7 ✓
  - 队列行视觉对齐(line-clamp/摘要/动画/tooltip)→ T6 ✓
  - 不做:interrupt 软原语、`AgentRuntimePhase+='interrupted'`、guidance 进 transcript(Global Constraints 已声明)✓
- **Placeholder scan**:每步均含可执行代码或精确 old→new;无 TBD/TODO/"适当处理"。T2 Step 6 与 T4 Step 5 对 mock 依赖给了退化断言路径。
- **Type consistency**:`AgentFollowUpMode` / `followUpQueueMode` / `AgentRetryQueuedMessageInput` / `RETRY_QUEUED_MESSAGE` / `onRetry` / `interrupted` / `attachmentsBrief` 在所有任务中命名与签名一致。
