# Plan Review Log: 重设计 Lume Task 工具
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Round 1 — Codex

1. Runtime wiring is underspecified: Lume currently exposes no `TaskCreate/List/Update/Get`; `run.ts` only assembles `TaskReport`, Agent, delegation, and Todo tools, while SDK task tools remain separate.
   Fix: Add a sidecar task-tool factory bound to `sessionDir`, `taskListId`, caller identity, and runtime event emission.
2. Removing the SDK global task map breaks Bash background jobs: `bash.ts` still calls `createTaskRecord`, stop handlers, and `TaskOutput`, and `Agent.stopTask()` reads that map.
   Fix: Keep a separately named ephemeral process-job registry or migrate Bash background execution before deleting the existing map.
3. The claim-before-spawn lifecycle races because Agent/Delegate are concurrency-safe.
   Fix: Make dispatch serial or require a separate claim turn / atomic claim protocol before Agent calls.
4. Parallel subagents can corrupt shared workspace changes; the writer lease is not whole-task file ownership.
   Fix: Require disjoint file reservations/worktrees or serialize overlapping declared paths.
5. Owner authorization is not enforceable if owner is a caller-supplied string.
   Fix: Derive/validate owner identities server-side and persist a run-bound claim token or lease with stale-claim recovery.
6. Separate JSON writes for blocks/blockedBy are not crash-atomic.
   Fix: Use a write-ahead transaction journal/recovery protocol or one canonical graph file.
7. Lock protocol needs exclusive creation, timeout, stale recovery and fixed order.
   Fix: Specify the lease/recovery protocol and lock order.
8. New tool names need exact permission metadata and centralized subagent deny-listing.
   Fix: Register all four tools and remove them from every subagent tool assembly.
9. `task_ref` is not integrated with current Agent/Delegate and existing coordinator task IDs.
   Fix: Add a distinct correlation field and define it as informational, not TaskReport/coordinator state.
10. Completion hooks must run before the completed snapshot is committed.
    Fix: Add a blocking TaskUpdate pre-commit validator.
11. Per-task snapshots alone cannot provide audit replay.
    Fix: Add an append-only event/revision log and update replay/UI projections.
12. Old TaskContract/TaskRun is still live in orchestrator, RPC, approval, replay and UI.
    Fix: Cut it over behind an explicit compatibility boundary.
13. Existing UI controls continue to invoke execute/approval operations.
    Fix: Replace them with read-only Task snapshots or explicitly narrow UI scope.
14. State transition and owner-clearing invariants are underspecified.
    Fix: Specify and enforce them atomically.
15. Model-writable `_lume` metadata can forge/erase server audit data.
    Fix: Reserve server-managed fields and record provenance.
16. taskListId path containment is unspecified.
    Fix: Validate path segments and containment.

Remaining risks are material because the plan did not previously define safe persistence transactions, authoritative ownership, runtime wiring, or legacy lifecycle cutover.

### Claude's response

The core product decisions stand: Claude Code-style Task items, one per-thread Task list, Task and Subagent as separate capabilities, and no automatic subagent creation. The plan was revised to:

- explicitly wire Task tools into the sidecar main-agent runtime;
- preserve a separately named SDK process-job registry for Bash background jobs;
- require a claim-before-dispatch turn and server-owned claim leases;
- add path/resource safety for parallel work and avoid treating the per-call writer lease as whole-task isolation;
- add lock recovery, transaction journal, path containment and append-only Task revisions;
- define `task_ref` as a separate informational correlation field;
- make completion validation pre-commit and reserve server-managed metadata;
- include the complete legacy TaskContract/TaskRun runtime, RPC, replay and UI cutover.

Rejected: replacing the per-task JSON design with one canonical graph file. The user explicitly chose Claude Code's per-task JSON layout; a journal is added to preserve that choice while addressing crash consistency.

## Round 2 — Codex

Round 2 acknowledged that explicit wiring, WAL recovery, ownership leases, conservative parallelism, legacy-chain removal, and read-only UI were addressed on paper, but identified these remaining material issues:

1. New subagent identity is created inside `SubagentCoordinator` after the Task claim; preallocate/validate identity or use an atomic bridge.
2. Claim tokens lacked a usable compare-and-swap path; late results from expired attempts could update a reclaimed Task.
3. No defined stop operation existed for returning `in_progress` to `pending`.
4. TaskList must stay observational; stale recovery must not mutate during reads.
5. WAL coverage was incomplete for ordinary snapshots, event log and highwatermark updates.
6. Event plumbing needed one authoritative TaskStore mutation path for live notifications and replay.
7. Subagent deny-list needed to include legacy TaskStop/TaskOutput and all raw SDK assemblies.
8. Current SDK/Delegate do not implement worktree isolation.
9. Model-declared expected files are hints, not authoritative resource locks.
10. `task_ref` needed a canonical scoped schema and separation from coordinator `task_id`.
11. Main-agent TaskReport still targets TaskRun and must be removed separately from coordinator-bound TaskReport.
12. Metadata merge semantics needed explicit depth, array, size and reserved-field rules.

### Claude's response

Accepted and revised:

- Added `TaskStop`, explicit claim-token/revision fencing, verified executor cancellation, and startup-only stale recovery.
- Made all state, event and highwatermark mutations share one idempotent `TaskStore.mutate()` WAL path.
- Defined structured scoped `task_ref`, preallocation/atomic binding for new subagent identities, and a complete deny set for subagent tool assembly.
- Removed worktree parallelism from the first implementation promise; shared-workspace writes are serialized and parallelism is limited to read-only tasks.
- Separated the main-agent TaskRun report removal from the standalone coordinator-bound subagent report.
- Kept Claude Code's shallow metadata merge model, with size limits and immutable server-managed `_lume` fields.

Rejected: making model-declared `expectedFiles` an authoritative write lock. The current runtime cannot prove that a model's declaration matches its actual read-modify-write behavior, so the plan now treats it as hints only and conservatively serializes writes.

## Round 3 — Codex

Round 3 found these remaining material issues:

- `TaskStop` needed an internal fenced `cancelling` phase; reclaim must wait for verified executor termination.
- Agent and Delegate use different registries, so cancellation needed one durable executor-control adapter keyed by claim token.
- Task-linked Agent calls currently enter `SubagentCoordinator` and its `FinishAgentTask` blockers; they need a direct task-aware executor path, while standalone Agent keeps the legacy path.
- Read-only-only parallelism must be enforced by the server, not by model declarations.
- The complete deny set must cover static, dynamic and required subagent tools.
- Legacy SDK `TaskStop/TaskOutput` schemas conflict with the unique Task toolchain and must become model-invisible process-job controls.
- Task events need a task-list sequence envelope with system/recovery origin rather than run-scoped IDs.
- Lock timeout alone cannot safely recover live writers; heartbeat and fencing are required.
- Child identity reservation needs compensating cleanup when claim binding or launch fails.

### Claude's response

Accepted and revised:

- Added internal `cancelling`, verified cancellation acknowledgement, and a unified executor-control adapter for Agent and Delegate.
- Defined task-linked direct executor routing that bypasses standalone coordinator acceptance; retained old coordinator semantics only for Agent calls without `task_ref`.
- Made read-only parallelism a server-enforced executor property and made writes serial in the shared worktree.
- Extended subagent filtering to static, dynamic and required tools, with only bound standalone TaskReport exempted.
- Renamed the legacy process-job controls conceptually to `ProcessStop/ProcessOutput` and moved them behind a model-invisible ProcessJobRegistry.
- Changed event identity to `(taskListId, sequence)` with explicit system/recovery origin, and strengthened locks with heartbeat/fencing.
- Added side-effect-free child identity reservation with compensating release.

## Round 4 — Codex

Round 4 found five remaining material issues:

- Main-agent-only mutation was still described mainly as tool assembly; runtime dynamic contexts did not guarantee a main-thread actor, and nested SDK paths could bypass the boundary.
- `task_ref.taskListId` needed an explicit equality check against the parent main thread's derived Task list to prevent cross-thread references.
- Waiting for executor termination before TaskStop released a claim made Task state depend on the Subagent lifecycle, contradicting the intended separation.
- Static `isConcurrencySafe` on Agent/Delegate could not enforce read-only-only parallelism for task-linked calls because read/write status is runtime-specific.
- The Agent schema needed a discriminated task_ref variant that rejects legacy coordinator fields when using the new Task association.

### Claude's response

Accepted and revised:

- Made `TaskStore.mutate()` require and validate the main-thread actor/context and the derived `taskListId`, so authorization is enforced below tool assembly; all static, dynamic and required subagent assemblies retain the centralized deny set.
- Required task-aware Agent/Delegate bridges to reject any `task_ref.taskListId` that is not exactly the parent main thread's derived list.
- Decoupled TaskStop from executor termination: TaskStop fences and releases the Task claim immediately, returns the public state to pending, and records a cancellation request; executor-control cancellation and acknowledgement are separate and cannot block reclaim.
- Required a per-call server-side concurrency decision based on verified executor read-only metadata; task-linked calls default to serialized when that proof is unavailable.
- Defined Agent/Delegate task_ref input as a discriminated union and rejected `task_id`, `new_task`, and other legacy coordinator fields in that variant.

## Round 5 — Codex (MAX_ROUNDS reached)

Most prior findings were addressed, but Codex found three material consistency gaps:

- The plan said the execution fence blocks new claims until termination acknowledgement, while another claim rule said acknowledgement does not block reclaim; the fence must be authoritative for write-capable claims.
- The execution fence had no bounded cancellation deadline, crash recovery, or force-release protocol; a lost acknowledgement could permanently stall the single active Task list.
- Multiple Agent/Delegate calls could reuse one `task_ref` and claim token; a single `executorRef` field did not atomically enforce one active executor per claim.

### Resolution required from user

The recommended resolution is to make the following amendments before implementation, but the review hard cap prevents another Codex pass:

- TaskStop immediately returns the public Task to `pending`, but its internal execution fence is authoritative: no new Task claim or task-linked write-capable dispatch is accepted until the old executor reaches a terminal state. Read-only work does not bypass the single-active-Task rule.
- Store a cancellation deadline and recovery state. Before release, trusted recovery must ask the executor-control adapter to confirm or force termination; only a verified terminal/forced-termination result may release the fence. If termination cannot be proven, keep the fence and surface recovery failure rather than allowing unsafe workspace reuse.
- Add an atomic per-claim executor binding `{ claimToken, attempt, executorRef, state }`; a task-linked dispatch succeeds only when the binding is empty/terminal and CAS binds the new executor. Duplicate dispatches with the same token are rejected, and terminal acknowledgement clears the binding.

These amendments are not Codex re-reviewed because `MAX_ROUNDS=5` was reached. No code was modified.

## Act 3 — Build

### Round 1 — implementation worker

The accepted plan was implemented in the current clean worktree without creating a commit from the worker. The implementation added the host-bound five-tool Task API, file-backed TaskStore, scoped event replay, main-agent wiring, task_ref Agent/Delegate association, subagent Task deny-set enforcement, ProcessJobRegistry separation, read-only Task progress UI, and removal of the legacy TaskContractWrite registration from runtime plan mode.

The worker reported `bun run typecheck` passing and identified two stale main-runtime tests that still expected TaskReport. Those assertions were updated to expect the five Task tools and to keep TaskReport only on the bound standalone subagent path.

### Claude's verdict

Reviewed the complete diff, corrected the stale tests, added TaskStore coverage, added pending Task deletion through TaskUpdate, preserved server-managed metadata on metadata null patches, enforced trusted system/recovery executor acknowledgements, added TaskStop executor cancellation callbacks, moved child-thread creation after claim binding, added executor stop fencing, and filtered Task/process tools from nested SDK AgentTool assembly.

Proof:

- `bun run typecheck` — passed for shared, ui, sidecar, cli, web, and desktop.
- Focused Bun tests — 98 passed, 0 failed across TaskStore, runtime-core, delegation, tool runtime/metadata, Task progress UI, and Bash process-job compatibility.
- `git diff --check` — passed.

Remaining deviations/risks:

- Legacy TaskContract/TaskRun storage and orchestration files remain for compatibility; the new runtime no longer registers TaskContractWrite for plan mode and the new TaskStore does not read old data.
- TaskStore lock heartbeat is refreshed around short synchronous transactions rather than by an independent lease-renewal worker.
- Executor recovery requires a verified terminal/forced acknowledgement; the fence intentionally remains when termination cannot be proven.
- Legacy TaskProgressPanel helper predicates remain exported for compatibility even though user-facing continue/retry/skip controls were removed.
