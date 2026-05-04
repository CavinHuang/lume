# Plan Contract + Task Progress Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign agent planning so Plan Mode only produces an approval contract, approval automatically switches to execution with `acceptEdits`, and the UI shows task progress instead of a plan execution state.

**Architecture:** Split the current overloaded plan model into `PlanContract` for pre-execution approval and `TaskRun` for post-approval progress. Keep one durable execution state for task progress, remove legacy `PlanStep`/`PlanStateTracker.steps`/`plan_execution_status`, and project both the side panel and message list from the same `TaskRun` state/events.

**Tech Stack:** TypeScript, Bun tests, existing sidecar file stores, existing IPC/RPC channels, React/Jotai web UI, no new dependencies.

---

## Product Contract

Plan Mode is not an execution mode. It is a planning-only mode:

- User asks to plan first.
- Agent can only create a plan contract: goal, summary, tasks, risks, expected changes, approval request.
- Agent must not execute edits, commands, or side-effecting tools while permission mode is `plan`.
- User clicks `批准并执行`.
- System automatically exits Plan Mode, switches execution permission mode to `acceptEdits`, creates a task run from the approved contract, and starts execution.
- Right side panel shows task progress, not plan content.
- Message list shows structured task progress blocks.

Execution remains framework-driven:

- Controller dispatches only the current task.
- Agent reports the current task through a structured report tool.
- The controller rejects attempts to report a different task.
- If a run ends without a task report, the current task fails.
- Risky tools and explicit questions still pause through the existing permission / AskUser flows.

## Cleanup Principles

- Prefer deletion over compatibility bridges.
- Do not keep two task status models.
- Do not preserve `plan_execution_status` as a parallel text stream.
- Keep old exported IPC names only where needed to avoid a large renderer bridge migration; internally rename concepts to contract/task.
- Do not introduce a full task editor in this pass.

## Target File Structure

### Sidecar Plan/Task Runtime

- Create: `apps/sidecar/src/services/agent-runtime/plan/plan-contract-types.ts`
  - Defines `PlanContract`, `PlanContractTask`, contract status, approval metadata.
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-run-types.ts`
  - Defines `TaskRun`, `TaskRunTask`, `TaskRunEvent`, task statuses.
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-run-store.ts`
  - File-backed durable store for task runs.
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-run-controller.ts`
  - Starts, continues, retries, skips, and finalizes task runs.
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-report-tool.ts`
  - Structured tool for reporting only the current task result.
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-progress-events.ts`
  - Projects task run events into `LumeRunEvent` task progress events.

### Sidecar Files To Shrink Or Delete

- Modify: `apps/sidecar/src/services/agent-runtime/plan/plan-write-tool.ts`
  - Reframe as contract creation.
  - Keep tool name temporarily if prompt/tool registration churn is too large, but output must be a `PlanContract`.
- Modify: `apps/sidecar/src/services/agent-runtime/plan/plan-approval-service.ts`
  - Approving a contract creates a `TaskRun`.
- Delete or reduce to compatibility shim: `apps/sidecar/src/services/agent-runtime/plan/plan-execution-service.ts`
  - Remove full-plan hidden prompt builders and legacy mark functions.
- Delete: `apps/sidecar/src/services/agent/plan-state-tracker.ts`
  - Or first remove all step tracking and then delete once consumers are gone.
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
  - Approval calls task run controller with `acceptEdits`.
  - `EXECUTE_PLAN` becomes a thin compatibility wrapper around task run intents.
  - Remove `plan_execution_status` emission.
  - `GET_THREAD_RUN_EVENTS` hydrates from task run events.
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
  - Register `TaskReport`.
- Modify: `apps/sidecar/src/services/pi-agent/tools/permissions/tool-metadata.ts`
  - Register `TaskReport` as low-risk control tool.

### Shared Types

- Modify: `packages/shared/src/types/agent.ts`
  - Add `AgentPlanContract`, `AgentTaskRun`, `AgentTaskRunTask`, `AgentTaskRunEvent`.
  - Add `LumeRunEvent` variant `task_progress`.
  - Remove legacy `PlanStep` and `PlanStateChangedEvent.steps` after renderer consumers are migrated.
  - Keep `AgentExecutePlanInput` temporarily if IPC channel names remain, but change semantics to task-run intents.

### Web UI

- Rename or replace: `apps/web/src/components/agent/PlanPanel.tsx`
  - Target component: `TaskProgressPanel`.
  - Before approval: show approval card from plan contract.
  - After approval: show task progress from `AgentTaskRun`.
  - No dependency on `agentPlanStateAtom.steps`.
- Modify: `apps/web/src/components/agent/run-event-message-projection.ts`
  - Render `task_progress`, remove `plan_execution_status`.
- Modify: `apps/web/src/components/agent/RunEventContentBlock.tsx`
  - Add compact task progress block.
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`
  - Treat task progress as the execution progress signal.
- Modify desktop API wrappers under `apps/web/src/lib/desktop-api/agent.ts`
  - Expose task run/list APIs or map existing plan APIs to new types during migration.

---

## Chunk 1: Define The New Contracts

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plan/plan-contract-types.ts`
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-run-types.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Test: `apps/sidecar/src/services/agent-runtime/task-run/task-run-types.test.ts`

- [ ] **Step 1: Add failing type/fixture tests**

Create fixtures that describe:

- A draft plan contract with tasks and expected changes.
- An approved plan contract.
- A task run created from that contract.
- A task run event sequence.

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/task-run/task-run-types.test.ts
```

Expected: fails because the new modules do not exist.

- [ ] **Step 2: Add minimal types**

Implement only the fields required by the product contract:

```ts
export type PlanContractStatus = "draft" | "needs_approval" | "approved" | "rejected";

export interface PlanContractTask {
  id: string;
  title: string;
  description?: string;
  expectedFiles?: string[];
  expectedTools?: string[];
}

export interface PlanContract {
  id: string;
  threadId: string;
  runId: string;
  goal: string;
  summary: string;
  tasks: PlanContractTask[];
  risks: Array<{ id: string; description: string; severity?: "low" | "medium" | "high" }>;
  expectedChanges: {
    files?: string[];
    commands?: string[];
    tools?: string[];
    memoryWrites?: string[];
  };
  status: PlanContractStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}
```

```ts
export type TaskRunStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskRunTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";
```

- [ ] **Step 3: Run type fixture test**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/task-run/task-run-types.test.ts
```

Expected: pass.

## Chunk 2: Create TaskRun Store And Controller

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-run-store.ts`
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-run-controller.ts`
- Test: `apps/sidecar/src/services/agent-runtime/task-run/task-run-controller.test.ts`

- [ ] **Step 1: Write failing controller tests**

Cover:

- Approval creates a task run with all tasks pending.
- Start dispatch chooses the first pending task and marks it running.
- Completed task advances to the next pending task.
- Run completion without report marks current task failed.
- Retry only works on failed current task.
- Skip only works on failed or pending current task.
- Waiting for permission/user updates the task run status and current task reason.

- [ ] **Step 2: Implement store**

Use the existing file-backed plan store pattern. Keep this focused:

- `get(id)`
- `upsert(taskRun)`
- `listByThread(threadId)`

- [ ] **Step 3: Implement controller**

Implement pure controller operations first:

- `createTaskRunFromContract(contract)`
- `startNextTaskRunTask(input)`
- `reportCurrentTask(input)`
- `markCurrentTaskUnreported(input)`
- `markTaskRunWaiting(input)`
- `skipCurrentTask(input)`

The controller should not know React, IPC, or message list details.

- [ ] **Step 4: Run focused controller tests**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/task-run/task-run-controller.test.ts
```

Expected: pass.

## Chunk 3: Replace Agent Execution Tooling

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/task-run/task-report-tool.ts`
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/permissions/tool-metadata.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/permissions/tool-metadata.test.ts`

- [ ] **Step 1: Write failing TaskReport tests**

The tool must reject:

- Wrong task run id.
- Wrong task id.
- Reporting a task that is not running.
- Duplicate completion.

The tool must accept:

- `completed` with result.
- `failed` with error.
- `blocked` with reason.

- [ ] **Step 2: Implement TaskReport**

Use existing tool creation patterns. Tool input:

```ts
{
  taskRunId: string;
  taskId: string;
  status: "completed" | "failed" | "blocked";
  result?: string;
  error?: string;
}
```

- [ ] **Step 3: Register TaskReport**

Register as a low-risk control tool. Keep `PlanStepUpdate` only until RPC execution is migrated, then delete it in Chunk 6.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/task-run/task-report-tool.test.ts apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts apps/sidecar/src/services/pi-agent/tools/permissions/tool-metadata.test.ts
```

Expected: pass.

## Chunk 4: Migrate Approval And Execution RPC

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.run-events.test.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.pending-interactive.test.ts`

- [ ] **Step 1: Write failing RPC tests**

Cover:

- `SUBMIT_PLAN_APPROVAL` with `execute=true` approves contract, creates task run, switches permission mode to `acceptEdits`, and dispatches only current task.
- Hidden message contains current task id and requires `TaskReport`.
- `EXECUTE_PLAN` compatibility path maps to task run continue/retry/skip.
- AskUser/tool permission during task execution updates task run waiting state.
- Run completion without `TaskReport` marks the task failed.

- [ ] **Step 2: Migrate approval path**

Approval should:

1. Resolve contract.
2. Mark contract approved.
3. Create or load task run.
4. Start first task with `acceptEdits`.

- [ ] **Step 3: Migrate execution continuation path**

Continue/retry/skip should operate on task runs, not plan execution state.

- [ ] **Step 4: Remove text progress emission**

Delete `emitPlanExecutionStatusMessage` and `buildPlanExecutionStartedText`.

- [ ] **Step 5: Run focused RPC tests**

Run:

```bash
bun test apps/sidecar/src/rpc/agent-handlers.run-events.test.ts apps/sidecar/src/rpc/agent-handlers.pending-interactive.test.ts
```

Expected: pass.

## Chunk 5: Web UI Becomes Task Progress

**Files:**
- Rename or replace: `apps/web/src/components/agent/PlanPanel.tsx`
- Modify: `apps/web/src/components/agent/AgentView.tsx`
- Modify: `apps/web/src/components/agent/run-event-message-projection.ts`
- Modify: `apps/web/src/components/agent/RunEventContentBlock.tsx`
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/web/src/lib/desktop-api/agent.ts`
- Test: `apps/web/src/components/agent/PlanPanel.test.ts`
- Test: `apps/web/src/components/agent/run-event-message-projection.test.ts`

- [ ] **Step 1: Write failing UI projection tests**

Cover:

- `task_progress` creates a structured progress block in the message list.
- Refresh/hydration preserves task progress blocks.
- Legacy `plan_execution_status` is no longer needed by the projection tests.

- [ ] **Step 2: Replace side panel mental model**

The right panel should show:

- Before approval: `待批准任务`.
- After approval: `任务进度`.
- Progress count.
- Current task.
- Completed/failed/skipped statuses.
- Retry/skip/continue only where legal.

- [ ] **Step 3: Remove legacy step dependency**

Remove side panel refresh/render dependency on `PlanStateChangedEvent.steps`.

- [ ] **Step 4: Run focused web tests**

Run:

```bash
bun test apps/web/src/components/agent/run-event-message-projection.test.ts apps/web/src/components/agent/PlanPanel.test.ts
```

Expected: pass.

## Chunk 6: Delete Legacy Bridges

**Files:**
- Delete: `apps/sidecar/src/services/agent/plan-state-tracker.ts`
- Delete or reduce: `apps/sidecar/src/services/agent/plan-state-tracker.test.ts`
- Delete or reduce: `apps/sidecar/src/services/agent-runtime/plan/plan-execution-service.ts`
- Delete or reduce: `apps/sidecar/src/services/agent-runtime/plan/plan-execution-service.test.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify any imports found by `rg`.

- [ ] **Step 1: Search for legacy references**

Run:

```bash
rg "PlanStateTracker|PlanStep|plan_execution_status|planExecutionMode|PlanStepUpdate|buildPlanExecutionSendInput|markStructuredPlanExecution" apps packages
```

Expected: only references intentionally queued for deletion remain.

- [ ] **Step 2: Delete unused legacy modules**

Remove modules once imports are gone. Do not keep no-op shims unless a public IPC boundary still requires them.

- [ ] **Step 3: Remove shared legacy types**

Remove:

- `PlanStep`
- `PlanStepStatus`
- `PlanStateChangedEvent.steps`
- `plan_execution_status`

Keep `PlanPhase` only if UI still needs a high-level planning/review indicator.

- [ ] **Step 4: Run focused typechecks**

Run:

```bash
bun run --filter @lume/sidecar typecheck
bun run --filter @lume/web typecheck
```

Expected: both exit 0.

## Chunk 7: Final Verification

**Files:**
- No new implementation files unless tests expose a missed reference.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/task-run apps/sidecar/src/rpc/agent-handlers.run-events.test.ts apps/sidecar/src/rpc/agent-handlers.pending-interactive.test.ts
```

Expected: pass.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
bun test apps/web/src/components/agent/run-event-message-projection.test.ts apps/web/src/components/agent/PlanPanel.test.ts
```

Expected: pass.

- [ ] **Step 3: Manual UX smoke**

Use a local app run if available:

- Start in Plan Mode.
- Ask for a plan.
- Verify no execution starts before approval.
- Click `批准并执行`.
- Verify permission mode switches to `acceptEdits`.
- Verify first task starts automatically.
- Verify right panel title is task progress.
- Verify message list shows task progress block.

## Non-Goals

- No full task editor.
- No dynamic task insertion without an explicit approval flow.
- No new dependency.
- No full repo lint/test sweep unless focused verification exposes shared breakage.

## Remaining Risks

- Existing dirty worktree contains unrelated changes. Implementers must avoid reverting or formatting unrelated files.
- IPC naming may remain `EXECUTE_PLAN` for one migration step even though semantics become task-run execution.
- A data migration may be needed if users already have `LumePlan` files with embedded execution state; first pass can tolerate old files read-only or map them to contracts.
