# Thread plan.md Approval Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plan approval use a thread-workspace Markdown plan contract, with reliable preview/open behavior and rejection feedback routed back to planning.

**Architecture:** Treat `planFilePath` as a thread-workspace relative path. `TaskContractWrite` persists `planMarkdown` into the thread workspace, reads it back for verification, then creates the approval request; sidecar file reads/opening resolve relative thread paths safely; web plan previews open thread file tabs; rejection feedback enqueues a planning-mode agent turn instead of only returning the feedback.

**Tech Stack:** TypeScript, Bun tests, existing sidecar RPC/file services, React/Jotai web UI, no new dependencies.

---

## Files

- Modify: `apps/sidecar/src/services/agent/agent-files-service.ts`
  - Resolve relative thread/workspace paths against their safe roots.
- Modify: `apps/sidecar/src/services/agent/agent-files-service.test.ts`
  - Cover relative thread plan file reads and traversal rejection.
- Modify: `apps/sidecar/src/services/agent-runtime/plan/task-contract-write-tool.ts`
  - Update tool prompt to require `planMarkdown`, write and verify Markdown plans, and validate relative `planFilePath`.
- Modify: `apps/sidecar/src/services/agent-runtime/plan/task-contract-write-tool.test.ts`
  - Cover Markdown plan persistence, stored relative `planFilePath`, and invalid path rejection.
- Create: `apps/sidecar/src/services/agent-runtime/plan/plan-markdown-file-service.ts`
  - Centralize safe relative plan file normalization and Markdown file writes.
- Modify: `apps/sidecar/src/services/agent-runtime/plan/task-contract-fallback-service.ts`
  - Persist fallback planning replies as Markdown plan files when a thread workspace is available.
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
  - Pass the thread workspace directory into `TaskContractWrite` for workspace-backed plan sessions.
- Modify: `apps/sidecar/src/services/agent/prompt/sections/interaction-policy-sections.ts`
  - Tell plan-mode agents to provide `planMarkdown` through `TaskContractWrite` and report the verified path to users.
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
  - Route reject feedback back to agent in plan mode and persist fallback plan replies into thread plan files.
- Modify: `apps/sidecar/src/rpc/agent-handlers.run-events.test.ts`
  - Cover reject feedback dispatch.
- Modify: `apps/web/src/components/tabs/file-tabs.ts`
  - Add a small helper for thread plan tabs.
- Modify: `apps/web/src/components/tabs/file-tabs.test.ts`
  - Cover thread plan tab identity.
- Modify: `apps/web/src/components/agent/AgentView.tsx`
  - Auto-open plan files as thread file tabs.
- Modify: `apps/web/src/components/agent/TaskApprovalBanner.tsx`
  - Wire `查看计划` to the same open behavior and show the verified Markdown path.

## Tasks

### Task 1: Sidecar path and TaskContractWrite contract

- [x] Add failing tests for relative thread file reads and bad `planFilePath`.
- [x] Add failing tests for `planMarkdown` persistence into the thread workspace.
- [x] Add failing tests that block approval without a verified Markdown plan.
- [x] Implement safe relative path resolution, `planFilePath` validation, controlled Markdown plan writes, and read-back verification.
- [x] Run focused sidecar tests.

### Task 2: Rejection feedback re-planning

- [x] Add failing RPC test for rejecting with feedback.
- [x] Implement minimal appendAgentMessage call in plan mode.
- [x] Run focused RPC test.

### Task 3: Web thread plan preview

- [x] Add failing file-tab test for thread plan tabs.
- [x] Implement helper and wire AgentView/TaskApprovalBanner.
- [x] Run focused web file-tab test.

### Task 4: Final focused verification

- [x] Run sidecar plan/file/RPC tests touched in this change.
- [x] Run web file-tab test.
- [x] Update final report with changed files, simplifications, and risks.
