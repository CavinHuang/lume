# Desktop Release And Update Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add production-oriented desktop packaging, GitHub Release distribution, and in-app update controls for Lume.

**Architecture:** GitHub Actions builds signed Tauri bundles for macOS, Windows, and Linux from version tags. Tauri updater handles secure update checks/download/install, while the web settings page renders update state and persists only user preferences in the existing general settings store.

**Tech Stack:** Tauri 2, `tauri-plugin-updater`, `tauri-plugin-process`, Bun workspaces, GitHub Actions, React settings UI.

---

## Chunk 1: Settings Contract

### Task 1: Persist update preferences

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts`
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Test: `apps/sidecar/src/services/system/general-settings-service.test.ts`
- Test: `apps/web/src/components/settings/general-settings-state.test.ts`

- [x] Add `updateSettings` to `GeneralSettings` with `autoCheckUpdates`, `notifyAfterDownload`, `installOnlyWhenIdle`, and `lastUpdateCheckAt`.
- [x] Update merge/sanitize behavior so partial update settings preserve sibling values.
- [x] Verify focused settings tests fail before implementation and pass after implementation.

## Chunk 2: Desktop Updater Runtime

### Task 2: Enable Tauri packaging and updater plugins

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Modify: `package.json`

- [x] Add updater/process plugin dependencies.
- [x] Enable Tauri bundle targets and configure updater endpoint.
- [x] Register updater/process plugins in the desktop shell.
- [x] Add root scripts for desktop build/package/release.
- [x] Run Rust check for the desktop crate.

## Chunk 3: Release Pipeline

### Task 3: Build and publish GitHub releases

**Files:**
- Create: `.github/workflows/release-desktop.yml`
- Create: `docs/release/desktop-release.md`

- [x] Add a tag-triggered GitHub Actions matrix for macOS, Windows, and Linux.
- [x] Upload platform bundles to GitHub Releases using `tauri-apps/tauri-action`.
- [x] Document required signing secrets and tag release flow.

## Chunk 4: Update UI

### Task 4: Add version and update settings page

**Files:**
- Create: `apps/web/src/components/settings/VersionUpdateSettings.tsx`
- Create: `apps/web/src/components/settings/version-update-state.ts`
- Create: `apps/web/src/components/settings/version-update-state.test.ts`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`
- Modify: `apps/web/src/components/settings/settings-view-state.ts`
- Modify: `apps/web/src/lib/desktop-api/native.ts`
- Modify: `apps/web/src/lib/desktop-api/system.ts`

- [x] Add Tauri updater wrappers with graceful non-desktop fallback.
- [x] Render current/latest version, status, release notes, options, and install controls.
- [x] Add legal toggle visibility rules for check/download/install states.
- [x] Verify focused web tests and typecheck.
