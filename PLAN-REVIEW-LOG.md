# Plan Review Log: 将 Lume 项目绑定为 Agent 的真实工作目录
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Act 2 — Attempt 1 failed before Round 1

- Reviewer model: CLI default (config unpinned)
- CLI: codex-cli 0.142.4
- Sandbox: read-only
- Result: the first review process exceeded the mandatory 600-second ceiling and was terminated.
- No verdict was accepted and no review round was counted as complete.
- Per the skill timeout rule, the run was stopped without an automatic retry.

## Round 1 — Codex

No files modified. Material issues found:

1. Resume reset is incomplete. `run.ts` resumes when a runtime-core transcript exists, independent of `sdkThreadId/runtimeThreadId`, so relocating a project can still resume old cwd context. Fix: delete/rename the runtime-core session dir or add an explicit “do not resume after cwd change” marker.

2. Project skill APIs remain an arbitrary filesystem write surface. `workspace-skill-editor-service.ts` accepts caller-provided `cwd` and writes `.alice/.lume/skills` there. Fix: derive project skill cwd only from the server-side project path resolver, never from RPC input.

3. Removing the Welcome attached-folder UI does not remove the capability. RPC handlers still expose unrestricted attached path list/open/rename/move by absolute path. Fix: remove or hard-gate the attached-directory schemas and handlers, not just the UI sender.

4. Realpath safety is underspecified. Existing file services mostly use lexical `resolve`/prefix checks, which do not stop symlink/junction escapes. Fix: require one shared realpath resolver for existing targets and parent-realpath checks for new writes/moves.

5. Project directory browsing can become direct mutation. Current workspace-root APIs include delete/rename/move/save; mapping those to the real project root bypasses the plan’s “Agent permission system controls writes” rule. Fix: make project panel APIs read/open/search only, or route write actions through the same permission/confirmation path.

6. `fileContextId` deletion semantics are missing. Root and subagents will share a Lume workdir, but trash/empty-trash currently deletes per thread. Fix: add ownership/refcount rules so a shared file context is deleted only when all referencing threads are permanently gone.

7. The plan says “generated artifacts default to Lume workdir,” but core file tools write relative to `agentCwd`. Prompt text will not reliably enforce this. Fix: add explicit artifact/plan output roots in tool/runtime code and test default writes.

8. Path identity needs persisted canonical state. If only the display path is stored, inaccessible directories cannot be compared safely and duplicates can appear after drives remount. Fix: store `projectPath` plus a canonical `realpathKey` captured when accessible, with a documented fallback for inaccessible paths.

9. Auto/default workspace cleanup is incomplete. `workspace-bootstrap-state.ts` still creates a visible default workspace when none exist, and `agent:ensure-default-workspace` remains. Fix: enumerate and change every default-workspace bootstrap path.

10. Prompt/context hard-coded workspace paths remain. `agent-prompt-builder.ts` emits `~/.lume/agent-workspaces/<slug>` strings, which will mislead agents after project cwd changes. Fix: make prompt sections consume `{agentCwd,lumeWorkDir,projectRoot}` from the resolver.

11. Thread creation needs an explicit mode. `parentThreadId` currently means both subagent and fork; the plan names the problem but must require a typed creation API like `fileContextMode: inherit | fork | newRoot`. Fix: update all create/fork/subagent call sites around that mode.

12. Project removal “convert to ordinary sessions” is underdefined. Clearing `workspaceId` makes existing transcript/path helpers fall back to `process.cwd()` or fail workspace resolution. Fix: keep `fileContextId` authoritative for history/files before clearing project association, and verify message/file reads for removed projects.

VERDICT: REVISE

### Claude's response

- Accepted all twelve findings because each maps to a concrete existing code path.
- Added runtime-core transcript/continuation/interruption invalidation, not just thread metadata clearing.
- Removed caller-controlled project skill cwd and unrestricted attached-directory RPC surfaces from the target design.
- Specified shared realpath checks for existing and newly-created targets, and made the project panel read-only except for one narrow legacy export operation.
- Added persisted `projectPath + realpathKey`, explicit `newRoot | inherit | fork` creation modes, and reference-based shared file-context deletion.
- Made `fileContextId` authoritative after project removal and enumerated default-workspace plus hard-coded prompt cleanup.
- Narrowed the “generated outputs go to Lume” guarantee to enforceable system-managed tools; arbitrary shell-relative output remains a project cwd write by design.

## Round 2 — Codex

Prior findings are mostly addressed: resume invalidation, arbitrary `cwd`, attached path RPCs, realpath checks, project-panel writes, `fileContextId` lifecycle, output roots, default workspace creation, hard-coded prompt paths, explicit `fileContextMode`, and removed-project history all now have explicit plan coverage.

Remaining material problems:

1. Workspace/project index writes are still race-prone. Current managers use read-modify-write JSON indexes; two create/relocate calls can pass `realpathKey` uniqueness checks and then overwrite or duplicate each other. Fix: add a serialized workspace-index mutation helper or optimistic reload-and-retry around every project create/relocate/remove write.

2. File-context refcount deletion has the same race. A permanent delete can observe “last reference” and remove a shared Lume workdir while another thread/subagent/fork is being created. Fix: perform thread-index mutation plus final file-context reference check under one shared lock, then recheck immediately before deletion.

3. Project removal does not define Automation/IM account references. Existing automation jobs and IM accounts store `workspaceId`; removing a project can leave scheduled jobs or message bindings pointing at a deleted project. Fix: on project removal, explicitly disable, fail, or convert those records, and surface that behavior in confirmation UI.

4. Relocation/removal still needs an awaited runtime drain. The plan says stop/reject running or waiting tasks, but current `stopAgent` is fire-and-forget in places; changing cwd before abort/dispose finishes can leave writes landing in the old/new root unpredictably. Fix: introduce an awaited `stopAndDrainProjectRuntimes(projectId)` used before relocate/remove/bind.

5. Unbound legacy workspace semantics conflict with “ordinary session.” Old workspaces without `projectPath` are blocked from sending until bound, while removed-project threads become ordinary sessions and can send using `fileContextId`. Fix: either let unbound legacy workspaces be converted to ordinary sessions explicitly, or keep them read-only with a clear migration action.

6. Realpath validation still has a TOCTOU gap for writes/copies. Parent realpath checks prevent simple lexical escapes but not symlink swaps between check and recursive copy/write. Fix: for mutating project-copy operations, lstat each path segment immediately before operation, reject symlink/junction segments, and revalidate the final path after creation.

VERDICT: REVISE

### Claude's response

- Accepted all six findings.
- Added a shared cross-process index mutation lock with hold-time re-read/revalidation for both project and thread indexes.
- Made final file-context reference checking and quarantine rename atomic relative to thread creation/deletion.
- Defined removal behavior: disable project Automations, unbind IM accounts, retain existing IM threads, and surface counts in confirmation.
- Required an awaited project runtime drain before bind/relocate/remove, with no index mutation on timeout.
- Added an explicit “作为普通会话移除项目” escape hatch for unbound legacy workspaces.
- Hardened the only planned project-copy mutation against symlink/junction TOCTOU with per-segment lstat and post-create realpath validation.

## Round 3 — Codex

No files modified. Prior six findings are addressed in the revised plan.

Remaining material issues:

1. Project-local plugins become a new trust boundary. `run.ts` currently loads plugins from `input.cwd/.lume/plugins`; once `cwd` is the real project, binding a repo can auto-load powerful local plugins/hooks, while the plan only discusses project skills. Fix: explicitly disable project-local plugin roots by default or require per-project trust/permission acceptance before loading `.lume/plugins`.

2. IM bindings are preserved even in “delete Lume user data” mode. If project threads are moved to trash while `im-thread-bindings` still point at them, future IM messages can append to trashed/deleted contexts or fail unpredictably. Fix: in delete-data mode clear or disable IM thread bindings that reference affected project threads; preserve bindings only for keep-history conversion.

3. Lazy legacy file-context migration lacks concurrency control. Two sidecar/CLI processes can trigger the same old-thread-dir migration and race on copy/delete/version marker despite index locking. Fix: add a per-`fileContextId` migration lock plus idempotent marker, and only delete old source after a locked, verified migration.

4. Automation references must include thread-bound jobs, not only `workspaceId`. Existing automation jobs may reference a `threadId` whose thread belongs to the removed project even if the job has no `workspaceId`. Fix: compute project references by both `job.workspaceId` and `job.threadId -> thread.workspaceId`, then disable all affected jobs.

VERDICT: REVISE

### Claude's response

- Accepted all four findings.
- Disabled automatic discovery/execution of real-project `.lume/plugins`; only already-managed user/internal project plugins remain in scope.
- Split IM binding behavior by removal mode: preserve for keep-history conversion, clear/disable for delete-data mode.
- Added per-file-context migration locks and idempotent completion markers before legacy source deletion.
- Expanded Automation reference detection to include jobs indirectly bound through a project thread.

## Round 4 — Codex

Prior findings are largely addressed: project-local plugins are no longer auto-trusted, migration concurrency is locked, and Automation `threadId` coverage is now explicitly in validation.

Remaining material issue:

- `PLAN.md` still preserves existing IM `thread binding`s during project removal, including the “delete Lume data” path where project threads are moved to trash and later deleted. That can route future IM messages into trashed threads, or leave dangling bindings after empty-trash cleanup. Fix: in delete-data mode, disable or clear IM thread bindings for affected threads immediately; preserve bindings only in keep-history mode after threads are converted to ordinary sessions, and add a test for incoming IM after trash/permanent delete.

VERDICT: REVISE

### Claude's response

- Partially rejected the claim that delete-data mode still preserved bindings: Round 3 already required clearing/disabling them before trashing threads.
- Accepted that the compound wording and verification list were not explicit enough.
- Split keep-history and delete-data binding behavior into mutually exclusive hard rules, made binding-cleanup failure abort deletion, and added incoming-IM checks after trash and permanent deletion.

## Round 5 — Codex

Prior IM binding finding is addressed: delete-data mode now requires clearing/disabling bindings before trashing affected threads, and the validation matrix covers post-removal inbound IM.

New remaining issue:

- `PLAN.md:23` sends “delete Lume user data” threads to the existing trash while immediately removing project metadata, but the plan does not define restore semantics. Existing trash supports restore, so a restored thread could either keep a dangling `workspaceId` to a deleted project or restore without the project-level metadata it previously depended on. Fix: specify that delete-data mode clears `workspaceId` before trashing and restore returns an ordinary archived session, or mark those trash entries non-restorable; add a restore-before-empty-trash test.

VERDICT: REVISE

### Claude's response

- Accepted the finding as valid.
- Recommended clearing `workspaceId` before trashing and restoring such entries as ordinary archived sessions with the same `fileContextId`; this preserves the existing reversible trash contract without resurrecting deleted project metadata.
- No further plan revision was made because Round 5 reached `MAX_ROUNDS`; the user must explicitly break the tie and approve or reject this final amendment.

## Resolution — User decision

The user approved Claude's final amendment after Round 5:

- Delete-data mode clears each affected thread's `workspaceId` before moving it to trash.
- Restoring before empty-trash returns an ordinary archived session with the same `fileContextId`.
- Deleted project metadata is not recreated during restore.

The plan is user-approved after the bounded review deadlock. No additional Codex review round was run because `MAX_ROUNDS=5` had been reached.
