# interrupt 软中断原语 实施计划（Codex 对齐 follow-up）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** STOP（用户中断当前 turn）后队列暂停（不自动派发下条）+ Resume 手动恢复派发，对齐 Codex `interrupted` 横幅语义。

**Architecture:** kernel 加 per-thread `paused` Set + `pauseQueue`/`resumeQueue`/`isPaused`；`startNextQueued` 开头检查 paused；`STOP_THREAD` handler 调 `pauseAgentQueue`；paused 经 `AgentMessageQueueSnapshot.paused` 暴露（刷新可恢复，防死锁）；新 `RESUME_QUEUE` IPC；web `handleResumeFromInterrupt` 改调该 IPC。

**Tech Stack:** TypeScript、bun:test、jotai、Electron IPC

## Global Constraints

- **起点**：`worktree-input-queue-ui-parity`（本地分支，PR7+UI 对齐+附件预览；基于它开独立 worktree）。注意：该分支未 push origin，用本地 ref。
- **不改 `AgentQueuedMessage.status`**（保持 `'queued'|'validating'|'blocked'`）——暂停是 **thread 级** `snapshot.paused`，非 per-message。
- **触发仅 STOP**（用户中断当前 turn，`STOP_THREAD`）；interrupt 模式提交（`followUpQueueMode:'interrupt'`）**本期不动**。
- **包管理器**：bun@1.3.13。
- **测试**：bun:test。kernel test 用 `new AgentRuntimeKernel` + `waitFor`（见现有 `retryQueued` 测试模板）。
- **文案/注释**：中文。
- **不主动 git 提交/推送**：worktree 内按 task 提交，最终合并由用户定。
- **关键陷阱**：`pauseQueue`/`resumeQueue` 只改状态不改队列 count，**不会**触发 `onQueuedCountChange` → 不会自动 `emitAgentMessageQueueChanged`，**必须手动 emit**。

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts` | 队列派发核心 | +`paused` Set / `pauseQueue`/`resumeQueue`/`isPaused` / `startNextQueued` 检查 |
| `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts` | kernel 测试 | +paused 测试（暂停不派发/resume 派发） |
| `packages/shared/src/types/agent.ts` | 共享类型/IPC channel | +`AgentMessageQueueSnapshot.paused?` / +`RESUME_QUEUE` channel / +`AgentResumeQueueInput` |
| `apps/sidecar/src/rpc/schemas.ts` | sidecar zod schema | +`agentResumeQueueInputSchema` |
| `apps/sidecar/src/services/agent/agent-service.ts` | sidecar 队列操作 | +`pauseAgentQueue`/`resumeAgentQueue` 导出 / `listAgentMessageQueue` 加 `paused` |
| `apps/sidecar/src/rpc/agent-handlers.ts` | IPC handler 注册 | `STOP_THREAD` 调 pauseAgentQueue / +`RESUME_QUEUE` handler |
| `apps/web/src/lib/desktop-api/agent.ts` | web→sidecar 调用 | +`resumeAgentQueue` |
| `apps/web/src/hooks/useGlobalAgentListeners.ts` | 监听 | `snapshot.paused` → `agentQueueInterruptedAtom` |
| `apps/web/src/components/agent/AgentInput.tsx` | 输入框 | `handleResumeFromInterrupt` 调 `resumeAgentQueue` IPC |

---

### Task 1: kernel paused 语义（TDD）

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts`
- Test: `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`

**Interfaces:**
- Produces: `pauseQueue(threadId: string): void`、`resumeQueue(threadId: string): void`、`isPaused(threadId: string): boolean`；`startNextQueued` 在 `paused.has(threadId)` 时早退。

- [ ] **Step 1: 写失败的测试**

在 `agent-runtime-kernel.test.ts` 末尾追加（沿用现有 `waitFor` + `releases` Map 模板，参考 `retryQueued` 测试）：
```ts
test("pauseQueue 暂停后 startNextQueued 不派发,resumeQueue 恢复派发", async () => {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
    createQueuedDispatchId: () => `queue-${Math.random().toString(36).slice(2)}`,
    now: () => 300,
    execute: async (dispatch) => {
      started.push(dispatch.input.userMessage);
      await new Promise<void>((resolve) => { releases.set(dispatch.input.userMessage, resolve); });
    },
    onQueuedCountChange: () => undefined,
    onDispatchError: () => undefined,
  });

  // 占据 active
  kernel.dispatch({ threadId: "t-pause", userMessage: "running" }, { onError: () => undefined });
  // 排队第二条
  kernel.dispatch({ threadId: "t-pause", userMessage: "next" }, { onError: () => undefined });
  await waitFor(() => started.includes("running"));

  // 暂停 + 释放 running(模拟 STOP abort 后 finally → startNextQueued)
  kernel.pauseQueue("t-pause");
  expect(kernel.isPaused("t-pause")).toBe(true);
  releases.get("running")!();

  // 给 finally 一点时间:paused 时不应派发 next
  await new Promise((r) => setTimeout(r, 20));
  expect(started).not.toContain("next");

  // resume → 派发 next
  kernel.resumeQueue("t-pause");
  expect(kernel.isPaused("t-pause")).toBe(false);
  await waitFor(() => started.includes("next"));

  releases.get("next")!();
});
```

- [ ] **Step 2: 跑确认 RED**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`
Expected: FAIL —— `kernel.pauseQueue is not a function`（或 `isPaused`）。

- [ ] **Step 3: 实现 kernel paused**

在 `agent-runtime-kernel.ts`：
1. 与现有 `private readonly activeThreads = new Set<string>();`（约 line 48）同区加：
```ts
private readonly paused = new Set<string>();
```
2. `startNextQueued`（约 line 258）方法体**开头**（`if (this.activeThreads.has(threadId)) return;` 之后）加：
```ts
if (this.paused.has(threadId)) return;
```
3. 与 `retryQueued`（约 line 167）同区（public 方法）加：
```ts
/** 暂停某线程的队列派发:startNextQueued 将跳过该线程,直到 resumeQueue。 */
pauseQueue(threadId: string): void {
  this.paused.add(threadId);
}

/** 解除暂停并尝试派发队列首项。 */
resumeQueue(threadId: string): void {
  if (!this.paused.delete(threadId)) return;
  if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
}

isPaused(threadId: string): boolean {
  return this.paused.has(threadId);
}
```

- [ ] **Step 4: 跑确认 GREEN**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`
Expected: PASS（新 paused 用例 + 现有全部）。

- [ ] **Step 5: commit**

```
✨ feat(sidecar): kernel 队列暂停语义(pauseQueue/resumeQueue/isPaused)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 2: shared 类型 + IPC channel + sidecar schema

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`

**Interfaces:**
- Produces: `AgentMessageQueueSnapshot.paused?: boolean`；`AGENT_IPC_CHANNELS.RESUME_QUEUE = 'agent:resume-queue'`；`AgentResumeQueueInput { threadId; queueOperationId }`；`agentResumeQueueInputSchema`。

- [ ] **Step 1: `AgentMessageQueueSnapshot` 加 `paused?`**

`packages/shared/src/types/agent.ts` 的 `export interface AgentMessageQueueSnapshot`（约 line 1099）末尾（`pendingGuidance` 后）加：
```ts
  /** 队列因 STOP 中断暂停(thread 级);Resume 后清除。renderer 据此显示 Resume 横幅(刷新可恢复)。 */
  paused?: boolean
```

- [ ] **Step 2: 加 `RESUME_QUEUE` channel + `AgentResumeQueueInput`**

在 `AGENT_IPC_CHANNELS`（约 line 2019，`RETRY_QUEUED_MESSAGE` 同组）加：
```ts
  RESUME_QUEUE: 'agent:resume-queue',
```
在合适位置（`AgentRetryQueuedMessageInput` 附近）加 input 类型：
```ts
export interface AgentResumeQueueInput {
  threadId: string
  queueOperationId: string
}
```

- [ ] **Step 3: sidecar schema**

`apps/sidecar/src/rpc/schemas.ts`（约 line 950，`agentQueuedMessageInputSchema` 附近）加：
```ts
export const agentResumeQueueInputSchema = z.object({
  threadId: idSchema,
  queueOperationId: idSchema,
});
```

- [ ] **Step 4: 类型检查**

Run: `cd packages/shared && bunx tsc --noEmit` 以及 `cd apps/sidecar && bunx tsc --noEmit`
Expected: 无错（新类型/channel/schema 编译通过）。

- [ ] **Step 5: commit**

```
✨ feat(shared): RESUME_QUEUE IPC + AgentMessageQueueSnapshot.paused

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 3: sidecar 接线（pause/resume 导出 + STOP pause + snapshot.paused + handler 注册）

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`

**Interfaces:**
- Consumes: kernel `pauseQueue`/`resumeQueue`/`isPaused`（Task 1）、`AgentResumeQueueInput`/`agentResumeQueueInputSchema`/`RESUME_QUEUE`（Task 2）
- Produces: `pauseAgentQueue(threadId)`、`resumeAgentQueue(input)` 导出；`listAgentMessageQueue` 含 `paused`；`STOP_THREAD` 调 pause；`RESUME_QUEUE` handler。

- [ ] **Step 1: `listAgentMessageQueue` 加 `paused`**

`agent-service.ts` 的 `listAgentMessageQueue`（约 line 1546）return 字面量加 `paused`：
```ts
export function listAgentMessageQueue(threadId: string): AgentMessageQueueSnapshot {
  return {
    threadId,
    revision: agentRuntimeKernel.getQueueRevision(threadId),
    queuedMessages: agentRuntimeKernel.listQueued(threadId).map(toQueuedMessage),
    pendingGuidance: runGuidanceStore.listPending(threadId),
    paused: agentRuntimeKernel.isPaused(threadId),
  };
}
```

- [ ] **Step 2: `pauseAgentQueue` / `resumeAgentQueue` 导出**

在 `agent-service.ts`（`retryQueuedAgentMessage` 附近，约 line 1565）加：
```ts
/** STOP 中断:暂停队列派发(不自动 startNextQueued)。手动 emit(pause 不改 count)。 */
export function pauseAgentQueue(threadId: string): void {
  agentRuntimeKernel.pauseQueue(threadId);
  emitAgentMessageQueueChanged(threadId);
}

/** Resume:解除暂停并派发队列首项。返回最新 snapshot。 */
export function resumeAgentQueue(input: AgentResumeQueueInput): AgentMessageQueueOperationResult {
  agentRuntimeKernel.resumeQueue(input.threadId);
  emitAgentMessageQueueChanged(input.threadId);
  return { ok: true, snapshot: listAgentMessageQueue(input.threadId) };
}
```
确保 import：`AgentResumeQueueInput`、`AgentMessageQueueOperationResult`（从 `@lume/shared`，通常已 import）。

- [ ] **Step 3: `STOP_THREAD` handler 调 pause**

`agent-handlers.ts` 的 `STOP_THREAD` handler（约 line 1813），在 `stopAgent(input.threadId);` 之后加：
```ts
    [AGENT_IPC_CHANNELS.STOP_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.STOP_THREAD);
      stopAgent(input.threadId);
      pauseAgentQueue(input.threadId);   // 新增:STOP 暂停队列(防 finally 自动派发下条)
      if (context.planModePhaseTracker.getPhase(input.threadId) === "executing") {
        context.planModePhaseTracker... // 保留现有
      }
      return { ok: true };
    },
```
（保留现有 handler 全部逻辑，只插入 `pauseAgentQueue` 一行。）
确保 import `pauseAgentQueue`（从 agent-service，与 `stopAgent` 同 import 区）。

- [ ] **Step 4: 注册 `RESUME_QUEUE` handler**

`agent-handlers.ts`（`RETRY_QUEUED_MESSAGE` handler 附近，约 line 1993）加：
```ts
    [AGENT_IPC_CHANNELS.RESUME_QUEUE]: async (params) => {
      const input = validateInput(
        agentResumeQueueInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESUME_QUEUE,
      );
      return resumeAgentQueue(input);
    },
```
确保 import：`resumeAgentQueue`（agent-service）、`agentResumeQueueInputSchema`（schemas）。

- [ ] **Step 5: 类型检查 + sidecar 测试无回归**

Run: `cd apps/sidecar && bunx tsc --noEmit && bun test src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts src/services/agent/agent-service.test.ts`
Expected: tsc 无错；kernel + agent-service 测试全过（不回归）。

- [ ] **Step 6: commit**

```
✨ feat(sidecar): STOP 暂停队列 + resumeQueue IPC + snapshot.paused

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 4: web 接线（desktop-api + snapshot.paused→atom + Resume 调 IPC）

**Files:**
- Modify: `apps/web/src/lib/desktop-api/agent.ts`
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

**Interfaces:**
- Consumes: `RESUME_QUEUE` channel、`AgentResumeQueueInput`（Task 2）、`resumeAgentQueue` IPC（Task 3）、`snapshot.paused`（Task 3）。

- [ ] **Step 1: `resumeAgentQueue` desktop-api**

`apps/web/src/lib/desktop-api/agent.ts`（`retryQueuedAgentMessage` 附近，约 line 222）加：
```ts
export const resumeAgentQueue = (input: AgentResumeQueueInput) =>
  invoke<AgentMessageQueueOperationResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.RESUME_QUEUE,
    params: input,
  });
```
确保 import：`AgentResumeQueueInput`、`AgentMessageQueueOperationResult`（从 `@lume/shared`）、`AGENT_IPC_CHANNELS`（已 import）。

- [ ] **Step 2: `useGlobalAgentListeners` 映射 `snapshot.paused` → atom**

`useGlobalAgentListeners.ts` 的 `MESSAGE_QUEUE_CHANGED` case（约 line 225-233）。把现有「队列空则清 interrupted」逻辑改为**以 `snapshot.paused` 为权威源**：
```ts
        case AGENT_IPC_CHANNELS.MESSAGE_QUEUE_CHANGED: {
          const snapshot = params as AgentMessageQueueSnapshot
          setMessageQueues((prev) => ({ ...prev, [snapshot.threadId]: snapshot }))
          // paused 权威源在 sidecar(kernel);snapshot.paused 驱动 Resume 横幅(刷新可恢复)。
          const nextPaused = snapshot.paused === true
          setQueueInterrupted((prev) => {
            const cur = prev[snapshot.threadId] === true
            if (cur === nextPaused) return prev
            return { ...prev, [snapshot.threadId]: nextPaused }
          })
          break
        }
```
（替换现有 `if (!snapshot.queuedMessages.some(...)) setQueueInterrupted false` 块。）

同时，**保留或收敛** `run.cancelled` 分支（约 line 209）现有的 `setQueueInterrupted(true)`：可保留作为即时反馈（snapshot 随后校正），或删除（让 snapshot.paused 唯一驱动）。**推荐保留**（run.cancelled 比 snapshot 推送快，横幅更即时；snapshot.paused 随后权威校正）。

- [ ] **Step 3: `handleResumeFromInterrupt` 调 IPC**

`AgentInput.tsx` 的 `handleResumeFromInterrupt`（约 line 1602）整段替换为调 IPC（参考 `handleRetryQueuedMessage` 模式）：
```ts
const handleResumeFromInterrupt = useCallback(() => {
  resumeAgentQueue({
    threadId,
    queueOperationId: crypto.randomUUID(),
  })
    .then((result) => {
      setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
      // snapshot.paused=false 会经由 useGlobalAgentListeners 自动清 atom;这里同步清避免延迟
      setQueueInterruptedStates((prev) => (prev[threadId] ? { ...prev, [threadId]: false } : prev))
      if (!result.ok) toast.error('恢复队列失败')
    })
    .catch((error) => {
      console.error('[AgentInput] 恢复队列失败:', error)
      toast.error('恢复队列失败')
    })
}, [threadId, setMessageQueues, setQueueInterruptedStates])
```
确保 import：`resumeAgentQueue`（`@/lib/desktop-api/agent` 或相对路径，按现有 `retryQueuedAgentMessage` import 风格）。删除旧注释（"Resume 当前为 dismiss"）。

- [ ] **Step 4: 类型检查 + web 测试无回归**

Run: `cd apps/web && bunx tsc --noEmit && bun test src/components/agent/AgentMessageQueueList.contract.test.tsx src/components/agent/agent-message-queue-summary.test.ts`
Expected: tsc 无错；契约 + summary 测试全过（不回归）。

- [ ] **Step 5: 手动验证（dev）**

启动 dev，构造场景：
- [ ] 提交 2 条消息（A 跑、B 排队）→ STOP → A 中断、B **不自动派发**（队列暂停）+ Resume 横幅
- [ ] 点 Resume → B 派发（跑起来）+ 横幅消失
- [ ] STOP 后刷新页面 → 横幅从 snapshot.paused 恢复（无死锁）→ Resume 可用
- [ ] 正常完成（不 STOP）→ 不暂停（下条正常派发）
- [ ] retryQueued/blocked 仍正常（不回归）

若 dev 无法启动（headless），标 DONE_WITH_CONCERNS 注「手动验证待用户」，自动测试已过则 commit。

- [ ] **Step 6: commit**

```
✨ feat(web): Resume 调 resumeQueue IPC + snapshot.paused 驱动横幅

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Self-Review

**1. Spec coverage**：
- kernel paused + pause/resume/isPaused + startNextQueued 检查 → Task 1 ✅
- AgentMessageQueueSnapshot.paused → Task 2 Step 1 ✅
- RESUME_QUEUE channel + schema → Task 2 Step 2-3 ✅
- stopAgentRuntime(STOP) 调 pauseQueue → Task 3 Step 3（STOP_THREAD handler 调 pauseAgentQueue）✅
- snapshot 构造含 paused → Task 3 Step 1 ✅
- pause/resume 手动 emit（不改 count）→ Task 3 Step 2（pauseAgentQueue/resumeAgentQueue 内 emit）✅
- resumeQueue IPC handler → Task 3 Step 4 ✅
- web desktop-api resumeAgentQueue → Task 4 Step 1 ✅
- snapshot.paused → atom → Task 4 Step 2 ✅
- handleResumeFromInterrupt 调 IPC → Task 4 Step 3 ✅
- 触发仅 STOP → Task 3 Step 3（仅 STOP_THREAD；interrupt 模式提交不动）✅
- 刷新恢复 → Task 4 Step 2（snapshot.paused 权威）✅

**2. Placeholder scan**：所有 step 含实际代码；无 TBD。Task 3 Step 3 的 `context.planModePhaseTracker...` 保留现有逻辑（implementer 读现有 handler，只插 pauseAgentQueue 一行）。✅

**3. Type consistency**：
- `pauseQueue(threadId: string): void` / `resumeQueue(threadId: string): void` / `isPaused(threadId: string): boolean` —— Task 1 定义、Task 3 调用一致 ✅
- `AgentResumeQueueInput { threadId; queueOperationId }` —— Task 2 定义、Task 3 handler validate、Task 4 desktop-api + AgentInput 调用一致 ✅
- `AgentMessageQueueSnapshot.paused?: boolean` —— Task 2 定义、Task 3 填充、Task 4 读取一致 ✅
- `RESUME_QUEUE: 'agent:resume-queue'` —— Task 2 定义、Task 3/4 用 `AGENT_IPC_CHANNELS.RESUME_QUEUE` ✅
- `pauseAgentQueue(threadId)` / `resumeAgentQueue(input): AgentMessageQueueOperationResult` —— Task 3 定义、agent-handlers 调用一致 ✅

## 风险与备注

- **STOP pause 时序**：`STOP_THREAD` handler 内 `stopAgent(threadId)`（含 `stopAgentRuntime` 的 fire-and-forget abort）+ `pauseAgentQueue(threadId)`（同步设 paused）。`pauseAgentQueue` 同步在 abort 完成前设 paused；`processDispatch.finally → startNextQueued` 检查 paused 时已设 → 不派发。若实测发现竞态（startNextQueued 在 pause 前跑），把 `pauseAgentQueue` 移到 `stopAgent` **之前**（handler 内先 pause 再 stop）。
- **`run.cancelled` vs `snapshot.paused` 双源**：Task 4 Step 2 保留 run.cancelled 即时设 + snapshot.paused 权威校正。两者最终一致（snapshot 随后覆盖）。若不一致闪烁，删除 run.cancelled 分支的 setQueueInterrupted(true)（让 snapshot.paused 唯一驱动）。
- **resume 无 CAS**：thread 级状态切换，无 expectedRevision。`resumeAgentQueue` 总返回 `{ok:true, snapshot}`。
- **不回归 retryQueued/blocked**：paused 检查在 startNextQueued 开头（retryQueued 的 scheduleStartNext 也会经此检查——若 paused 时 retry 一个 blocked，resumeQueue 才派发。可接受：paused 期间所有派发暂停）。
- **手动验证**：dev 走查 STOP/Resume/刷新/正常完成/retry（Task 4 Step 5）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-interrupt-soft-interrupt.md`。（实施前基于本地 `worktree-input-queue-ui-parity` 开 worktree；plan/spec 复制进 worktree。）
