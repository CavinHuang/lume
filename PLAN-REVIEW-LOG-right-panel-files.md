# Plan Review Log: 重设计当前会话右侧文件面板与文件树
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

- PLAN_FILE=`PLAN-right-panel-files.md`
- LOG_FILE=`PLAN-REVIEW-LOG-right-panel-files.md`
- 使用独立文件名以保留仓库中上一项已完成工作的 `PLAN.md` 与 `PLAN-REVIEW-LOG.md`。

## Act 2 — Attempt 1 failed before Round 1

- Reviewer model: CLI default (config unpinned)
- CLI: codex-cli 0.144.4
- Sandbox: read-only
- Result: the first review process exceeded the mandatory 600-second ceiling and was terminated.
- No `thread.started` record or verdict was returned, so no review round was counted as complete.
- Per the skill timeout rule, the run stopped without an automatic retry.

## Act 2 — Attempt 2 failed before Round 1

- Reviewer model: CLI default (config unpinned)
- CLI: codex-cli 0.144.4
- Sandbox: read-only
- Reviewer thread: `019f652a-5b4f-7b33-a57d-20589d023552`
- Result: the explicitly authorized retry exceeded the mandatory 600-second ceiling after extensive read-only repository inspection and was terminated.
- No final verdict file was produced, so no review round was counted as complete.
- Per the skill timeout rule, the run stopped without an automatic resume.

## Round 1 — Codex

1. The active-tab model cannot represent concrete file tabs after the independently closable “文件” function Tab is removed; persisted `activeTab` only accepts function types, creating two conflicting active-tab states.  
Fix: Use one discriminated runtime active-tab model (`function | file`) and update it atomically with persisted function presence.

2. `canonicalPath` is undefined across incompatible contracts: directory listings return absolute paths, search returns relative paths, and Windows casing/separators can create duplicate tabs or incorrect mutation rewrites.  
Fix: Standardize all APIs on an opaque `{source, scopeId, relativePath}` file reference normalized server-side.

3. Existing session and legacy path resolvers enforce only lexical containment; read/open/stat operations can follow a symlink or junction outside the authorized root.  
Fix: Reject symlinks/junctions and realpath-check targets and ancestors for every list, read, open, preview, and mutation RPC.

4. Exact search totals require complete traversal, while frontend stale-result guards do not cancel superseded sidecar scans; rapid typing can accumulate unbounded scans of large projects.  
Fix: Add debounce, server-side cancellation, bounded concurrency and scan budgets, returning `truncated` instead of promising exact totals when capped.

5. The application CSP currently excludes `lume-file:` from `frame-src`, so the planned HTML iframe will be blocked.  
Fix: Add the preview scheme narrowly to `frame-src` and extend the CSP regression test.

6. The injected navigation bridge is bypassable through `location`, meta refresh, or forged `postMessage`; `event.source` and the token do not prove a user-initiated link click.  
Fix: Enforce subframe navigation in Electron, treat messages as untrusted input, and require confirmation or rate limiting for external opens.

7. Mapping a preview token to the whole project root allows executable HTML to read and exfiltrate arbitrary project files once relative JSON/fetch is supported; the plan understates this as leakage of preview content.  
Fix: Serve only the entry file and an explicit resource allowlist, or add a clear per-workspace trust gate acknowledging disclosure of the entire root.

8. Token expiry/revocation lacks cache and ownership controls, so cached responses, cross-window reuse, or late scope-creation responses may survive closure.  
Fix: Bind tokens to the requesting `webContents`, send `Cache-Control: no-store`, and immediately revoke scopes returned after cleanup.

9. Memory browsing is incomplete and freshness assumptions are wrong: snapshots expose only recent daily/run files, and global memory is not covered by the recursive workspace watcher.  
Fix: Add paginated memory-source listing and a memory-specific change event covering global and workspace roots.

10. Persisting tree width inside the closable Files Tab conflicts with the requirement that the preference survive closing and reopening that Tab.  
Fix: Store tree width in a dedicated persistent layout-preferences atom independent of Tab presence.

11. Whole-file base64 image reads are unbounded, allowing a large file with an image extension to block the sidecar and exhaust renderer memory.  
Fix: Enforce a server-side size limit and use bounded streaming rather than base64 for image previews.

12. Rename/move/delete cache rewrites have no serialization or cache-generation check, so concurrent actions or external changes can apply successful responses to obsolete state.  
Fix: Serialize mutations per source and reload affected parents whenever the response generation no longer matches the cache.

13. Reusing current Windows “system open” behavior is unsafe because it invokes `cmd /c start` with filesystem-controlled names containing command metacharacters.  
Fix: Route opening and revealing through trusted Electron `shell.openPath` and `showItemInFolder` IPC.

14. Resolver unit tests and iframe-attribute assertions do not verify real Electron CSP loading, subframe navigation, caching, or protocol lifecycle.  
Fix: Add an Electron integration test using a hostile HTML fixture through the actual preview protocol.

VERDICT: REVISE

### Codex primary response

- Accepted all fourteen findings as material and grounded in current code.
- Replaced the split active state with one discriminated runtime active item updated atomically with persisted function presence.
- Replaced mixed absolute/relative paths with server-normalized opaque `FileRef` values and extended realpath/symlink checks to every source operation used by the new tree.
- Added debounced, cancelable, budgeted searches with `truncated` rather than exact totals under caps.
- Added the missing CSP directive and a real hostile Electron protocol test.
- Hardened HTML scopes: bind tokens to webContents, no-store, late-result cleanup, directory-limited static asset allowlist, Electron subframe navigation enforcement, untrusted message validation, remote-open confirmation and rate limiting.
- Added complete paginated memory-source enumeration plus global/workspace memory change events.
- Moved tree width to an independent persistent preference atom, changed images to bounded protocol streaming, and serialized file mutations with cache generations.
- Removed reliance on sidecar `cmd /c start` by routing authorized `FileRef` actions through Electron shell APIs and planning deletion of the unsafe RPC path after call-site migration.

## Round 2 — Codex

Most prior findings are addressed, but these material gaps remain:

1. `protocol.handle` receives a standard `Request` without `webContentsId`, so the protocol handler cannot perform the planned owner check directly; Electron exposes requester identity through `session.webRequest` instead.  
Fix: Specify a filtered `session.webRequest.onBeforeRequest` ownership gate, deny requests without the expected `webContentsId`, and avoid clobbering other WebRequest listeners.

2. The Windows command-injection cleanup remains incomplete: `MEMORY_IPC_CHANNELS.OPEN_SOURCE` still reaches `cmd /c start` through Memory Settings, and another copy exists in `system-handlers.ts`; Step 8 only enumerates agent file channels.  
Fix: Inventory and migrate every `cmd /c start` call, including memory and system handlers, before deleting the helpers.

3. The `FileRef` migration does not cover existing producers: attachments and runtime events still emit string `threadPath`/`sourcePath`, including absolute memory paths, while `AgentMessages`, `RuntimeEventContentBlock`, and relevant shared memory types are absent from the change list.  
Fix: Enumerate all deep-link producers and add a server-authorized legacy-descriptor-to-`FileRef` conversion instead of constructing refs from renderer-supplied absolute paths.

4. Runtime workspace cleanup and rebinding are still unspecified; deleting a thread leaks its cached state, while moving a thread to another workspace leaves project, memory, and legacy tabs authorized against the old `scopeId`.  
Fix: Delete runtime state on thread removal and close/reconcile non-session tabs and preview scopes whenever the thread’s workspace binding changes.

5. Image preview says it uses the controlled protocol, but the protocol design only defines directory-scoped HTML tokens; no single-file image scope, MIME policy, range behavior, or race-safe enforcement of the 50 MB limit is specified.  
Fix: Define a separate single-file media scope with explicit MIME/`nosniff`, bounded streaming, range handling, and size enforcement during the stream rather than only via initial `Content-Length`.

6. Sandboxing gives the HTML document an opaque origin, so local module scripts and JSON `fetch` will require an explicit CORS response policy; merely allowing `.mjs` and `.json` extensions does not make them load.  
Fix: Define and test token-route CORS headers for opaque-origin requests, without credentials, and keep them limited to the already-authorized preview scope.

7. Standalone web execution remains undefined: `RightPanelHtmlPreview` depends on Electron invokes and the custom protocol, so browser-hosted Lume will fail instead of showing a stable preview state.  
Fix: Gate rendered HTML and protocol-backed images on `isDesktopRuntime`, with source-only or unsupported fallback behavior plus a browser-runtime test.

VERDICT: REVISE

### Codex primary response

- Accepted all seven findings.
- Moved requester ownership enforcement from `protocol.handle` to a centralized, route-filtered `session.webRequest.onBeforeRequest` gate and kept path/content validation in the protocol handler.
- Expanded unsafe Windows opener cleanup to every current `cmd /c start` copy: agent files, memory source open, and system handlers.
- Enumerated attachment, runtime-event, image-result and memory-citation deep-link producers; new records carry `FileRef`, while old records use a server-authorized descriptor conversion that rejects renderer absolute paths.
- Added thread deletion and workspace/file-context rebinding reconciliation for runtime caches, tabs and preview scopes.
- Split HTML directory scopes from single-file media scopes and specified MIME, nosniff, range, file-descriptor size checks and streaming byte limits.
- Added credential-free CORS for opaque-origin module/JSON requests only after token ownership, path and allowlist authorization.
- Added explicit non-Electron fallback: HTML source-only, protocol-backed image unsupported, and no desktop bridge exception.

## Round 3 — Codex

All seven prior material findings are now addressed: ownership gating, complete `FileRef` migration, thread lifecycle cleanup, media scopes, opaque-origin CORS, browser fallback, and removal of every `cmd /c start` path.

The revised plan also adds appropriate integration tests and explicitly accepts the remaining HTML network/DoS risks. I found no new material blocker.

VERDICT: APPROVED

## Resolution

- Act 1 decisions were locked with the user.
- Act 2 converged after 3 completed Codex review rounds.
- Final status: APPROVED.
- No product code was modified; implementation still requires the user's explicit final sign-off.

## Act 3 — Build

### Round 1 — Codex build

- Build thread: `019f657d-db82-7cf2-ba5e-0c1ceb58176e`.
- Implemented the locked design in the isolated worktree `codex/right-panel-files-redesign`.
- Replaced the old 572-line combined Files panel with a compact mixed Tab bar, shared four-source tree workspace, FileRef preview pipeline, desktop preview scopes, memory enumeration, and focused security/state tests.
- The initial Codex proof report was advisory only; the primary reviewer read the full diff independently.

### Primary review verdict — REVISE

The first implementation had material edge cases despite its green report:

- legacy attachment conversion could traverse an in-root symlink/junction before returning a ref;
- FileRef rename/move did not reject the session scope root or descendant moves;
- tree-local caches and pending loads could cross a workspace/file-context rebind;
- stale-source refresh reread only the root while retaining stale expanded children;
- missing/deleted preview behavior was inconsistent across text/image/HTML;
- independently closing Files could be undone by a later file open, and hard-coded fallback could activate a closed Files function;
- the all-tabs close button could also activate the item it had just closed;
- legacy deep-link conversions could reject with unhandled promises.

### Round 2 — Codex fix

- The same Codex thread applied regression fixes and tests for the issues above.
- The CLI process exited `1` before replacing its final report, but the patch was present in the isolated worktree.
- Independent focused verification after the patch passed: Web `64/64`, Sidecar `34/34`, with `git diff --check` clean.

### Primary review verdict — REVISE

- A remaining roving-focus gap prevented a keyboard-only user from entering the tree reliably.
- File Tab icons used the disambiguated label instead of the actual path, which could break extension detection.

### Round 3 — Codex final fix

- The same thread fixed the initial tree tab stop, focused rows after mouse selection, used real file paths for icons, and simplified deterministic fallback lookup.
- Focused Web proof passed `65/65`; Web typecheck and the no-`cmd.exe` assertion passed.

### Primary takeover

- Final review found one collapsed-selection edge case: a selected child hidden by collapsing its parent could retain the only tab stop.
- After the two delegated fix rounds were exhausted, the primary reviewer changed the tab-stop helper to choose the selected row only when it is visible, otherwise the first visible row, and added a regression assertion.

### Final independent proof

- Web focused suite: `64 pass, 0 fail, 153 assertions`.
- Sidecar focused suite: `34 pass, 0 fail, 93 assertions`.
- Desktop security suite: `43 pass, 0 fail`.
- CSP regression: `2 pass, 0 fail`.
- Real Electron hostile HTML fixture: `13 assertions passed`.
- Shared, sidecar, web, and desktop typechecks: all exit `0`.
- Exact `rg` for `spawnDetached("cmd", ["/c", "start"`: no output, exit `1` as expected.
- `git diff --check`: exit `0`.
- No dependencies, staging, commit, push, or history mutation.

### Remaining compatibility and manual risk

- General legacy Agent/workspace/settings OPEN/SHOW channels remain for existing callers outside the redesigned right panel. They no longer use `cmd.exe`; Windows uses direct `explorer.exe` spawning with `shell:false`. New right-panel operations use authorized `FileRef` desktop invokes.
- The interactive desktop UX checklist was not performed in this non-interactive build run. Automated coverage includes the real Electron hostile protocol fixture, but visual density, resize feel, context menus, and keyboard traversal still benefit from a human desktop pass before merge.
- The accepted HTML residual risk remains: auto-executed network-enabled HTML can exfiltrate data from its allowed preview directory and consume renderer CPU/memory despite the opaque-origin sandbox and scoped protocol.

### Build resolution

- Feature implementation was committed as `af500f47` and merged into the main worktree branch `codex/electron-final-cutover` as `6dc76c30`.
- Post-merge focused tests, the real Electron fixture, four affected-package typechecks, and `git diff --check` all passed.
- The isolated feature worktree and its merged branch were removed; the main worktree's pre-existing `AGENTS.md` and `README.md` edits were preserved byte-for-byte.
