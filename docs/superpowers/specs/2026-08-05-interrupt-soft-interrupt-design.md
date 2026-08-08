# interrupt 软中断原语 — 设计（Codex 对齐 follow-up）

> 日期：2026-08-05
> 起点：`origin/worktree-input-queue-ui-parity`（PR7 + UI 对齐 + 附件预览）
> 目标：STOP（用户中断当前 turn）后队列暂停（不自动派发下条）+ Resume 手动恢复派发（对齐 Codex `interrupted` 横幅语义）
> 关联：`docs/superpowers/specs/2026-08-04-input-queue-ui-codex-parity-design.md` §8 follow-up；`docs/superpowers/plans/2026-08-03-input-queue-codex-parity.md`

## 0. TL;DR

kernel 加 per-thread `paused` 状态 + `pauseQueue`/`resumeQueue`；`startNextQueued` 开头检查 paused；`agent-service.stopAgentRuntime`（STOP）调 `pauseQueue`；paused 经 `AgentMessageQueueSnapshot.paused` 暴露（刷新可恢复，防死锁）；新 `resumeQueue` IPC；web `handleResumeFromInterrupt` 改调该 IPC（不再仅 dismiss）。

## 1. 现状

- `processDispatch`（`agent-runtime-kernel.ts:206`）：`try{execute}catch{}finally{ startNextQueued(threadId) }` —— execute 被 abort（STOP）后 finally 仍 `startNextQueued` → **自动派发下一条**。
- kernel **无 cancel/stop/paused 概念**（grep 确认）；STOP 在 `agent-service.stopAgentRuntime` abort `execute`。
- web `run.cancelled` + 队列非空 → `agentQueueInterruptedAtom=true` → Resume 横幅；但 kernel 已派发下条，`handleResumeFromInterrupt` 仅能 dismiss（retry 对 'queued' 首项 conflict）。
- **刷新死锁**：web atom 刷新丢失，若 kernel 暂停则 web 无横幅、无法 resume。

## 2. 设计（方案 A：kernel paused）

### 2.1 kernel（`agent-runtime-kernel.ts`）
- `private readonly paused = new Set<string>()`
- `pauseQueue(threadId)`：`paused.add(threadId)` + `syncQueuedCount`/emit snapshot（paused 改变触发推送）
- `resumeQueue(threadId)`：`paused.delete(threadId)` + `scheduleStartNext(threadId)`（解除暂停并尝试派发）
- `isPaused(threadId)`：暴露给 snapshot 构造
- `startNextQueued` 开头加：`if (this.paused.has(threadId)) return`（暂停时不派发）

### 2.2 agent-service（STOP 触发暂停）
- `stopAgentRuntime(threadId)`（现有，abort execute）：在 abort 前/后调 `kernel.pauseQueue(threadId)`
- 新增 `resumeQueue(threadId)` handler（IPC）：`kernel.resumeQueue(threadId)`

### 2.3 shared types + snapshot 持久化
- `AgentMessageQueueSnapshot` 加 `paused?: boolean`（`packages/shared/src/types/agent.ts`）
- sidecar snapshot 构造含 `paused: kernel.isPaused(threadId)`
- `pauseQueue`/`resumeQueue` 后触发 `MESSAGE_QUEUE_CHANGED` 推送（让 web 收到 paused 变化）

### 2.4 web
- `useGlobalAgentListeners`：snapshot 推送时，`agentQueueInterruptedAtom[threadId] = snapshot.paused ?? false`（从 snapshot 推导，刷新可恢复）—— 保留现有 `run.cancelled` 路径作为即时触发，snapshot 作为权威源
- `handleResumeFromInterrupt`：改调 `resumeQueue` IPC（`AGENT_IPC_CHANNELS.RESUME_QUEUE`）→ 成功后 atom=false（kernel.resumeQueue 已派发，下条会跑）；不再仅 dismiss
- Resume 横幅显示基于 `agentQueueInterruptedAtom`（现已有，UI 不变）

## 3. 触发范围

- **STOP 按钮**（用户中断当前 turn）→ `stopAgentRuntime` → `pauseQueue` + Resume 横幅
- 正常 turn 完成（`run.completed`）→ **不暂停**（finally → startNextQueued 正常派发）
- **interrupt 模式提交**（`followUpQueueMode='interrupt'`，新消息中断当前）→ **本期不动**（PR7 三态路由已有，是单次中断+派发，非队列暂停 Resume 语义；若需对齐另立 follow-up）

## 4. 范围

| 层 | 文件 | 改动 |
|---|---|---|
| kernel | `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts` | +`paused` Set / `pauseQueue`/`resumeQueue`/`isPaused` / `startNextQueued` 检查 |
| sidecar | `apps/sidecar/src/services/agent/agent-service.ts` | `stopAgentRuntime` 调 pauseQueue；+`resumeQueue` handler |
| sidecar | snapshot 构造（agent-service/kernel snapshot 输出） | 含 `paused` |
| IPC | `packages/shared/src`（IPC channels）+ sidecar schema + web desktop-api | +`RESUME_QUEUE` channel |
| shared | `packages/shared/src/types/agent.ts` | `AgentMessageQueueSnapshot.paused?: boolean` |
| web | `apps/web/src/hooks/useGlobalAgentListeners.ts` | snapshot.paused → interrupted atom |
| web | `apps/web/src/components/agent/AgentInput.tsx` | `handleResumeFromInterrupt` 调 resumeQueue IPC |
| web | `apps/web/src/lib/desktop-api/*.ts` | +`resumeQueue` 调用 |
| 测试 | kernel test / agent-service test / contract | pause/resume + startNextQueued 不派发 + IPC |

## 5. 取舍

- **Resume = 恢复队列派发**（非 checkpoint 恢复当前 turn）—— Codex 同款，YAGNI
- **paused 权威源在 kernel**（sidecar），web mirror（atom）从 snapshot 推导 —— 刷新可恢复，防死锁
- **interrupt 模式提交本期不动** —— 是另一路径（PR7 三态），非队列暂停 Resume
- **STOP 是唯一 pause 触发** —— 简单、对齐 Codex interrupted 横幅

## 6. 验收
- STOP → 当前 turn abort + 队列**不派发下条**（paused）+ Resume 横幅
- Resume → 解除 paused + 派发队列首项（下条跑起来）
- 刷新页面 → 横幅从 `snapshot.paused` 恢复（无死锁）
- 正常 turn 完成 → 不暂停（下条正常派发）
- kernel 测试：paused 时 startNextQueued 不派发；resumeQueue 后派发
- agent-service 测试：stopAgentRuntime 设 paused；resumeQueue IPC 解除
- 不回归：retryQueued/blocked/正常队列派发不受影响
