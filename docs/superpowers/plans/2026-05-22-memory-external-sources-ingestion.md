# Memory External Sources Ingestion Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working version of Lume external-source memory ingestion with a generic ingestion core and a few small adapters.

**Architecture:** External sources become `MemoryIngestionSource` objects, then flow through one ingestion function that chunks text, calls the existing Memory V2 LLM extraction, and writes through `smartAddMemoryV2Candidate`. History, pasted text, and workspace text files are adapters over the same core, so no second memory system is introduced.

**Tech Stack:** TypeScript, Bun tests, existing Lume sidecar RPC, existing Memory V2 Markdown store, existing React settings UI.

---

## File Structure

- Create `apps/sidecar/src/services/memory-v2/ingestion.ts`
  - Owns `MemoryIngestionSource`, chunking, ingestion result aggregation, and evidence attachment.
- Modify `apps/sidecar/src/services/memory-v2/history-organizer.ts`
  - Becomes a history adapter that collects user messages and delegates to `ingestMemorySources`.
- Test `apps/sidecar/src/services/memory-v2/ingestion.test.ts`
  - Covers pasted text, workspace files, evidence, duplicate behavior, and unsupported files.
- Modify `packages/shared/src/types/memory.ts`
  - Add generic ingestion input/result types and IPC channel.
- Modify `apps/sidecar/src/rpc/schemas.ts`
  - Add schema for text and workspace-file ingestion.
- Modify `apps/sidecar/src/rpc/memory-handlers.ts`
  - Add RPC handler that calls the ingestion adapters.
- Modify `apps/sidecar/src/rpc/memory-handlers.test.ts`
  - Cover new IPC route validation/dispatch.
- Modify `apps/web/src/lib/desktop-api/memory.ts`
  - Add `ingestMemorySources` desktop API.
- Modify `apps/web/src/components/settings/memory-settings-state.ts`
  - Generalize result summary so history and external ingestion use the same wording.
- Modify `apps/web/src/components/settings/MemorySettings.tsx`
  - Add "外部资料" card with pasted text and workspace file path input.
- Test `apps/web/src/components/settings/memory-settings-state.test.ts`
  - Cover generic ingestion summary.

## Chunk 1: Sidecar Ingestion Core

### Task 1: Add Generic Ingestion Core

**Files:**
- Create: `apps/sidecar/src/services/memory-v2/ingestion.ts`
- Test: `apps/sidecar/src/services/memory-v2/ingestion.test.ts`

- [ ] **Step 1: Write failing tests for pasted text ingestion**

Create a test that builds a `MemoryIngestionSource` with `kind: "pasted_text"` and content `叫我 Mason`, then calls `ingestMemorySources`.

Expected assertions:

- `scannedSources` is `1`.
- `scannedChunks` is `1`.
- `candidateCount` is `1`.
- `actions.new` is `1`.
- the written entry has claim `user/self preferred_name Mason`.
- the entry evidence includes the source ref.

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/ingestion.test.ts
```

Expected: FAIL because `ingestion.ts` does not exist.

- [ ] **Step 2: Implement minimal ingestion core**

Implement:

- `MemoryIngestionSource`
- `MemoryIngestionInput`
- `MemoryIngestionResult`
- `ingestMemorySources(input)`
- deterministic text chunking with a simple max size.

The core must call:

- `extractMemoryCandidatesWithLlm`
- `smartAddMemoryV2Candidate`

It must attach `sourcePaths`, `sourceMessages`, and `recordIds` to each candidate evidence.

- [ ] **Step 3: Run sidecar ingestion test**

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/ingestion.test.ts
```

Expected: PASS.

### Task 2: Add Workspace File Adapter

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/ingestion.ts`
- Test: `apps/sidecar/src/services/memory-v2/ingestion.test.ts`

- [ ] **Step 1: Write failing workspace-file test**

Create a workspace resource file such as `docs/project.md`, call `ingestWorkspaceMemoryFiles`, and assert:

- unsupported files are skipped with a readable item reason.
- supported `.md` file is read and ingested.
- result item source path is the workspace-relative file path.

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/ingestion.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 2: Implement workspace-file adapter**

Add:

- `ingestWorkspaceMemoryFiles({ workspaceSlug, paths })`
- supported extensions: `.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`
- read using existing `readWorkspacePath`.

Do not parse binary documents or recurse directories in this phase.

- [ ] **Step 3: Run sidecar ingestion tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/ingestion.test.ts apps/sidecar/src/services/memory-v2/history-organizer.test.ts
```

Expected: PASS.

### Task 3: Delegate History Organizer To Core

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/history-organizer.ts`
- Test: `apps/sidecar/src/services/memory-v2/history-organizer.test.ts`

- [ ] **Step 1: Update history tests if needed**

Existing tests should continue to express behavior, not implementation.

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/history-organizer.test.ts
```

Expected: PASS before refactor.

- [ ] **Step 2: Refactor history organizer**

Convert collected messages to `MemoryIngestionSource` objects and call `ingestMemorySources`.

Keep the public `organizeMemoryHistory(input)` API returning the existing history result shape for compatibility.

- [ ] **Step 3: Run history and ingestion tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/ingestion.test.ts apps/sidecar/src/services/memory-v2/history-organizer.test.ts
```

Expected: PASS.

## Chunk 2: Shared Types And RPC

### Task 4: Add Shared Ingestion API

**Files:**
- Modify: `packages/shared/src/types/memory.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/memory-handlers.ts`
- Modify: `apps/sidecar/src/rpc/memory-handlers.test.ts`
- Modify: `apps/web/src/lib/desktop-api/memory.ts`

- [ ] **Step 1: Write failing RPC test**

Add a test proving `MEMORY_IPC_CHANNELS.INGEST_SOURCES` dispatches to the ingestion service with pasted text.

Run:

```bash
rtk bun test apps/sidecar/src/rpc/memory-handlers.test.ts
```

Expected: FAIL because the channel/schema do not exist.

- [ ] **Step 2: Add shared types and channel**

Add:

- `MemoryIngestSourcesInput`
- `MemoryIngestSourcesResult`
- reusable result item/action counts if possible.
- `MEMORY_IPC_CHANNELS.INGEST_SOURCES`

Prefer reusing existing organize action counts instead of creating parallel count names.

- [ ] **Step 3: Add schema and handler**

Schema accepts:

- `workspaceSlug`
- `sources`
- source items with `kind: "pasted_text" | "workspace_file"`
- pasted text `title/content/targetScope`
- workspace file `path/targetScope`

Handler calls the ingestion adapter.

- [ ] **Step 4: Add desktop API**

Add `ingestMemorySources(input)` to `apps/web/src/lib/desktop-api/memory.ts`.

- [ ] **Step 5: Run RPC tests**

Run:

```bash
rtk bun test apps/sidecar/src/rpc/memory-handlers.test.ts apps/sidecar/src/rpc/create-rpc-handlers.test.ts
```

Expected: PASS.

## Chunk 3: Settings UI

### Task 5: Add External Sources Card

**Files:**
- Modify: `apps/web/src/components/settings/memory-settings-state.ts`
- Modify: `apps/web/src/components/settings/memory-settings-state.test.ts`
- Modify: `apps/web/src/components/settings/MemorySettings.tsx`

- [ ] **Step 1: Write failing summary test**

Add a summary test for a generic ingestion result:

- scanned 2 sources
- processed 2 chunks
- extracted 3 candidates
- wrote 1
- duplicate 1
- pending 1

Run:

```bash
rtk bun test apps/web/src/components/settings/memory-settings-state.test.ts
```

Expected: FAIL because the generic summary does not exist.

- [ ] **Step 2: Implement summary helper**

Add a generic summary helper and keep `summarizeMemoryOrganizeResult` working.

- [ ] **Step 3: Wire Memory Settings UI**

Add an "外部资料" card that supports:

- pasted text import with textarea.
- workspace file relative path input.
- action buttons using `ingestMemorySources`.
- result summary.

Keep it compact and consistent with existing settings styling.

- [ ] **Step 4: Run web settings tests**

Run:

```bash
rtk bun test apps/web/src/components/settings/memory-settings-state.test.ts
```

Expected: PASS.

## Final Verification

- [ ] Run Memory V2 service tests:

```bash
rtk bun test apps/sidecar/src/services/memory-v2
```

- [ ] Run relevant RPC tests:

```bash
rtk bun test apps/sidecar/src/rpc/memory-handlers.test.ts apps/sidecar/src/rpc/create-rpc-handlers.test.ts
```

- [ ] Run relevant web settings tests:

```bash
rtk bun test apps/web/src/components/settings/memory-settings-state.test.ts
```

- [ ] Run targeted typechecks if public types changed:

```bash
rtk bun run --filter @lume/sidecar typecheck
rtk bun run --filter @lume/web typecheck
```

- [ ] Run whitespace check:

```bash
rtk git diff --check
```
