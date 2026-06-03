# Agent Message Queue Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a sortable message queue for running agent threads, with queued-message guidance delivered before the next tool call.

**Architecture:** Reuse `AgentRuntimeKernel` as the normal per-thread queue owner. Add shared queue snapshots and RPC handlers, keep pending guidance in an in-memory runtime store, and consume guidance at `createCanUseToolHandler` before authorizing a tool. The web composer renders the queue snapshot and calls queue RPC operations.

**Tech Stack:** TypeScript, Bun tests, React, Jotai, Tauri IPC, existing Lume sidecar runtime.

---

## File Structure

- Modify `packages/shared/src/types/agent.ts`: queue IPC channels, queue snapshot types, operation result types.
- Modify `packages/shared/src/types/runtime-event.ts`: add `guidance.delivered` runtime event.
- Modify `apps/sidecar/src/rpc/schemas.ts`: queue operation input schemas.
- Modify `apps/sidecar/src/rpc/agent-handlers.ts`: list/reorder/remove/promote queue handlers.
- Modify `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts`: stable queue item IDs and queue operations.
- Modify `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`: kernel queue operation tests.
- Create `apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.ts`: pending guidance storage and consumption.
- Create `apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts`: guidance store tests.
- Modify `apps/sidecar/src/services/agent/agent-service.ts`: queue snapshot mapping, notifications, promote/fallback helpers.
- Modify `apps/sidecar/src/services/agent/agent-service.test.ts`: queued metadata and guidance promotion tests.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`: consume guidance before a tool call.
- Create or modify `apps/sidecar/src/services/agent-runtime/runtime-core/attempt-guidance.test.ts`: tool-boundary guidance test if existing attempt tests are too broad.
- Modify `apps/web/src/atoms/agent-atoms.ts`: `agentMessageQueueAtom`.
- Modify `apps/web/src/lib/desktop-api/agent.ts`: queue RPC wrappers.
- Modify `apps/web/src/hooks/useGlobalAgentListeners.ts`: apply `MESSAGE_QUEUE_CHANGED`.
- Create `apps/web/src/components/agent/agent-message-queue-state.ts`: reorder and queue notification helpers.
- Create `apps/web/src/components/agent/agent-message-queue-state.test.ts`: pure queue helper tests.
- Create `apps/web/src/components/agent/AgentMessageQueueList.tsx`: compact queue list with native drag/drop.
- Modify `apps/web/src/components/agent/agent-input-state.ts`: submit-mode helper for running queue state.
- Modify `apps/web/src/components/agent/agent-input-state.test.ts`: submit-mode tests.
- Modify `apps/web/src/components/agent/AgentInput.tsx`: render queue, allow queued sends while streaming, promote/remove/reorder actions.

## Chunk 1: Shared Types And Kernel Queue

### Task 1: Shared Queue Contract

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/types/runtime-event.ts`

- [x] **Step 1: Add shared type expectations through TypeScript usage**

Use the sidecar/web tests below as the executable contract; no separate shared test file is needed because shared has no test runner script.

- [x] **Step 2: Add queue snapshot and guidance event types**

Add `AgentQueuedMessage`, `AgentPendingGuidance`, `AgentMessageQueueSnapshot`, operation inputs/results, `MESSAGE_QUEUE_CHANGED`, `LIST_MESSAGE_QUEUE`, `REORDER_MESSAGE_QUEUE`, `REMOVE_QUEUED_MESSAGE`, and `PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE`.

- [x] **Step 3: Verify shared typecheck**

Run: `bun run --filter @lume/shared typecheck`

Expected: Typecheck passes.

### Task 2: Kernel Queue Operations

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts`

- [x] **Step 1: Write failing tests**

Add tests that:

- queued dispatch results include a stable queued item id and text;
- `listQueued(threadId)` returns queued items in order;
- `reorderQueued(threadId, orderedIds)` changes execution order;
- `removeQueued(threadId, id)` prevents that queued dispatch from running and returns it;
- `prependQueuedDispatches(threadId, dispatches)` restores items to the front.

- [x] **Step 2: Run RED**

Run: `bun test apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`

Expected: FAIL because queue operation methods do not exist.

- [x] **Step 3: Implement minimal kernel queue operations**

Add queue item metadata and queue operations without changing active dispatch execution semantics.

- [x] **Step 4: Run GREEN**

Run: `bun test apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts`

Expected: PASS.

## Chunk 2: Sidecar Queue RPC And Guidance

### Task 3: Guidance Store

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.ts`
- Create: `apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts`

- [x] **Step 1: Write failing tests**

Test adding guidance, listing pending guidance, consuming all guidance text in click order, and draining unconsumed guidance dispatches for fallback.

- [x] **Step 2: Run RED**

Run: `bun test apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts`

Expected: FAIL because the store file does not exist.

- [x] **Step 3: Implement store**

Implement in-memory maps keyed by thread ID. Store enough dispatch data for fallback, but expose only UI-safe `pendingGuidance` snapshots.

- [x] **Step 4: Run GREEN**

Run: `bun test apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts`

Expected: PASS.

### Task 4: Agent Service Queue API

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-service.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`

- [x] **Step 1: Write failing tests**

Add tests that:

- `appendAgentMessage` returns `queuedMessage` metadata for queued dispatches;
- `listAgentMessageQueue(threadId)` shows queued messages before they run;
- `reorderAgentMessageQueue(threadId, orderedIds)` changes later execution order;
- `removeQueuedAgentMessage(threadId, queuedMessageId)` removes a pending item;
- `promoteQueuedAgentMessageToGuidance(threadId, queuedMessageId)` removes the item from the normal queue and exposes pending guidance;
- unconsumed guidance is restored to the queue front when fallback is requested.

- [x] **Step 2: Run RED**

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts`

Expected: FAIL on missing queue API exports and metadata.

- [x] **Step 3: Implement service APIs**

Map kernel queue items to shared snapshots. Emit `MESSAGE_QUEUE_CHANGED` through `emitAgentNotification`. Restore unconsumed guidance before an active dispatch exits.

- [x] **Step 4: Run GREEN**

Run: `bun test apps/sidecar/src/services/agent/agent-service.test.ts`

Expected: PASS.

### Task 5: Queue RPC Handlers

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

- [x] **Step 1: Write failing RPC test**

Update `create-rpc-handlers.test.ts` to expect the new queue IPC methods in `rpc:list-methods`.

- [x] **Step 2: Run RED**

Run: `bun test apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

Expected: FAIL because new methods are missing.

- [x] **Step 3: Add schemas and handlers**

Add queue operation schemas and wire handlers to the agent service queue API.

- [x] **Step 4: Run GREEN**

Run: `bun test apps/sidecar/src/rpc/create-rpc-handlers.test.ts`

Expected: PASS.

### Task 6: Tool-Boundary Guidance Consumption

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`
- Test: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt-observability.test.ts` or new focused test if needed.

- [x] **Step 1: Write failing test**

Test that when pending guidance exists for a thread, `createCanUseToolHandler` returns a deny result with the guidance text before ordinary authorization, emits `guidance.delivered`, and consumes the guidance.

- [x] **Step 2: Run RED**

Run the focused attempt test file.

Expected: FAIL because guidance is not consumed.

- [x] **Step 3: Implement guidance consumption**

Before descriptor lookup/authorization, call the guidance store. If guidance exists, emit `guidance.delivered` and return a deny message instructing the model to reconsider before the tool executes.

- [x] **Step 4: Run GREEN**

Run the focused attempt test file.

Expected: PASS.

## Chunk 3: Web Queue State And Composer

### Task 7: Queue Atoms And Listeners

**Files:**
- Modify: `apps/web/src/atoms/agent-atoms.ts`
- Modify: `apps/web/src/lib/desktop-api/agent.ts`
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`
- Create: `apps/web/src/components/agent/agent-message-queue-state.ts`
- Create: `apps/web/src/components/agent/agent-message-queue-state.test.ts`

- [x] **Step 1: Write failing helper tests**

Test applying snapshots, optimistic reorder, and rollback behavior in `agent-message-queue-state.test.ts`.

- [x] **Step 2: Run RED**

Run: `bun test apps/web/src/components/agent/agent-message-queue-state.test.ts`

Expected: FAIL because helper file does not exist.

- [x] **Step 3: Implement helpers, atom, IPC wrappers, listener case**

Use shared queue snapshot types. Add `MESSAGE_QUEUE_CHANGED` handling in `useGlobalAgentListeners`.

- [x] **Step 4: Run GREEN**

Run: `bun test apps/web/src/components/agent/agent-message-queue-state.test.ts`

Expected: PASS.

### Task 8: Composer Queue UI

**Files:**
- Modify: `apps/web/src/components/agent/agent-input-state.ts`
- Modify: `apps/web/src/components/agent/agent-input-state.test.ts`
- Create: `apps/web/src/components/agent/AgentMessageQueueList.tsx`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [x] **Step 1: Write failing submit-mode tests**

Add tests for `deriveAgentInputSubmitState`:

- idle with text => send;
- streaming without text => stop;
- streaming with text => queue;
- local sending => busy.

- [x] **Step 2: Run RED**

Run: `bun test apps/web/src/components/agent/agent-input-state.test.ts`

Expected: FAIL because helper does not exist.

- [x] **Step 3: Implement submit-mode helper**

Keep helper pure and small.

- [x] **Step 4: Run GREEN**

Run: `bun test apps/web/src/components/agent/agent-input-state.test.ts`

Expected: PASS.

- [x] **Step 5: Implement queue list and AgentInput integration**

Load queue snapshot on thread change, render queued messages above the editor, wire native drag/drop reorder, delete, and `引导`. Allow queued sends while streaming; only emit optimistic user runtime events when dispatch result is `sent`.

- [x] **Step 6: Run focused web tests**

Run:

```bash
bun test apps/web/src/components/agent/agent-input-state.test.ts apps/web/src/components/agent/agent-message-queue-state.test.ts
```

Expected: PASS.

## Final Verification

- [x] Run sidecar focused tests:

```bash
bun test \
  apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.test.ts \
  apps/sidecar/src/services/agent-runtime/guidance/run-guidance-store.test.ts \
  apps/sidecar/src/services/agent/agent-service.test.ts \
  apps/sidecar/src/rpc/create-rpc-handlers.test.ts
```

- [x] Run web focused tests:

```bash
bun test \
  apps/web/src/components/agent/agent-input-state.test.ts \
  apps/web/src/components/agent/agent-message-queue-state.test.ts
```

- [x] Run targeted typechecks if implementation touches shared API surface:

```bash
bun run --filter @lume/shared typecheck
bun run --filter @lume/sidecar typecheck
bun run --filter @lume/web typecheck
```

Only run broader checks if these focused checks expose cross-module breakage.
