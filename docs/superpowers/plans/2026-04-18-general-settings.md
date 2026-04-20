# General Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new top-level `常规设置` page for app-wide preferences, covering theme mode, tray-related window behavior, opening the logs directory, and safe cache cleanup.

**Architecture:** Persist stable desktop/web preferences under a new `generalSettings` namespace inside the existing `settings.json`, separate from `uiState`. Web renders a new top-level settings tab with three sections (`界面 / 窗口行为 / 维护`), browser-local cache cleanup handles `frontendTemp` + `previewRender`, sidecar owns preference persistence plus log maintenance actions, and the desktop shell reads `generalSettings.windowBehavior` to decide how minimize/close events interact with the system tray.

**Tech Stack:** React, TypeScript, Bun test, sidecar RPC/Zod, Rust/Tauri 2 desktop shell

---

## File Structure

### Create
- `packages/shared/src/types/general-settings.ts` — shared type contract for `generalSettings`, cache cleanup selections, and new IPC channel names
- `apps/sidecar/src/services/system/general-settings-service.ts` — read/write `generalSettings` from `settings.json`
- `apps/sidecar/src/services/system/general-settings-service.test.ts` — persistence regression tests
- `apps/web/src/components/settings/GeneralSettings.tsx` — new page for `常规设置`
- `apps/web/src/components/settings/general-settings-state.ts` — pure TS state helpers for theme/window behavior/cache cleanup UI
- `apps/web/src/components/settings/general-settings-state.test.ts` — pure logic tests for the new page
- `apps/web/src/components/settings/ClearCacheDialog.tsx` — modal for safe cache cleanup selection

### Modify
- `packages/shared/src/types/index.ts`
- `apps/sidecar/src/rpc/schemas.ts`
- `apps/sidecar/src/rpc/system-handlers.ts`
- `apps/sidecar/src/services/system/ui-state-service.ts`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/web/src/components/settings/SettingsView.tsx`
- `apps/web/src/lib/desktop-api/system.ts`
- `apps/web/src/lib/desktop-api/index.ts`

### Verification
- `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`
- `bun test apps/web/src/components/settings/general-settings-state.test.ts`
- `bun run --filter @lume/web build`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

---

### Task 1: Add Shared General Settings Contract

**Files:**
- Create: `packages/shared/src/types/general-settings.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add the shared preference types**

Create `packages/shared/src/types/general-settings.ts` with:

```ts
export type ThemeMode = "system" | "light" | "dark"

export interface GeneralSettings {
  themeMode: ThemeMode
  windowBehavior: {
    minimizeToTray: boolean
    closeToTray: boolean
  }
}

export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  windowBehavior?: Partial<GeneralSettings["windowBehavior"]>
}

export interface ClearCacheInput {
  logs?: boolean
}

export interface ClearCacheResult {
  cleared: Array<"logs">
  skipped: Array<"logs">
}

export const GENERAL_SETTINGS_IPC_CHANNELS = {
  GET: "general-settings:get",
  UPDATE: "general-settings:update",
  OPEN_LOGS_DIR: "general-settings:open-logs-dir",
  CLEAR_CACHE: "general-settings:clear-cache",
} as const
```

- [ ] **Step 2: Export the new type surface**

Update `packages/shared/src/types/index.ts`:

```ts
export * from "./general-settings";
```

- [ ] **Step 3: Run a package typecheck**

Run: `bun run --filter @lume/shared typecheck`

Expected: exit `0`

---

### Task 2: Persist `generalSettings` in Sidecar

**Files:**
- Create: `apps/sidecar/src/services/system/general-settings-service.ts`
- Create: `apps/sidecar/src/services/system/general-settings-service.test.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/system-handlers.ts`
- Modify: `apps/sidecar/src/services/system/ui-state-service.ts`

- [ ] **Step 1: Write the failing persistence test**

Create `apps/sidecar/src/services/system/general-settings-service.test.ts` covering:

```ts
test("getPersistedGeneralSettings returns defaults when settings.json is missing", ...)
test("updatePersistedGeneralSettings merges themeMode and windowBehavior into settings.json", ...)
test("updating generalSettings keeps existing uiState intact", ...)
```

- [ ] **Step 2: Run the new test and watch it fail**

Run: `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`

Expected: `fail` because the service does not exist yet.

- [ ] **Step 3: Implement sidecar persistence**

Create `apps/sidecar/src/services/system/general-settings-service.ts` with the same atomic read/write pattern already used by `ui-state-service.ts`, but scoped to:

```ts
interface SidecarSettings {
  uiState?: PersistedUiState
  generalSettings?: GeneralSettings
  [key: string]: unknown
}
```

The implementation should:
- default `themeMode` to `"system"`
- default both tray toggles to `false`
- merge updates without deleting sibling `settings.json` keys

- [ ] **Step 4: Add RPC schemas and handlers**

Update `apps/sidecar/src/rpc/schemas.ts` with:

```ts
export const updateGeneralSettingsInputSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  windowBehavior: z.object({
    minimizeToTray: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
  }).optional(),
})

export const clearCacheInputSchema = z.object({
  logs: z.boolean().optional(),
}).strict()
```

Update `apps/sidecar/src/rpc/system-handlers.ts` to register:
- `general-settings:get`
- `general-settings:update`
- `general-settings:open-logs-dir`
- `general-settings:clear-cache`

- [ ] **Step 5: Reuse settings.json safely**

Adjust `ui-state-service.ts` only if necessary so both services share the same `settings.json` shape without clobbering each other.

- [ ] **Step 6: Verify sidecar persistence**

Run:
- `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`
- `bun run --filter @lume/sidecar build`

Expected: both exit `0`

---

### Task 3: Add Desktop Shell Support for Tray Behavior

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Test: `apps/desktop/src-tauri/src/main.rs` (inline Rust unit tests near helpers)

- [ ] **Step 1: Add a failing Rust unit test for general settings parsing**

Add tests that prove a helper can read:

```rust
themeMode = "system"
windowBehavior.minimizeToTray = true
windowBehavior.closeToTray = false
```

from the existing `~/.lume/settings.json` shape.

- [ ] **Step 2: Run Rust tests and watch the new test fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: new parsing test fails because the helper is missing.

- [ ] **Step 3: Implement settings reader + tray/window behavior**

In `main.rs`:
- add a helper to resolve `~/.lume/settings.json`
- parse `generalSettings.windowBehavior`
- wire minimize/close window events
- when the relevant toggle is enabled:
  - minimize hides to tray instead of plain minimize
  - close hides to tray instead of exiting

This task also requires adding Tauri tray/menu support because the current desktop shell has no tray infrastructure yet.

- [ ] **Step 4: Add tray affordances**

Implement a minimal tray menu:
- show/focus main window
- quit

This is required so “to tray” remains reversible.

- [ ] **Step 5: Re-run Rust tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: exit `0`

---

### Task 4: Build the New `常规设置` Page in Web

**Files:**
- Create: `apps/web/src/components/settings/general-settings-state.ts`
- Create: `apps/web/src/components/settings/general-settings-state.test.ts`
- Create: `apps/web/src/components/settings/GeneralSettings.tsx`
- Create: `apps/web/src/components/settings/ClearCacheDialog.tsx`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`
- Modify: `apps/web/src/lib/desktop-api/system.ts`
- Modify: `apps/web/src/lib/desktop-api/index.ts`

- [ ] **Step 1: Write the failing state test**

Create `apps/web/src/components/settings/general-settings-state.test.ts` covering:

```ts
test("general settings nav metadata places 常规设置 first", ...)
test("theme mode options are system/light/dark", ...)
test("cache cleanup defaults all three safe caches to selected", ...)
```

- [ ] **Step 2: Run the state test and confirm failure**

Run: `bun test apps/web/src/components/settings/general-settings-state.test.ts`

Expected: `fail` because the helper file does not exist yet.

- [ ] **Step 3: Implement web API helpers**

Add helpers in `apps/web/src/lib/desktop-api/system.ts` for:
- `getGeneralSettings()`
- `updateGeneralSettings()`
- `openLogsDir()`
- `clearCache()`

All of them should call the new sidecar RPC methods.

- [ ] **Step 4: Implement the page**

Create `GeneralSettings.tsx` with three sections:

```tsx
<ThemeModeSection />
<WindowBehaviorSection />
<MaintenanceSection />
```

Behavior rules:
- theme mode: immediate apply + immediate persist
- tray toggles: optimistic update with rollback on failure
- logs dir: direct action
- clear cache: button opens modal with 3 checked-by-default options

- [ ] **Step 5: Add the new top-level settings tab**

Update `SettingsView.tsx` so `常规设置` is first in the nav and becomes the default selected tab.

- [ ] **Step 6: Verify the web surface**

Run:
- `bun test apps/web/src/components/settings/general-settings-state.test.ts`
- `bun run --filter @lume/web build`

Expected: both exit `0`

---

### Task 5: Implement Safe Cache Cleanup

**Files:**
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts`
- Modify: `apps/web/src/components/settings/ClearCacheDialog.tsx`

- [ ] **Step 1: Define exact deletion scope**

Delete only:
- browser-side frontend temporary cache (session-scoped temp data)
- browser/UI preview-render cache (syntax highlight/render caches)
- sidecar/desktop log files under `~/.lume/logs`

Do not touch:
- conversations
- agent threads
- workspaces
- `lume.yaml`
- provider or MCP config

- [ ] **Step 2: Implement cache cleanup as idempotent operations**

The implementation should split ownership:
- web/browser layer clears `frontendTemp` and `previewRender`
- sidecar cleanup handler clears only known safe log directories/files
- all cleanup paths treat missing targets as `skipped`, not errors
- the final dialog still returns a single structured `ClearCacheResult`

- [ ] **Step 3: Surface the result in the dialog**

`ClearCacheDialog.tsx` should display which items were cleared and which were skipped.

- [ ] **Step 4: Re-run focused verification**

Run:
- `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`
- `bun run --filter @lume/web build`

Expected: exit `0`

---

### Task 6: End-to-End Verification

**Files:** no new edits

- [ ] **Step 1: Verify sidecar tests**

Run:
- `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`

Expected: `pass`

- [ ] **Step 2: Verify web tests**

Run:
- `bun test apps/web/src/components/settings/general-settings-state.test.ts`

Expected: `pass`

- [ ] **Step 3: Verify web production build**

Run:
- `bun run --filter @lume/web build`

Expected: exit `0`

- [ ] **Step 4: Verify desktop shell tests**

Run:
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: exit `0`

- [ ] **Step 5: Manual smoke checklist**

1. Open Settings and confirm `常规设置` is the first tab and default active page.
2. Change theme mode and confirm immediate UI update plus persistence after reopen.
3. Toggle `最小化到系统托盘` and `关闭到系统托盘`, restart app, confirm behavior persists.
4. Click `打开日志目录` and confirm the OS file manager opens `~/.lume/logs`.
5. Open `清理缓存`, confirm three safe cache checkboxes are preselected and the warning says session/thread/workspace/config are untouched.
