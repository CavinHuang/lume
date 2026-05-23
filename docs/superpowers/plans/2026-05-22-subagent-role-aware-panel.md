# Subagent Role Aware Panel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagent execution cards display Alice-style built-in role identity when a run uses a known agent role.

**Architecture:** Add one local pure display-state helper next to `SubagentInlinePanel`, derived directly from `@lume/shared` role registry. Render the returned labels and badges inside the existing inline panel without changing runtime protocols or adding bridge code.

**Tech Stack:** TypeScript, React, Bun tests, existing Jotai run state.

---

## Chunk 1: Role Display State

### Task 1: Add role display pure function

**Files:**
- Create: `apps/web/src/components/agent/subagent-role-display.test.ts`
- Create: `apps/web/src/components/agent/subagent-role-display.ts`

- [ ] **Step 1: Write failing tests**

Cover:
- known role id displays built-in role label and badges
- `resolvedAgentId` wins over `requestedAgentId`
- unknown role keeps fallback display

- [ ] **Step 2: Run RED**

Run: `rtk bun test apps/web/src/components/agent/subagent-role-display.test.ts`

Expected: FAIL because `subagent-role-display.ts` does not exist.

- [ ] **Step 3: Implement minimal helper**

Add `resolveSubagentRoleDisplay(input)` using `getAgentRole()` from `@lume/shared`.

- [ ] **Step 4: Run GREEN**

Run: `rtk bun test apps/web/src/components/agent/subagent-role-display.test.ts`

Expected: PASS.

## Chunk 2: Inline Panel Integration

### Task 2: Render role-aware labels in existing panel

**Files:**
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.tsx`

- [ ] **Step 1: Import helper**

Import `resolveSubagentRoleDisplay`.

- [ ] **Step 2: Derive display state**

Use run record `requestedAgentId` / `resolvedAgentId` plus `agentType` and `label`.

- [ ] **Step 3: Update header and detail area**

Show `primaryLabel`, runtime id, and badges. Preserve existing fallback for custom agents.

- [ ] **Step 4: Verify**

Run:
- `rtk bun test apps/web/src/components/agent/subagent-role-display.test.ts`
- `rtk bun run --filter @lume/web typecheck`
