# Agents Workbench Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable Agents workbench: a shared Alice-style role registry, runtime subagent definitions, role recommendation/concurrency helpers, project IP assets, and a Settings UI card catalog.

**Architecture:** Put role truth in `packages/shared`, derive sidecar runtime agents from that registry, and render the Settings page from the same data. Keep first version read-only for built-ins, with pure helper functions for search, recommendation, and concurrency so the later editable-role manager can reuse them.

**Tech Stack:** TypeScript, Bun tests, React/Vite, existing Lume Settings shell, existing SDK `AgentDefinition`.

---

## Chunk 1: Shared Role Registry

### Task 1: Add registry tests first

**Files:**
- Create: `packages/shared/src/types/agent-roles.test.ts`
- Create: `packages/shared/src/types/agent-roles.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Write failing tests**

Cover:
- registry exposes 11 Alice-inspired roles in stable order
- ids are unique and include `researcher`, `designer`, `developer`
- `suggestAgentRoles()` ranks keyword matches and returns matched keywords
- `canAgentRolesRunInParallel()` supports wildcard and writer/developer conflict

- [ ] **Step 2: Run shared role tests and verify RED**

Run: `bun test packages/shared/src/types/agent-roles.test.ts`
Expected: FAIL because `agent-roles.ts` does not exist.

- [ ] **Step 3: Implement minimal registry and helpers**

Add `AgentRoleDefinition`, `BUILTIN_AGENT_ROLES`, `suggestAgentRoles`, `canAgentRolesRunInParallel`, and lookup helpers.

- [ ] **Step 4: Run shared role tests and verify GREEN**

Run: `bun test packages/shared/src/types/agent-roles.test.ts`
Expected: PASS.

## Chunk 2: Runtime Mapping

### Task 2: Derive sidecar built-ins from registry

**Files:**
- Create: `apps/sidecar/src/services/agent/agent-role-runtime.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`

- [ ] **Step 1: Write failing runtime tests**

Cover:
- `buildBuiltinAgents()` includes Alice role ids
- role definitions inherit prompt and description
- read-only roles expose read/search tools and exclude write/edit tools
- writable role such as `developer` remains available and uses `inherit` model

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `bun test apps/sidecar/src/services/agent/agent-role-runtime.test.ts`
Expected: FAIL because runtime is not registry-derived yet.

- [ ] **Step 3: Update runtime mapping**

Keep existing Lume built-ins (`explorer`, `planner`, `researcher`, `code-reviewer`) behavior where necessary, but make Alice role ids available. If an existing id conflicts, registry role wins for the user-facing built-in role.

- [ ] **Step 4: Run runtime tests and verify GREEN**

Run: `bun test apps/sidecar/src/services/agent/agent-role-runtime.test.ts`
Expected: PASS.

## Chunk 3: Settings UI State And Assets

### Task 3: Add UI state helpers and IP assets

**Files:**
- Create: `apps/web/src/components/settings/agents-settings-state.test.ts`
- Create: `apps/web/src/components/settings/agents-settings-state.ts`
- Create: `apps/web/src/assets/agents/*.jpg`

- [ ] **Step 1: Write failing UI state tests**

Cover:
- filtering by Chinese display name
- filtering by role id/default skill
- recommendation preview returns roles with labels
- metrics count all/read-only/background/writable roles

- [ ] **Step 2: Run UI state tests and verify RED**

Run: `bun test apps/web/src/components/settings/agents-settings-state.test.ts`
Expected: FAIL because state helper does not exist.

- [ ] **Step 3: Copy generated IP assets**

Copy generated images from `/Users/cavinhuang/.codex/generated_images/019e4d20-3736-7242-bc86-312ef120bc1a` into `apps/web/src/assets/agents/` using role-id filenames.

- [ ] **Step 4: Implement UI state helpers**

Use shared registry and local asset imports. Keep functions pure and small.

- [ ] **Step 5: Run UI state tests and verify GREEN**

Run: `bun test apps/web/src/components/settings/agents-settings-state.test.ts`
Expected: PASS.

## Chunk 4: Settings Page

### Task 4: Add Agents Settings tab and card catalog

**Files:**
- Create: `apps/web/src/components/settings/AgentsSettings.tsx`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`
- Modify: `apps/web/src/components/settings/settings-view-state.ts`

- [ ] **Step 1: Add Settings navigation contract test if practical**

Prefer a focused state-level assertion that `SETTINGS_NAV_ITEMS` includes `agents` after `models`.

- [ ] **Step 2: Implement UI**

Add:
- summary metrics
- search input
- recommendation preview input
- role card grid
- detail panel/drawer-style aside for selected role

- [ ] **Step 3: Run targeted web tests**

Run:
- `bun test apps/web/src/components/settings/agents-settings-state.test.ts`
- `bun test apps/web/src/components/settings/settings-view-state.test.ts` if added

Expected: PASS.

## Chunk 5: Focused Verification

### Task 5: Verify only touched test surfaces

**Files:**
- Shared tests
- Sidecar runtime test
- Web settings state/navigation tests

- [ ] **Step 1: Run targeted tests**

Run:
- `bun test packages/shared/src/types/agent-roles.test.ts`
- `bun test apps/sidecar/src/services/agent/agent-role-runtime.test.ts`
- `bun test apps/web/src/components/settings/agents-settings-state.test.ts`
- any added Settings nav test

- [ ] **Step 2: Run typecheck only if tests expose type risk**

Run package-specific typecheck only if touched code or imports show type errors not covered by tests.

- [ ] **Step 3: Inspect diff**

Run: `git diff --stat` and inspect changed files to ensure unrelated memory work is untouched.
