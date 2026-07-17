# Plan Review Log: 消息中的文件路径用户体验优化
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Act 1 — Locked decisions

- Canonical references: `` `@project/<relative-path>` `` and `` `@session/<relative-path>` ``; text/source anchors use `#Lx` or `#Lx-Ly`, and directories end in `/`.
- Agent contract: main Agent, subagents, and plan Markdown use inline code; explicit Markdown links are accepted only as compatibility input.
- Rendering: hide the protocol prefix, use extension/category icons, show short paths fully, compact long paths to their last two segments, separate the line badge, and expose full source/path in the tooltip.
- Interaction: click opens the right preview; line references scroll and highlight; directories reveal and expand in Files; system application opening stays in the context menu.
- Validation: no eager filesystem I/O while rendering/streaming; validate on click through the authorized sidecar FileRef path and mark failures explicitly without guessing alternatives.
- Coverage: support dotfiles, extensionless files, and directories; preserve the current narrow legacy session-path heuristic for historical messages.
- Copy: persisted messages retain the protocol, normal copy removes the internal prefix but preserves the full path/line anchor, and the context menu adds an explicit protocol-reference copy action.
- Scope: only Agent narrative, subagent narrative, and plan Markdown; no user/tool/web raw-content parsing, no external roots, no editor deep links, and no new binary preview engines.
- Visuals: extend the existing shared `FileTypeIcon` with category/format icons; no new dependency or full brand-icon pack.
- Cross-platform wording: use “在文件管理器中显示” instead of Finder-specific copy.

## Round 1 — Codex

Material issues remain:

1. **Historical references can silently retarget.** The plan’s claim that rebinding will fail is false: `@project/src/a.ts` is reconstructed from the current `workspaceSlug`, so the same path in a newly bound project opens the wrong file. Fix: persist immutable scope/binding metadata or a binding epoch with each generated message and disable references after mismatch.

2. **Directory navigation has no completion channel.** A one-shot `pendingRevealRef` cannot return success/failure to the awaiting reference component because the right-panel action/state flow is synchronous. Fix: model reveal as `{requestId, ref}` plus an explicit completion callback/promise registry, with cleanup on unmount or binding change.

3. **Concurrent clicks can resolve out of order.** Two `STAT_FILE_REF` calls can make an older click activate after a newer one, and multiple reveals can overwrite one `pendingRevealRef`. Fix: add a monotonically increasing navigation revision and make stale completions non-activating or latest-wins.

4. **Error normalization will misreport operational failures.** Collapsing every error into “missing” or “unauthorized” will label IPC outages, schema failures, and I/O errors incorrectly; sidecar currently throws unstructured message strings. Fix: return structured error codes such as `NOT_FOUND`, `OUT_OF_SCOPE`, `UNAVAILABLE`, and `IO_ERROR`, and only mark references invalid for definitive failures.

5. **The clipboard design contradicts repository policy.** Reusing `SmoothText` currently writes through `event.clipboardData.setData`, while the project requires renderer clipboard writes to use `writeClipboardText`. Fix: normalize the cloned selection, prevent the native copy, and pass the result through `writeClipboardText` with failure feedback.

6. **The protocol grammar is ambiguous.** A valid filename ending in `#L42` is indistinguishable from a line anchor, while Markdown destinations with spaces, `%`, or `#` require encoding that the plan never defines. Fix: specify canonical segment encoding and decode exactly once, or explicitly reserve anchor-shaped suffixes and test both inline-code and Markdown-link forms.

7. **Directory menus expose file-only operations.** The plan keeps “另存为” for directory references, but the existing action ultimately calls `copyFile`, which is file-oriented. Fix: build menu capabilities from the `STAT_FILE_REF` result and hide or replace file-only actions for directories.

8. **Anchor removal semantics are unspecified.** Opening an already-tabbed file without a line range after an anchored open may retain stale highlighting because existing-tab navigation only activates the tab. Fix: define an unanchored open to clear `lineSelection` and bump `navigationRevision`, and test that transition.

9. **Protocol failures are unobservable.** Malformed model references remain ordinary code and definitive validation failures only produce local UI state, so prompt compliance cannot be assessed. Fix: add redacted structured diagnostics/counters for parser rejection categories and navigation error codes without logging file contents or absolute paths.

Changed files: none. Simplifications made: none; review was read-only. Remaining risks are the findings above.

VERDICT: REVISE

### Codex's response

Accepted and revised:

- New assistant messages carry a root fingerprint/file-context binding snapshot, so historical project references disable on rebind instead of silently retargeting.
- Directory reveal now has a request ID, explicit Promise completion, lifecycle cleanup, and latest-wins navigation revisions.
- Validation returns structured outcomes; only definitive missing/scope/binding failures mark a link invalid, while transient failures remain retryable.
- Selection copy is routed through `writeClipboardText`, including failure feedback, and no longer relies on ClipboardEvent writes.
- The grammar now defines strict single percent-decoding and escaping for anchor-shaped filenames and Markdown destinations.
- Directory menus hide file-only save-as behavior, and unanchored opens explicitly clear previous line highlighting.

Rejected:

- Runtime parser-rejection counters were not added. This task has no telemetry requirement, the product currently has no consumer for such counters, and logging even redacted local-reference activity expands privacy scope. Prompt compliance is instead covered by contract tests; definitive navigation failures remain visible and retryable in the UI.

## Round 2 — Codex

Most prior findings are now addressed: structured errors, latest-wins navigation, reveal completion, clipboard policy, encoding, directory menus, and stale line-selection clearing are covered. Three material gaps remain:

1. **Binding validation is not end-to-end.** After validation, previews and context-menu actions still use ordinary `READ_FILE_REF`/`RESOLVE_FILE_REF`; rebinding can therefore retarget an open tab or right-click action after validation. Fix: require the binding fingerprint or a sidecar-issued capability token on every project-file operation, not only initial validation.

2. **Forked threads would retain mutable access to the source thread’s session files.** Forking creates a new `fileContextId` but copies message metadata unchanged, so snapshot-backed `@session` references continue targeting the original context. Fix: clone the relevant file context and rewrite copied binding snapshots during fork, or deliberately invalidate inherited session references.

3. **Binding snapshots exist only for persisted assistant messages.** Streaming replies, sub-Agent output, and plan previews can render before that message exists, leaving the stated surfaces without the immutable binding needed for safe clicks. Fix: capture the binding at run start and propagate it through stream/runtime events and every Markdown rendering surface, then persist that same snapshot with the final message.

One smaller ambiguity should also be resolved: strict protocol references define `/` as the only separator while tests still call for Windows-separator normalization. Fix: reject raw `\` and decoded `%5C` in strict references, retaining backslash normalization only for legacy references.

Excluding runtime telemetry is an explicit, acceptable tradeoff here and no longer blocks implementation.

Changed files: none. Tests were not run.

VERDICT: REVISE

### Codex's response

Accepted and revised:

- Binding guards now travel through every message-derived FileRef operation, including reads, preview scopes, resolve/open/reveal and save-as, and are rechecked at the moment sidecar resolves the target.
- Forks deliberately invalidate inherited `@session` references when their copied binding snapshot does not match the new file context; project references survive only when the root fingerprint still matches.
- The immutable binding is captured at run start, propagated through streaming/runtime views and plan previews, then persisted unchanged with the final assistant message.
- Strict references reject raw or decoded backslashes; Windows normalization remains legacy-only.

## Round 3 — Codex

The prior fork UX, streaming propagation, and raw-backslash rules are substantially addressed. End-to-end binding enforcement still has material gaps:

1. **Optional guards fail open.** The same IPC accepts guarded message references and unguarded file-tree references, so dropping the guard anywhere silently bypasses rebinding protection. Fix: introduce a distinct `GuardedFileRef`/message-reference endpoint where the guard is mandatory, and test missing-guard rejection.

2. **The right-panel tab schema does not explicitly retain the guard.** Tabs currently store only `FileRef`; unless the plan requires storing the binding guard alongside it, later preview, refresh, and context-menu operations cannot revalidate. Fix: make guarded identity part of each message-opened tab and propagate it through every preview/action call.

3. **Preview scopes remain valid after rebinding.** `create_file_preview_scope` resolves once into an absolute-root capability valid for up to five minutes; subsequent `lume-file` requests do not revisit sidecar, while current workspace reconciliation does not track project fingerprints. Fix: store the fingerprint on preview scopes and revoke them when it changes, or revalidate the binding on every preview request.

4. **Session guards lack the identity needed for sidecar enforcement.** Comparing `expectedFileContextId` with the `FileRef` itself cannot prove it equals the current fork’s context unless the guard also carries `threadId`. Fix: define session guards as `{ threadId, expectedFileContextId }` and compare against current thread metadata before every operation.

5. **“run/attempt start” is ambiguous across retries.** Recomputing per attempt could mix bindings within one logical streamed response. Fix: capture once at logical-run creation and pass the identical snapshot into every retry/attempt and sub-Agent.

6. **Decoded forward separators remain unspecified.** `%2F` can introduce `/` inside a decoded segment despite `/` being the sole pre-decode separator. Fix: explicitly reject decoded `/`, `\`, NUL, and dot segments, with `%2F`, `%5C`, and double-encoding tests.

Changed files: none. Tests were not run.

VERDICT: REVISE

### Codex's response

Accepted and revised:

- Message references now use a distinct mandatory `GuardedFileRef` type and dedicated endpoints; ordinary FileRef APIs cannot accept or silently drop the guard.
- Message-opened right-panel tabs retain the guarded target through preview, refresh and every context action.
- Guarded preview scopes revalidate and resolve through sidecar on every protocol request instead of treating the initial absolute path as a five-minute capability.
- Project/session guards include the consuming thread identity and are compared with current thread metadata on every operation, which also enforces fork isolation.
- The binding snapshot is captured once per logical run and reused for retries, attempts, subagents, streaming and persistence.
- Strict decoding rejects decoded separators/control/dot segments and ambiguous double encoding, with dedicated contract tests.

## Round 4 — Codex

All six acceptance gates are now sufficiently specified:

- Guarded message endpoints are mandatory and isolated from plain `FileRef` endpoints.
- Tabs retain the complete `GuardedFileRef`.
- Guarded preview scopes revalidate every request.
- Sidecar verifies `consumerThreadId`, workspace/root, and file context.
- Binding is captured once per logical run and propagated through retries, streaming, sub-Agents, previews, and persistence.
- Decoding is single-pass, rejects decoded separators and double encoding, while legacy normalization remains separate.

Fork isolation, navigation races, structured errors, clipboard handling, directory actions, and line-navigation semantics also remain covered. I found no material implementation blocker or contradiction.

Changed files: none. Tests were not run.

VERDICT: APPROVED
