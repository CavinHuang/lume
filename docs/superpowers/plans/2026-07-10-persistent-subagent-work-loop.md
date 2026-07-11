# Persistent Subagent Work Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace detached one-shot delegation with persistent, reusable Subagent Sessions, reviewable Tasks, and awaited Runs.

**Architecture:** Persist the collaboration model in a versioned sidecar store and put all lifecycle, FIFO, concurrency, cancellation, and completion-policy logic in a `SubagentCoordinator`. The `Agent` tool becomes an awaited coordinator call; child threads remain the sole owner of their runtime events, while parent cards read their linked child run. The SDK supplies a small completion guard so a parent cannot finish while it still owns tasks awaiting review.

**Tech Stack:** TypeScript, Bun tests, Jotai, existing Lume runtime-event/replay stores; no new dependencies.

## Global Constraints

- Maximum Subagent depth is exactly `1`.
- Different Sessions may run concurrently; a single Session runs FIFO, with a default global concurrency limit of `4`.
- A Run terminal state is not Task acceptance; only `FinishAgentTask` can resolve a Task.
- Child-thread RuntimeEvents are the only content source; parent threads persist links only.
- Runtime resources are released after each Run; Session/task/run records and child history remain persisted.
- Old `run_in_background` input is accepted only for compatibility and has no detached behavior.
- Do not add dependencies or overwrite unrelated working-tree changes.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/types/agent.ts` | Public Session/Task/Run/Report contracts and RPC payloads. |
| `apps/sidecar/src/services/agent/subagents/subagent-work-store.ts` | Versioned atomic store and v1 registry migration. |
| `apps/sidecar/src/services/agent/subagents/subagent-coordinator.ts` | Lifecycle transitions, FIFO, global limit, cancellation and completion blockers. |
| `apps/sidecar/src/services/agent/subagents/subagent-task-report-tool.ts` | Run-bound TaskReport tool. |
| `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` | Tool assembly and child-runtime bridge only. |
| `packages/sdk/src/{types.ts,agent.ts,engine.ts,tools/agent-tool.ts}` | Awaited nested Agent behavior and parent completion guard. |
| `apps/sidecar/src/rpc/{schemas.ts,agent-handlers.ts}` | State/query/control RPC endpoints. |
| `apps/web/src/components/agent/{SubagentInlinePanel.tsx,subagent-run-projection.ts}` | Linked child-run rendering without exposing reasoning. |
| `apps/web/src/components/app-shell/{lume-sidebar-view-model.ts,ThreadItem.tsx}` | Stable Session identity and task/session status in the sidebar. |

### Task 1: Public work-loop contracts

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Test: `packages/shared/src/types/agent.test.ts`

**Produces:** `SubagentSession`, `SubagentTask`, `SubagentTaskFeedback`, `SubagentRun`, `SubagentTaskReport`, `SubagentRunLink`, `AgentToolResult`, `AgentListSubagentWorkResult`.

- [ ] Add the explicit status types and records; retain `SubagentRunRecord` as a deprecated v1 migration input only.

```ts
export type SubagentSessionStatus = 'idle' | 'busy' | 'retired'
export type SubagentTaskStatus = 'open' | 'running' | 'awaiting_review' | 'accepted' | 'deferred' | 'cancelled'
export type SubagentRunStatus = 'queued' | 'running' | 'completed' | 'errored' | 'cancelled' | 'timed_out'

export interface SubagentTaskReport {
  status: 'submitted' | 'failed' | 'blocked'
  summary: string
  completedWork?: string[]
  remainingWork?: string[]
  artifacts?: Array<{ path: string; description?: string }>
  verification?: Array<{ command?: string; result: string; passed: boolean }>
  blockers?: string[]
}

export interface SubagentRunLink {
  parentThreadId: string; parentRunId: string; parentToolUseId: string
  subagentId: string; childThreadId: string; taskId: string; runId: string
}
```

- [ ] Add schemas/inputs for `Agent({ subagent_id?, task_id?, acceptance_criteria?, expected_artifacts? })`, `FinishAgentTask`, and `RetireSubagent`; make new `Agent` results structured instead of a text-only completion string.
- [ ] Add contract tests that assert accepted is absent from run statuses and that a report is distinct from a Task resolution.
- [ ] Run: `bun test packages/shared/src/types/agent.test.ts`
- [ ] Commit: `git add packages/shared/src/types/agent.ts packages/shared/src/types/agent.test.ts && git commit -m "feat(shared): add persistent subagent work contracts"`

### Task 2: Versioned persistence and migration

**Files:**
- Create: `apps/sidecar/src/services/agent/subagents/subagent-work-store.ts`
- Create: `apps/sidecar/src/services/agent/subagents/subagent-work-store.test.ts`
- Modify: `apps/sidecar/src/services/agent/subagents/subagent-run.types.ts`

**Consumes:** Task 1 records.
**Produces:** `SubagentWorkStore` with atomic read/write and `SUBAGENT_WORK_STORE_VERSION = 2`.

- [ ] Write failing tests for fresh save/load, atomic write failure preservation, v1 migration, and restart repair.

```ts
expect(store.load()).toMatchObject({ version: 2, sessions: [], tasks: [], runs: [] })
expect(store.load().tasks[0]).toMatchObject({ status: 'accepted', attemptCount: 1 })
expect(store.load().runs[0]).toMatchObject({ status: 'errored' })
```

- [ ] Implement a single store payload containing `sessions`, `tasks`, `feedback`, and `runs`; map legacy `childThreadId` to one Session and one attempt-1 Task/Run, map completed legacy records to accepted tasks, and convert nonterminal records after process restart to errored runs plus awaiting-review tasks. Parse to a temporary in-memory payload first and only replace the file after successful normalization.

```ts
function repairActiveRun(run: SubagentRun, now: number): SubagentRun {
  return TERMINAL_RUN_STATUSES.has(run.status) ? run : {
    ...run, status: 'errored', endedAt: now, updatedAt: now,
    error: run.error ?? 'Sidecar 进程重启，之前的进程内 subagent 已退出。',
  }
}
```

- [ ] Run: `bun test apps/sidecar/src/services/agent/subagents/subagent-work-store.test.ts`
- [ ] Commit: `git add apps/sidecar/src/services/agent/subagents && git commit -m "feat(sidecar): persist subagent sessions tasks and runs"`

### Task 3: Coordinator scheduling and state transitions

**Files:**
- Create: `apps/sidecar/src/services/agent/subagents/subagent-coordinator.ts`
- Create: `apps/sidecar/src/services/agent/subagents/subagent-coordinator.test.ts`

**Consumes:** Task 2 store.
**Produces:** `getSubagentCoordinator()`, `runAgentTask()`, `submitReport()`, `finishTask()`, `retireSession()`, `cancelByParentThread()`, `getCompletionBlocker()`.

- [ ] Write failing tests for parallel distinct sessions, FIFO same session, max-four scheduling, one-run failure isolation, report-less error, task transitions, three-attempt guard, retirement validation, and cancellation.

```ts
const [first, second] = await Promise.all([
  coordinator.runAgentTask(newRun({ subagentId: 'developer-01' })),
  coordinator.runAgentTask(newRun({ subagentId: 'reviewer-01' })),
])
expect(maxActive).toBe(2)
expect([first.runId, second.runId]).toEqual(['run-1', 'run-2'])
```

- [ ] Implement a semaphore plus per-session promise tails. Persist queued before enqueue, move to running only after a global permit, persist the Task as awaiting_review and Session as idle only after the runtime executor, report submission, transcript flush, and cleanup all settle.

```ts
const prior = this.sessionTails.get(session.subagentId) ?? Promise.resolve()
const scheduled = prior.catch(() => undefined).then(() => this.withPermit(() => this.execute(runId)))
this.sessionTails.set(session.subagentId, scheduled.finally(() => {
  if (this.sessionTails.get(session.subagentId) === scheduled) this.sessionTails.delete(session.subagentId)
}))
return scheduled
```

- [ ] Enforce legal transitions: only main-agent controls can resolve Tasks; retirement requires idle; same-task continuation increments attempt; a changed `subagent_id` records reassignment; repeated identical reports mark the Task stalled and demand changed feedback or reassignment.
- [ ] Run: `bun test apps/sidecar/src/services/agent/subagents/subagent-coordinator.test.ts`
- [ ] Commit: `git add apps/sidecar/src/services/agent/subagents/subagent-coordinator* && git commit -m "feat(sidecar): coordinate persistent subagent work"`

### Task 4: Run-bound report and child task context

**Files:**
- Create: `apps/sidecar/src/services/agent/subagents/subagent-task-report-tool.ts`
- Create: `apps/sidecar/src/services/agent/subagents/subagent-task-report-tool.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/types.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

**Consumes:** Coordinator report submission.
**Produces:** A child-only `TaskReport` whose IDs are bound by runtime state.

- [ ] Write tests proving caller-provided task/run IDs cannot redirect a report and missing report makes the run fail.
- [ ] Add `subagentId`, `subagentTaskId`, `subagentAttempt`, and `parentRunId` to the runtime descriptor. Build the report tool with these values captured, accepting only report fields.

```ts
inputSchema: {
  type: 'object',
  properties: { status: { type: 'string', enum: ['submitted', 'failed', 'blocked'] }, summary: { type: 'string' } },
  required: ['status', 'summary'],
}
```

- [ ] Append the fixed task contract, previous report, and feedback to the subagent prompt. Remove Agent/Delegate/WaitForDelegations from child tool availability so depth remains one.
- [ ] Run: `bun test apps/sidecar/src/services/agent/subagents/subagent-task-report-tool.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`
- [ ] Commit: `git add apps/sidecar/src/services/agent/subagents apps/sidecar/src/services/agent-runtime && git commit -m "feat(sidecar): bind subagent reports to persistent tasks"`

### Task 5: Awaited SDK Agent calls and completion guard

**Files:**
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/engine.ts`
- Modify: `packages/sdk/src/tools/agent-tool.ts`
- Modify: `packages/sdk/src/tools/agent-tool.parallel.test.ts`
- Modify: `packages/sdk/src/engine.test.ts`

**Produces:** `completionGuard?: () => Promise<string | undefined>` and an AgentTool that never detaches work.

- [ ] Replace the failing background tests with assertions that `run_in_background` is ignored and the returned promise settles only after `onSubagentEnd`.
- [ ] Remove `void runSubagent()` and the `isolation === 'remote'` branch; preserve compatibility input parsing but omit both fields from the tool schema/prompt.
- [ ] Add the guard immediately before natural completion. A nonempty guard result becomes an internal user message and continues the loop, so the model must call continue/finish/defer/cancel before a final response.

```ts
if (toolUseBlocks.length === 0) {
  const feedback = await this.config.completionGuard?.()
  if (feedback) {
    this.messages.push({ role: 'user', content: feedback })
    continue
  }
  completedNaturally = true
  break
}
```

- [ ] Preserve original tool-call result ordering by collecting indexed results and returning `toolUseBlocks.map(...)` after concurrent and serial execution.
- [ ] Run: `bun test packages/sdk/src/tools/agent-tool.parallel.test.ts packages/sdk/src/engine.test.ts`
- [ ] Commit: `git add packages/sdk/src && git commit -m "feat(sdk): await subagents and guard parent completion"`

### Task 6: Replace sidecar delegation with coordinator tools

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`

**Consumes:** Tasks 3-5.
**Produces:** `Agent`, `FinishAgentTask`, and `RetireSubagent` tools backed by the coordinator.

- [ ] Write runtime tests for new Session/Task/Run, same-task continuation, session reuse/new task, reassignment, parent abort cascade, and run result shape.
- [ ] Replace `buildSidecarSubagentRunContext`, direct registry writes, foreground timeout wrapper, Delegate, and WaitForDelegations with a narrow adapter that creates/reuses child threads and calls `coordinator.runAgentTask`.

```ts
return coordinator.runAgentTask({
  parentThreadId: input.sessionId, parentRunId: input.runId!, parentToolUseId: context.toolUseId!,
  prompt, description, subagentType, subagentId, taskId, acceptanceCriteria, expectedArtifacts,
  execute: (binding) => runSidecarSubagent({ ...binding, onRuntimeEvent: input.emitRuntimeEvent }),
})
```

- [ ] Update `stopAgent` and `stopAllAgents` to call coordinator cancellation first, abort active child runtimes, mark queued/running Runs cancelled, and retain all completed reports.
- [ ] Run: `bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent/agent-service.test.ts`
- [ ] Commit: `git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent/agent-service.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts && git commit -m "feat(sidecar): route agent tools through subagent coordinator"`

### Task 7: Child events as the sole content source

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/replay/runtime-event-history.ts`
- Test: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts`

- [ ] Pass the observed runtime-event emitter into nested child runs and publish those events under `childThreadId`; remove `annotateSubagentStreamingEvent` forwarding to the parent.
- [ ] Stamp live and replayed events with an increasing `sequence` per `runId`, assigning replay sequence after stable item ordering.
- [ ] Verify that parent persistence contains tool call plus `SubagentRunLink`, while child history holds assistant/tool events and never exposes thinking through the parent projection.
- [ ] Run: `bun test apps/sidecar/src/services/agent-runtime/runner/lume-runner.test.ts apps/sidecar/src/services/agent-runtime/replay/runtime-event-history.test.ts`
- [ ] Commit: `git add apps/sidecar/src/services/agent-runtime && git commit -m "feat(sidecar): make child threads subagent event source"`

### Task 8: RPC, notifications, and recovery query

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/index.ts`
- Test: `apps/sidecar/src/rpc/agent-handlers.run-events.test.ts`

- [ ] Replace list-runs RPC with `LIST_SUBAGENT_WORK`, filtering by parent thread and returning Sessions, Tasks, Runs, and links; add validated Finish/Retire command handlers.
- [ ] Emit a `SUBAGENT_WORK_CHANGED` notification after every persisted transition. Do not emit or maintain the old one-shot completion channel.
- [ ] Test refresh/restart read paths and invalid resolution/retirement rejection.
- [ ] Run: `bun test apps/sidecar/src/rpc/agent-handlers.run-events.test.ts`
- [ ] Commit: `git add packages/shared/src/types/agent.ts apps/sidecar/src/rpc apps/sidecar/src/index.ts && git commit -m "feat(sidecar): expose persistent subagent work state"`

### Task 9: Linked parent card and task history

**Files:**
- Create: `apps/web/src/components/agent/subagent-run-projection.ts`
- Create: `apps/web/src/components/agent/subagent-run-projection.test.ts`
- Modify: `apps/web/src/atoms/agent-atoms.ts`
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.tsx`
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`

- [ ] Replace the runs-only atom with parent-thread work snapshots and refresh it on `SUBAGENT_WORK_CHANGED`.
- [ ] Project a card from exactly one `SubagentRunLink`, its task/session records, and `agentRuntimeEventsFamily(childThreadId)` filtered by `runId`; keep thinking blocks hidden.

```ts
export function projectSubagentRun(events: LumeRuntimeEvent[], runId: string): SubagentRunView {
  return events.filter((event) => event.runId === runId && event.type !== 'assistant.thinking_delta')
}
```

- [ ] Render queued/running/awaiting-review/accepted/failed state, attempt, newest public text or tool activity, tool count, elapsed time, report sections, and an open-child-thread button. Group all attempts of the same Task in the expanded card while retaining each tool-call position in the parent timeline.
- [ ] Run: `bun test apps/web/src/components/agent/subagent-run-projection.test.ts apps/web/src/components/agent/SubagentInlinePanel.test.tsx`
- [ ] Commit: `git add apps/web/src/atoms apps/web/src/hooks/useGlobalAgentListeners.ts apps/web/src/components/agent && git commit -m "feat(web): render linked persistent subagent runs"`

### Task 10: Sidebar identities and legacy cleanup

**Files:**
- Modify: `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`
- Modify: `apps/web/src/components/app-shell/ThreadItem.tsx`
- Modify: `apps/sidecar/src/services/agent/subagents/subagent-run-registry.ts`
- Delete: `apps/sidecar/src/services/agent/subagents/subagent-run.types.ts`
- Test: `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`

- [ ] Use the persistent Session title (`developer-02 · task summary`) without replacing it with output. Derive sidebar status from busy Session, awaiting-review newest Task, idle reusable Session, or retired Session; child threads remain openable after retirement.
- [ ] Remove registry semaphores, old completion announce service wiring, Delegate/WaitForDelegations prompt guidance, old run IPC/atoms, and parent-side child-event discard logic. Preserve rendering of historical Delegate/Wait tool calls as ordinary archived tool results.
- [ ] Run: `rg -n "WaitForDelegations|delegateTool|run_in_background|SUBAGENT_COMPLETED|createDelegationCompletion" apps packages`
- [ ] Expected: only migration/compatibility parsing and historical rendering references remain.
- [ ] Commit: `git add apps/web/src/components/app-shell apps/sidecar/src/services/agent/subagents apps/sidecar/src/services/agent-runtime packages && git commit -m "refactor: remove detached subagent delegation"`

### Task 11: End-to-end acceptance and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-persistent-subagent-work-loop-design.md`
- Create: `apps/sidecar/src/services/agent/subagents/subagent-work-loop.integration.test.ts`
- Create: `apps/web/src/components/agent/subagent-work-loop.integration.test.tsx`

- [ ] Write an integration test that starts two independent Agent calls, observes overlap and two child event streams, waits for both reports, continues one task by `task_id`, accepts both tasks, reuses a Session, retires it, reloads persisted state, and confirms no active runs remain after parent stop.
- [ ] Run the focused test suites plus `bun run typecheck` (or the repository’s documented equivalent from `package.json`).
- [ ] Update the design document status to implemented only after every focused acceptance test passes.
- [ ] Commit: `git add docs/superpowers/specs apps/sidecar/src/services/agent/subagents apps/web/src/components/agent && git commit -m "test: cover persistent subagent work loop"`

## Self-review

- Spec coverage: Tasks 1-4 cover three-level modeling, reports, migration, reuse, task loop, and depth; Tasks 5-6 cover awaited parallel execution, barriers, cancellation, and tool changes; Tasks 7-10 cover source-of-truth events, recovery, cards, sidebar, and deletion; Task 11 covers all acceptance scenarios.
- Interface consistency: `subagentId`, `taskId`, `runId`, `childThreadId`, `parentRunId`, and `parentToolUseId` are introduced in Task 1 and carried unchanged through all later tasks.
- Legacy boundary: compatibility parsing is isolated to migration and ignored-input parsing; no new execution path can detach a Run.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-10-persistent-subagent-work-loop.md`. Implementation proceeds task by task in this session, with focused tests after each independently reviewable change.
