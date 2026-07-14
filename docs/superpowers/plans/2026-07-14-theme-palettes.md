# Lume Theme Palettes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four persistent Lume color palettes that work independently from the existing system/light/dark appearance mode.

**Architecture:** Extend the shared general-settings contract with a `themePalette` value and persist it through the existing sidecar settings service. Reuse the current theme runtime to apply a `data-theme-palette` attribute before first paint, then override the existing semantic CSS tokens for each palette. Expose palette selection in General Settings using the existing shadcn `Button` component.

**Tech Stack:** TypeScript, React, Jotai-compatible shared settings, Bun tests, Tailwind CSS v4, CSS custom properties.

---

### Task 1: Extend and persist the palette setting

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts`
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts`
- Modify: `apps/sidecar/src/services/system/general-settings-service.test.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`

- [x] **Step 1: Write the failing persistence test**

Add a test that updates `themePalette` to `iris`, verifies that it survives a later partial update, and verifies invalid stored values fall back to `mint`.

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`

Expected: FAIL because `themePalette` is absent from the shared contract and persisted result.

- [x] **Step 3: Implement the minimal shared and sidecar changes**

Define `ThemePalette` as `"mint" | "iris" | "clay" | "ocean"`, add `themePalette` to `GeneralSettings` and `UpdateGeneralSettingsInput`, default it to `mint`, sanitize it in the service, preserve it during partial updates, and accept the four values in the RPC schema.

- [x] **Step 4: Run the test to verify it passes**

Run: `bun test apps/sidecar/src/services/system/general-settings-service.test.ts`

Expected: PASS.

### Task 2: Apply the palette before and after bootstrap

**Files:**
- Modify: `apps/web/src/lib/theme-mode.ts`
- Modify: `apps/web/src/lib/theme-mode.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/public/boot-theme.js`

- [x] **Step 1: Write the failing runtime tests**

Test that stored palette values are validated, invalid values fall back to `mint`, and `setThemePalette("clay")` stores the value and writes `document.documentElement.dataset.themePalette`.

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/src/lib/theme-mode.test.ts`

Expected: FAIL because the palette runtime exports do not exist.

- [x] **Step 3: Implement the minimal runtime changes**

Add the palette storage key and getter/setter functions to the existing theme runtime, bootstrap from local storage before the sidecar responds, reconcile with persisted settings, and mirror the attribute in `boot-theme.js` to avoid a first-paint flash.

- [x] **Step 4: Run the test to verify it passes**

Run: `bun test apps/web/src/lib/theme-mode.test.ts`

Expected: PASS.

### Task 3: Add palette options and semantic token overrides

**Files:**
- Modify: `apps/web/src/components/settings/general-settings-state.ts`
- Modify: `apps/web/src/components/settings/general-settings-state.test.ts`
- Modify: `apps/web/src/components/settings/GeneralSettings.tsx`
- Modify: `apps/web/src/index.css`

- [x] **Step 1: Write the failing settings-state tests**

Test that the palette options are `mint`, `iris`, `clay`, and `ocean`, the default is `mint`, and partial merges update the palette without losing the brightness mode or sibling fields.

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/src/components/settings/general-settings-state.test.ts`

Expected: FAIL because palette options and merge behavior are absent. The file also has two pre-existing stale `showTray` expectations; update those expectations while editing the same default-settings contract.

- [x] **Step 3: Implement the palette picker and CSS tokens**

Add four labeled palette options with swatch metadata, render them with the existing `Button` primitive, persist selection through `updateGeneralSettings`, and add light/dark semantic token overrides for iris, clay, and ocean. Keep mint mapped to the existing tokens for backward compatibility.

- [x] **Step 4: Run the focused tests**

Run: `bun test apps/web/src/components/settings/general-settings-state.test.ts apps/web/src/lib/theme-mode.test.ts apps/sidecar/src/services/system/general-settings-service.test.ts`

Expected: PASS.

### Task 4: Verify the public contract and diff

**Files:**
- Verify only: all files above

- [x] **Step 1: Run focused type checking for affected packages**

Run: `bun run --cwd packages/shared typecheck`, then the existing sidecar typecheck command if present, and `bun run --cwd apps/web typecheck`.

Expected: PASS. If a package has no typecheck script, do not introduce one.

- [x] **Step 2: Review the diff**

Run: `git diff --check` and `git diff --` for the touched files. Confirm the unrelated `apps/web/src/components/agent/SubagentInlinePanel.tsx` modification is untouched.
