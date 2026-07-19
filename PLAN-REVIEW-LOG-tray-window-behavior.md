# Plan Review Log: 重新设计托盘与 Lume 窗口行为
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

Plan file: `PLAN-tray-window-behavior.md`

## Round 1 — Codex

1. macOS 交互冲突：Electron 在 `Tray.setContextMenu()` 后会于鼠标按下时弹出菜单，“托盘单击只显示窗口”无法按计划统一实现。修复：明确平台语义，macOS 单击打开菜单，或取消持久 context menu 并通过独立事件调用 `popUpContextMenu()`。

2. `ensureMainWindow` 的“幂等”没有定义并发模型；Dock 激活、托盘会话和设置入口同时触发时可能创建多个窗口或向尚未 ready/已销毁的 `webContents` 发消息。修复：用共享的 in-flight creation promise 串行化创建，并为每个窗口实例绑定 generation token。

3. “renderer ready 后投递一次导航动作”无法处理启动期间的多次操作，可能覆盖、丢失或错误重放新建会话与打开会话。修复：定义有界 FIFO 队列及明确的去重规则，窗口销毁时仅清理属于该 generation 的投递。

4. 托盘同步命令若沿用现有 `getTrustedWindows()` 校验，快速输入窗口也能伪造最近会话、当前项和菜单标题。修复：该命令必须额外要求 `event.sender === mainWindow.webContents`，并测试快速输入 sender 被拒绝。

5. payload“校验”过于含糊，未规定数组长度、字符串长度、唯一 ID、有限时间戳或总字节上限，受损 renderer 可造成菜单膨胀和频繁重建。修复：写出严格 schema，限制最多 5 项、ID/标题长度、唯一 ID、有限 `updatedAt` 和 payload 总大小，并节流菜单重建。

6. 托盘不可用时的策略未定义完整：例如 Windows `closeToTray=true` 但托盘创建失败，既不能隐藏到托盘，也没有明确应关闭窗口还是退出。修复：为每个平台逐项列出 `trayAvailable=false` 的降级结果，Windows 关闭必须退出、最小化必须原生最小化。

7. Windows 的 `quit-app` 执行顺序未定义；若直接从 `close` 处理器调用 `app.quit()`，可能发生 close 重入或其他窗口拦截退出。修复：先 `preventDefault()`、原子设置 `isQuitting=true`，再异步调用 `app.quit()`，并测试多窗口及更新安装路径。

8. 设置同步缺少版本或顺序保证；sidecar 保存成功后，多个并发响应可能让较旧的完整配置覆盖主进程中的较新配置。修复：让持久化结果携带单调 revision，主进程拒绝旧 revision，或将更新与同步收敛为单个主进程事务。

9. “会话不存在则刷新列表”没有闭环：主进程无法验证 renderer 内存中的 ID，renderer 的刷新结果也未保证回传菜单，因此陈旧项可能长期保留。修复：定义失败导航的确认事件，并要求 renderer 完成权威 `agent:list-threads` 刷新后重新同步托盘状态。

10. 生命周期可观测性不足：窗口重建、ready 超时、导航丢弃、托盘创建失败及无效同步 payload 都没有计划中的日志或错误处理。修复：为这些分支增加结构化日志和稳定事件名，并对失败的异步托盘动作统一 `.catch()`。

11. 测试矩阵仍遗漏决定性竞态：没有覆盖并发 ensure、窗口在 ready 前关闭、排队期间连续点击不同动作、旧窗口 ready 事件晚到，以及非主 renderer 注入。修复：把这些场景加入 `desktop-core`/主进程生命周期测试，而不只测试纯策略和菜单输出。

VERDICT: REVISE

### Claude's response

- 采纳 macOS 原生单击菜单语义、共享 creation promise + generation、严格主窗口 sender/schema、托盘不可用降级、退出重入顺序、陈旧会话确认闭环、结构化日志与竞态测试。
- 将启动期导航明确为单槽 last-intent-wins，而非 FIFO；这些动作都是互斥的页面导航意图，执行被后续点击取代的中间意图只会造成闪烁，单槽也天然有界。
- 不引入跨 sidecar 的全局配置版本系统；现有 UI 已在保存中禁用控件。本任务仅给 renderer→main 的完整窗口行为同步加 session-local 单调 revision，防止异步响应倒序污染当前运行时，同时保留重启从持久值恢复的简单模型。
- 菜单重建同时采用状态签名去重和 100ms trailing coalescing；相比无条件节流，这能避免标题/顺序未变时的无意义 native menu 重建。

## Round 2 — Codex

The prior findings are mostly addressed, but three material issues remain:

1. The session-local settings `revision` is not scoped to the main-window generation; after macOS destroys and recreates the renderer, its counter can restart while the main process still remembers a higher value and rejects every subsequent update. Fix: track `{ generation, revision }`, resetting the accepted revision whenever a new main-window generation becomes authoritative.

2. `did-finish-load`/`ready-to-show` does not mean the React listener for `tray-action` is registered; navigation sent immediately afterward can still disappear during application bootstrap. Fix: add an explicit renderer-ready IPC handshake for each generation and deliver pending navigation only after that handshake.

3. Requiring `currentThreadId` to appear in the latest-five payload is inconsistent with the data model: selecting an older tab does not necessarily change `AgentThreadMeta.updatedAt`, so the active thread can legitimately fall outside the five most recently active threads. Fix: allow any bounded current ID, and render a checked menu item only when that ID happens to be present in the recent-five list.

Also add direct tests for renderer-counter reset across window recreation and navigation delivery before/after the renderer-ready handshake; the current lifecycle matrix does not explicitly cover either failure.

VERDICT: REVISE

### Claude's response

- 三项全部采纳。同步顺序改为 generation-scoped revision；新主窗口 generation 成为 authoritative 时重置计数。
- 增加 React listener 注册后的显式 renderer-ready 握手，Electron 的 load/ready 事件不再被误用作业务就绪信号。
- 当前会话 ID 与最近 5 条解耦，只有命中最近列表时才展示 checked；同时补充窗口重建 revision 重置和握手前后投递的直接测试。

## Round 3 — Codex

All prior material findings are now addressed:

- Platform-specific tray behavior is explicit.
- Window creation and navigation are generation-safe.
- Renderer readiness uses an explicit handshake.
- Settings revisions reset across recreated renderer sessions.
- Active-thread state is correctly independent of the recent-five list.
- Sender isolation, payload bounds, stale-thread recovery, observability, fallback behavior, exit reentrancy, and race-focused tests are covered.

The remaining open risks are appropriately limited to native menu sizing, platform icon appearance, and implementation overlap with existing uncommitted changes. The plan is sound enough to implement.

VERDICT: APPROVED

## Act 3 — Build

### Round 1 — Codex build

- Builder thread: `019f7a53-9da5-7f53-9a30-e08df3998af1`
- Result: failed — the foreground build reached the mandatory 10-minute timeout (exit 124).
- Builder report: not produced.
- Workspace changes: none were left by the timed-out build.

### Claude's verdict

Build did not complete and there is no diff or proof output to review. Per the codex-build timeout guard, no automatic retry was attempted.

### Direct implementation takeover

The user approved a direct implementation after the delegated builder timed out. Stale full-write builder processes were terminated, their partial changes were reviewed and completed directly, and no commit was created for the implementation.

- Implemented platform-specific window action resolution, tray-setting invariants, generation-safe main-window recreation, renderer-ready navigation delivery, strict main-window-only tray synchronization, recent-five conversation navigation, compact native menu labels, and dedicated Windows/macOS tray assets.
- Simplified the old focus-sensitive tray toggle into explicit show/hide actions and removed the incorrect “新建笔记” action in favor of the existing new-conversation flow.
- Proof: `bun test apps/desktop/scripts/desktop-core.test.mjs apps/desktop/scripts/electron-security.test.mjs apps/web/src/components/app-shell/LeftSidebar.test.ts apps/web/src/components/settings/general-settings-state.test.ts apps/sidecar/src/services/system/general-settings-service.test.ts` — 111 passed, 0 failed.
- Typecheck: `@lume/desktop`, `@lume/web`, and `@lume/sidecar` all exited with code 0.
- Remaining manual verification: native menu width and tray icon appearance on real Windows/macOS DPI and theme combinations.

### Post-build visual adjustment

At the user's request, the tray now directly reuses the existing Lume logo assets (`icon.ico` on Windows and `icon.png` converted to a macOS Template Image) instead of dedicated tray-only assets. The unused generated tray assets were removed.

The native checkbox menu type was also removed from recent conversations because it made the operating system reserve a wide checkmark gutter for the entire menu. The active conversation now uses a compact `✓` text prefix instead.
