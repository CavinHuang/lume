# Agent SDK Nativeization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agent runtime and history path use native SDK messages as the canonical source instead of transcript re-projection and synthetic SDK message rebuilding.

**Architecture:** Keep the existing Tauri RPC surface, preserve current streaming behavior, and make the sidecar version store the canonical persisted source for raw SDK turn messages. Derive UI-facing `AgentMessage` records from those persisted SDK messages and only fall back to legacy transcript projection for old sessions that do not yet have version-store data.

**Tech Stack:** Bun, TypeScript, Tauri sidecar, `@lume/agent-sdk`, existing agent/web test suites

---

## Chunk 1: Runtime Message Shape

### Task 1: Canonicalize Persisted SDK Turn Messages

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Modify: `apps/sidecar/src/services/agent/agent-session-manager.ts`
- Test: `apps/sidecar/src/services/agent/agent-session-manager.merge-turns.test.ts`

- [ ] Add a failing test that asserts existing version-store SDK history survives even when the legacy transcript is empty.
- [ ] Run the targeted session-manager test to verify it fails for the expected reason.
- [ ] Persist the current assistant turn directly from raw SDK messages emitted during execution.
- [ ] Make history reads prefer persisted version-store data over legacy transcript re-projection.
- [ ] Re-run the targeted session-manager test to verify it passes.

## Chunk 2: History Canonical Source

### Task 2: Preserve Legacy Fallback Behavior

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-session-manager.ts`
- Test: `apps/sidecar/src/services/agent/agent-message-versioning-service.test.ts`

- [ ] Run version-store tests to confirm canonical history reads do not break version chains.
- [ ] Keep transcript projection as a legacy fallback for sessions without canonical version-store messages.

## Chunk 3: UI Compatibility Guard

### Task 3: Document the Streaming Constraint

**Files:**
- Modify: `docs/superpowers/plans/2026-04-08-agent-sdk-nativeization.md`

- [ ] Record that `@lume/agent-sdk` currently emits `stream_event` only when `includePartialMessages=true`, so removing that flag must be coordinated with SDK changes.

## Chunk 4: Verification

### Task 4: Regression Verification

**Files:**
- Test: `apps/sidecar/src/services/agent/agent-session-manager.merge-turns.test.ts`
- Test: `apps/sidecar/src/services/agent/agent-message-versioning-service.test.ts`

- [ ] Run `bun run --filter @lume/sidecar typecheck`
- [ ] Run `bun test apps/sidecar/src/services/agent/agent-session-manager.merge-turns.test.ts`
- [ ] Run `bun test apps/sidecar/src/services/agent/agent-message-versioning-service.test.ts`
