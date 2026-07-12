# Computer Use Semantic-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows and macOS Computer Use prefer accessibility semantics and targeted window operations, with screenshots available only through an explicit fallback tool.

**Architecture:** Native hosts continue to collect platform-specific UIA/AX data and expose one shared semantic quality contract. Sidecar stops attaching screenshots to initial desktop context, adds a dedicated screenshot tool that reuses `get_window_state`, and teaches the agent to use accessibility elements before targeted window input and visual coordinates.

**Tech Stack:** Rust, Windows UI Automation/Win32, macOS AXUIElement, TypeScript, Bun test, existing Lume MCP tool wrapper.

---

## File map

- `crates/lume-desktop-host/src/windows_backend.rs`: choose Windows context text from UIA data and report semantic source/quality.
- `crates/lume-desktop-host/src/macos_snapshot.rs`: report the same source/quality contract for AX snapshots.
- `crates/lume-desktop-host/tests/macos_snapshot.rs`: macOS projection regression coverage.
- `packages/shared/src/types/computer-use.ts`: shared source/quality fields.
- `apps/sidecar/src/services/desktop-context/desktop-context-service.ts`: preserve semantic metadata and stop user selection from implicitly requesting pixels.
- `apps/sidecar/src/services/desktop-context/desktop-context-runtime.ts`: resolve first-turn context without image blocks.
- `apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts`: explicit `take_screenshot` fallback tool and semantic-first descriptions.
- `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`: semantic-first system guidance.
- Corresponding `*.test.ts` files and `crates/lume-desktop-host/tests/macos_snapshot.rs`: regression coverage.

### Task 1: Add the shared semantic quality contract

**Files:**
- Modify: `packages/shared/src/types/computer-use.ts`
- Modify: `apps/sidecar/src/services/desktop-context/desktop-context-service.ts`
- Test: `apps/sidecar/src/services/desktop-context/desktop-context-service.test.ts`

- [ ] **Step 1: Write a failing metadata-preservation test**

Require a normalized snapshot to preserve:

```ts
expect(snapshot).toMatchObject({
  textSource: "accessibility_visible",
  completeness: "partial",
  fallbackReason: "document text unavailable",
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test apps/sidecar/src/services/desktop-context/desktop-context-service.test.ts`

Expected: FAIL because normalization drops the fields.

- [ ] **Step 3: Add minimal shared types**

Add `DesktopContextTextSource` with `accessibility_selection | accessibility_document | accessibility_visible | accessibility_tree | window_title`, plus `DesktopContextCompleteness` with `complete | partial | minimal`. Extend `DesktopContextSnapshot` and `DesktopWindowState` with optional `textSource`, `completeness`, and `fallbackReason`, keeping old snapshots valid.

- [ ] **Step 4: Preserve Host metadata in Sidecar**

In both `snapshotFromWindowStateTarget` and `snapshotFromWindowState`, copy recognized Host metadata. Do not infer a competing quality result in Sidecar.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same Bun test. Expected: PASS.

### Task 2: Make Windows UIA visible text a real fallback

**Files:**
- Modify: `crates/lume-desktop-host/src/windows_backend.rs`

- [ ] **Step 1: Write failing pure-function tests**

Add tests proving:
- `documentText` wins over visible node names and reports `accessibility_document/complete`.
- `visibleText` wins over the window title and reports `accessibility_visible/partial`.
- title-only context reports `window_title/minimal`.
- truncated UIA output reports `partial`.

- [ ] **Step 2: Run the Windows host test and verify RED**

Run: `cargo test --manifest-path crates/lume-desktop-host/Cargo.toml windows_backend::tests`

Expected: FAIL because the selector does not exist.

- [ ] **Step 3: Implement the minimal selector**

Add one private selector with this exact order: `documentText`, `visibleText`, window title. Return text, source, completeness, and optional fallback reason.

- [ ] **Step 4: Use it in current context and window state**

Attach `textSource`, `completeness`, and optional `fallbackReason` to both responses. Keep the accessibility tree, screenshot metadata, and explicit `includeScreenshot` protocol compatible.

- [ ] **Step 5: Run the Windows host test and verify GREEN**

Run the same Cargo command. Expected: PASS.

### Task 3: Align macOS AX context metadata

**Files:**
- Modify: `crates/lume-desktop-host/src/macos_snapshot.rs`
- Test: `crates/lume-desktop-host/tests/macos_snapshot.rs`

- [ ] **Step 1: Write failing macOS assertions**

Extend existing accessibility tests to require `accessibility_selection/complete`, add a title-only case requiring `window_title/minimal`, and a truncated AX case requiring `partial`.

- [ ] **Step 2: Run the macOS snapshot test and verify RED**

Run: `cargo test --manifest-path crates/lume-desktop-host/Cargo.toml --test macos_snapshot`

Expected: FAIL because metadata is absent.

- [ ] **Step 3: Implement the macOS selector**

Use selected text, document/accessibility text, element-derived visible text, then title. Attach the unified fields to context and window-state responses without changing AX collection or capture behavior.

- [ ] **Step 4: Run the macOS snapshot test and verify GREEN**

Run the same Cargo command. Expected: PASS.

### Task 4: Stop implicit screenshot capture and first-turn image injection

**Files:**
- Modify/Test: `apps/sidecar/src/services/desktop-context/desktop-context-service.ts`
- Modify/Test: `apps/sidecar/src/services/desktop-context/desktop-context-runtime.ts`
- Modify/Test: `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`
- Tests: corresponding `*.test.ts` files.

- [ ] **Step 1: Change tests to require semantic-only defaults**

Require user-initiated capture methods to call Host without `includeScreenshot`. Require `resolveDesktopContextProjection` to call `currentContext({ snapshotId })`, fall back with `get_window_state({ windowId })`, and return no `imageBlocks`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
bun test apps/sidecar/src/services/desktop-context/desktop-context-service.test.ts apps/sidecar/src/services/desktop-context/desktop-context-runtime.test.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts
```

Expected: FAIL because current code requests and injects screenshots.

- [ ] **Step 3: Remove implicit pixel requests**

Call Host without screenshot flags during user selection. Resolve first-turn projection without pixels or image blocks. Keep screenshot metadata when an old stored snapshot already contains it.

- [ ] **Step 4: Replace visual-first prompt policy**

Teach the Agent to prefer selected text, visible text, and element structure; use `get_window_state` for fresh structure; use `take_screenshot` only for minimal/inherently visual/unverifiable results; prefer element semantics, then targeted window input, then screenshot coordinates.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same Bun command. Expected: PASS.

### Task 5: Add an explicit screenshot fallback tool

**Files:**
- Modify/Test: `apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Require read-only `mcp__computer_use__take_screenshot` with a `windowId` schema. Calling it must internally invoke:

```ts
{ method: "get_window_state", input: { windowId: "win:wechat", includeScreenshot: true } }
```

Verify it returns non-persistent image content and that Agent-facing `get_window_state` and `current_context` schemas no longer expose `includeScreenshot`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.test.ts
```

Expected: FAIL because `take_screenshot` is absent.

- [ ] **Step 3: Implement the wrapper without a new Host method**

Add `take_screenshot` to tool/read-only/window-scoped sets. Dispatch it to `get_window_state` with `includeScreenshot: true`. Reuse `toolResult` and `detachScreenshotImages`; do not duplicate capture or image parsing.

- [ ] **Step 4: Tighten tool descriptions**

Describe `get_window_state` as accessibility-only, `take_screenshot` as the final visual fallback, and action priority as element semantics, targeted window input, then screenshot coordinates. Preserve protocol-level `includeScreenshot` support for non-Agent callers.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same Bun command. Expected: PASS.

### Task 6: Focused integration verification

**Files:**
- Modify only files made necessary by failures directly caused by Tasks 1-5.

- [ ] **Step 1: Run native tests**

```powershell
cargo test --manifest-path crates/lume-desktop-host/Cargo.toml windows_backend::tests
cargo test --manifest-path crates/lume-desktop-host/Cargo.toml --test macos_snapshot
```

Expected: PASS.

- [ ] **Step 2: Run sidecar semantic-first tests**

```powershell
bun test apps/sidecar/src/services/desktop-context/desktop-context-service.test.ts apps/sidecar/src/services/desktop-context/desktop-context-runtime.test.ts apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.test.ts
```

Expected: PASS without unexpected warnings.

- [ ] **Step 3: Run the public portable gate**

Run: `bun run verify:computer-use:portable`

Expected: PASS. Update only assertions that encode the former screenshot-first behavior.

- [ ] **Step 4: Inspect the final diff**

Run `git diff --check` and `git status --short`. Confirm no generated binaries, logs, or unrelated formatting.

- [ ] **Step 5: Commit with Lore protocol**

Use:

```text
✨ feat(desktop,sidecar,shared): Computer Use 改为语义优先

统一 Windows UIA 与 macOS AX 的上下文质量标记，默认不再注入桌面截图，截图改为显式备选工具。

Constraint: 保留底层 includeScreenshot 协议兼容
Rejected: 根据应用名称自动截图 | 策略不可解释且容易扩大敏感采集范围
Tested: 定向 Rust、Sidecar 与 portable Computer Use 验证
Not-tested: 真实微信和 macOS 权限环境端到端
```

