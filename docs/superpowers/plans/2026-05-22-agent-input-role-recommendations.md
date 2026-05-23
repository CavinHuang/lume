# Agent Input Role Recommendations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight role recommendation chips to the main Agent input so users can choose an Alice-style built-in agent from their task text.

**Architecture:** Reuse the shared role registry directly. Keep recommendation and prompt-rewrite behavior in one focused pure state file next to `AgentInput`, then render chips inside the existing composer `supportingContent` slot without adding bridge APIs or wrapper components.

**Tech Stack:** TypeScript, React, TipTap editor, Bun tests, existing Lume composer.

---

## Chunk 1: Input Recommendation State

### Task 1: Add pure recommendation behavior

**Files:**
- Create: `apps/web/src/components/agent/agent-input-role-recommendations.test.ts`
- Create: `apps/web/src/components/agent/agent-input-role-recommendations.ts`

- [ ] **Step 1: Write failing tests**

Cover:
- empty input returns no chips
- task text returns at most 3 role chips
- chip label contains display name and title
- selecting a role prepends a stable instruction
- selecting the same role again does not duplicate the instruction

- [ ] **Step 2: Run test to verify RED**

Run: `rtk bun test apps/web/src/components/agent/agent-input-role-recommendations.test.ts`

Expected: FAIL because the state file does not exist.

- [ ] **Step 3: Implement minimal pure functions**

Add:
- `buildAgentInputRoleRecommendations(input: string)`
- `applyAgentRoleRecommendation(input: string, roleId: AgentRoleId)`

Use `suggestAgentRoles()` and `getAgentRole()` from `@lume/shared`.

- [ ] **Step 4: Run test to verify GREEN**

Run: `rtk bun test apps/web/src/components/agent/agent-input-role-recommendations.test.ts`

Expected: PASS.

## Chunk 2: AgentInput UX

### Task 2: Render recommendation chips in the existing composer

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [ ] **Step 1: Import pure functions and role type**

Use the new local state helpers directly in `AgentInput.tsx`.

- [ ] **Step 2: Derive recommendations from `editorText`**

Hide chips while streaming or local sending. Hide chips when there are no recommendations.

- [ ] **Step 3: Render chips through `supportingContent`**

Reuse the existing composer `supportingContent` slot. If attachments exist, show attachments first and recommendations below.

- [ ] **Step 4: Apply chip selection to the editor**

On click, call `applyAgentRoleRecommendation(editor.getText(), role.id)` and replace editor content with the returned text. Focus the editor after selection.

- [ ] **Step 5: Run focused verification**

Run:
- `rtk bun test apps/web/src/components/agent/agent-input-role-recommendations.test.ts`
- `rtk bun run --filter @lume/web typecheck`

Expected: PASS.
