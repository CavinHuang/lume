# Thread Workspace File Attachment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the agent side-panel file area so both `当前线程文件` and `工作区共享文件` tabs support attaching files/folders, show lightweight `外部附加` provenance, and let workspace resources be attached into the current thread without changing the existing two-tab mental model.

**Architecture:** Extend the shared file-entry contract and sidecar file services so thread/workspace listings can surface external-attachment metadata plus a new “attach workspace resource to thread” action. Then replace the current upload-only `FileDropZone` with a tab-aware attachment panel in web, keep the existing tree views, and add small provenance + quick-action affordances without introducing a separate permissions system.

**Tech Stack:** React, TypeScript, Bun test, sidecar RPC/Zod, Tauri desktop dialogs

---

## File Structure

## Chunk 1: Shared Contracts + Sidecar File Operations

### Create
- `apps/sidecar/src/services/agent/agent-attachment-meta-service.ts` — persist/read attachment provenance for thread/workspace paths
- `apps/sidecar/src/services/agent/agent-attachment-meta-service.test.ts` — provenance persistence + path-sync tests

### Modify
- `packages/shared/src/types/agent.ts` — enrich `FileEntry`, add attach-to-workspace/thread payloads, and provenance types
- `apps/sidecar/src/services/agent/agent-files-service.ts` — save/list/copy/promote flows with provenance metadata and workspace-to-thread attach support
- `apps/sidecar/src/services/agent/agent-files-service.test.ts` — regression coverage for folder attach + metadata sync
- `apps/sidecar/src/services/agent/agent-file-promotion-service.ts` — reuse shared copy/provenance helpers instead of standalone file-only promotion logic
- `apps/sidecar/src/rpc/schemas.ts` — add new Zod schemas for workspace attach and folder attach flows
- `apps/sidecar/src/rpc/agent-handlers.ts` — expose new RPC endpoints and return enriched `FileEntry[]`
- `apps/sidecar/src/rpc/agent-handlers.files.test.ts` — RPC coverage for enriched list responses and workspace-to-thread attach

### Verification
- `bun test apps/sidecar/src/services/agent/agent-attachment-meta-service.test.ts`
- `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts`
- `bun test apps/sidecar/src/rpc/agent-handlers.files.test.ts`
- `bun run --filter @lume/sidecar build`

## Chunk 2: Web File Panel Redesign

### Create
- `apps/web/src/components/file-browser/AttachmentPanel.tsx` — tab-aware bottom attachment card with file/folder actions
- `apps/web/src/components/file-browser/file-entry-meta.ts` — pure helpers for provenance badge/tooltip/action derivation
- `apps/web/src/components/file-browser/file-entry-meta.test.ts` — UI logic tests for badge/tooltip/action visibility

### Modify
- `apps/web/src/components/agent/SidePanel.tsx` — keep two tabs but mount the new attachment panel in both tab bodies
- `apps/web/src/components/file-browser/FileBrowser.tsx` — render empty-state copy, `外部附加` badge, tooltip, and per-item actions for thread entries
- `apps/web/src/components/file-browser/WorkspaceFileBrowser.tsx` — same as thread tree plus `附加到当前线程` action
- `apps/web/src/lib/desktop-api/agent.ts` or existing desktop-api exports — add helpers for new RPC calls

### Delete
- `apps/web/src/components/file-browser/FileDropZone.tsx` — superseded by the new tab-aware `AttachmentPanel`

### Verification
- `bun test apps/web/src/components/file-browser/file-entry-meta.test.ts`
- `bun run --filter @lume/web build`

---

## Chunk 1: Shared Contracts + Sidecar File Operations

### Task 1: Add shared attachment metadata and attach-action contracts

**Files:**
- Modify: `packages/shared/src/types/agent.ts`

- [ ] **Step 1: Define the contract surface in shared types**

Update `packages/shared/src/types/agent.ts` so the target shapes are explicit in production types:

```ts
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
  externalAttachment?: {
    label: "外部附加"
    absoluteSourcePath: string
  }
}

export interface AttachWorkspaceResourceToThreadInput {
  workspaceSlug: string
  threadId: string
  sourcePath: string
}
```

Include:
- optional `externalAttachment` metadata on `FileEntry`
- a dedicated `ExternalAttachmentMeta` shared type
- payload/result types for:
  - attaching a workspace resource into a thread
  - copying a folder into a workspace
  - any new RPC channel names needed for the above

Keep field names DRY across shared/web/sidecar by reusing `absoluteSourcePath` everywhere.

- [ ] **Step 2: Run shared typecheck/build surface verification**

Run: `bun run --filter @lume/shared typecheck`

Expected: exit `0`

---

### Task 2: Persist provenance for externally attached files and folders

**Files:**
- Create: `apps/sidecar/src/services/agent/agent-attachment-meta-service.ts`
- Create: `apps/sidecar/src/services/agent/agent-attachment-meta-service.test.ts`

- [ ] **Step 1: Write the failing provenance tests**

Create tests covering:

```ts
test("records external attachment metadata for a thread target path", ...)
test("records external attachment metadata for a workspace target path", ...)
test("rename and move keep metadata aligned with the new target path", ...)
test("delete removes stale metadata entry", ...)
```

Use temp `LUME_CONFIG_DIR` fixtures like the existing `agent-files-service.test.ts`.

- [ ] **Step 2: Run the new test and confirm failure**

Run: `bun test apps/sidecar/src/services/agent/agent-attachment-meta-service.test.ts`

Expected: fail because the service does not exist yet.

- [ ] **Step 3: Implement the metadata service**

Create `apps/sidecar/src/services/agent/agent-attachment-meta-service.ts` with small focused helpers:

```ts
readThreadAttachmentMeta(workspaceSlug, threadId)
readWorkspaceAttachmentMeta(workspaceSlug)
upsertAttachmentMeta(scope, targetPath, meta)
moveAttachmentMeta(scope, fromPath, toPath)
deleteAttachmentMeta(scope, targetPath)
getAttachmentMeta(scope, targetPath)
```

Store metadata outside the visible file tree, for example under a hidden sidecar-managed JSON file per thread/workspace scope. Keep the storage detail encapsulated inside this service so later planning can change it without touching UI code.

- [ ] **Step 4: Re-run the provenance test**

Run: `bun test apps/sidecar/src/services/agent/agent-attachment-meta-service.test.ts`

Expected: exit `0`

---

### Task 3: Make thread/workspace save/copy flows attach files and folders with provenance

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-files-service.ts`
- Modify: `apps/sidecar/src/services/agent/agent-files-service.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-file-promotion-service.ts`

- [ ] **Step 1: Add failing service tests for new attach flows**

Extend `apps/sidecar/src/services/agent/agent-files-service.test.ts` with cases for:

```ts
test("saveFilesToWorkspace records external attachment metadata", ...)
test("saveFilesToAgentSession records external attachment metadata", ...)
test("copyFolderToThread copies a folder and records external attachment metadata on the folder root", ...)
test("copyFolderToWorkspace copies a folder and records external attachment metadata on the folder root", ...)
test("listAgentDirectory returns FileEntry.externalAttachment for externally attached entries only", ...)
test("listWorkspaceDirectory returns FileEntry.externalAttachment for externally attached entries only", ...)
test("renameAgentFile keeps external attachment metadata aligned with the new path", ...)
test("moveWorkspaceFile keeps external attachment metadata aligned with the new path", ...)
test("deleteAgentFile removes external attachment metadata", ...)
```

- [ ] **Step 2: Run the focused service tests and verify failure**

Run: `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts`

Expected: fail on the new attachment metadata expectations.

- [ ] **Step 3: Implement folder attach + enriched list responses**

Update `agent-files-service.ts` to:
- reuse shared copy helpers for thread/workspace folder attaches
- write `ExternalAttachmentMeta` when the source is an external local path
- enrich `listAgentDirectory` / `listWorkspaceDirectory` to merge provenance metadata into each `FileEntry`
- keep Agent-generated files untagged by only reading persisted external metadata instead of inferring from filesystem location

If the current `copyFolderToSession` name becomes misleading, introduce `copyFolderToThread`/`copyFolderToWorkspace` wrappers and keep old names as aliases only where needed.

- [ ] **Step 4: Align promotion/attach helpers**

Refactor `agent-file-promotion-service.ts` so provenance-aware copy logic lives in one place. Promotion into workspace should not accidentally inherit `外部附加` unless the original thread entry was explicitly external.

- [ ] **Step 5: Wire metadata sync into rename/move/delete operations**

Update the real file-operation paths in `agent-files-service.ts` so:
- `renameAgentFile` / `renameWorkspaceFile` call the provenance move helper
- `moveAgentFile` / `moveWorkspaceFile` call the provenance move helper
- `deleteAgentFile` / `deleteWorkspaceFile` remove any stored external-attachment metadata for the deleted path root

Do not leave provenance sync only inside the metadata service tests; the live file operations must invoke it.

- [ ] **Step 6: Re-run service tests**

Run: `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts`

Expected: exit `0`

---

### Task 4: Expose workspace-to-thread attach and enriched file listings over RPC

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.files.test.ts`

- [ ] **Step 1: Add failing RPC tests**

Extend `apps/sidecar/src/rpc/agent-handlers.files.test.ts` with:

```ts
test("LIST_DIRECTORY returns externalAttachment metadata for externally attached thread entries", ...)
test("LIST_WORKSPACE_DIRECTORY returns externalAttachment metadata for externally attached workspace entries", ...)
test("ATTACH_WORKSPACE_RESOURCE_TO_THREAD copies a workspace file into the thread and preserves attach semantics", ...)
test("ATTACH_WORKSPACE_RESOURCE_TO_THREAD copies a workspace folder into the thread and preserves attach semantics", ...)
```

- [ ] **Step 2: Run the RPC tests and confirm failure**

Run: `bun test apps/sidecar/src/rpc/agent-handlers.files.test.ts`

Expected: fail because the new schema/handler/channel does not exist.

- [ ] **Step 3: Add schemas and handlers**

Update `schemas.ts` and `agent-handlers.ts` to add:
- folder attach input schemas if existing `open_folder_dialog` + copy-folder flow need dedicated endpoints
- a new workspace-to-thread attach RPC channel
- handler wiring that resolves `workspaceSlug`, copies the resource into the thread, and refreshes provenance correctly

Prefer copying for the first implementation so the thread write boundary stays simple and matches the approved spec.

- [ ] **Step 4: Re-run RPC + sidecar build verification**

Run:
- `bun test apps/sidecar/src/rpc/agent-handlers.files.test.ts`
- `bun run --filter @lume/sidecar build`

Expected: both exit `0`

---

### Task 5: Commit sidecar/shared chunk

**Files:**
- Modify: shared and sidecar files from Chunk 1

- [ ] **Step 1: Review the diff**

Run: `git diff -- packages/shared/src/types/agent.ts apps/sidecar/src/services/agent apps/sidecar/src/rpc`

Expected: only shared contract, provenance service, and file/RPC changes appear.

- [ ] **Step 2: Commit Chunk 1**

```bash
git add packages/shared/src/types/agent.ts apps/sidecar/src/services/agent apps/sidecar/src/rpc
git commit -m "✨ feat(sidecar,shared): 增强线程与工作区文件附加能力"
```

Expected: a new commit is created successfully with only Chunk 1 shared/sidecar files staged.

---

## Chunk 2: Web File Panel Redesign

### Task 6: Add pure UI helpers for badges, tooltips, and action visibility

**Files:**
- Create: `apps/web/src/components/file-browser/file-entry-meta.ts`
- Create: `apps/web/src/components/file-browser/file-entry-meta.test.ts`

- [ ] **Step 1: Write the failing UI helper tests**

Create tests for:

```ts
test("getExternalAttachmentBadge returns 外部附加 only when externalAttachment is present", ...)
test("getExternalAttachmentTooltip returns the absolute path for external attachments", ...)
test("workspace entries expose attach-to-thread action while thread entries do not", ...)
```

- [ ] **Step 2: Run the new helper tests and confirm failure**

Run: `bun test apps/web/src/components/file-browser/file-entry-meta.test.ts`

Expected: fail because the helper file does not exist.

- [ ] **Step 3: Implement the pure helpers**

Create `file-entry-meta.ts` with narrow helpers such as:

```ts
getExternalAttachmentBadge(entry)
getExternalAttachmentTooltip(entry)
canAttachWorkspaceEntryToThread(entry, tab)
getEmptyStateCopy(tab)
```

Keep rendering logic out of these helpers so they stay easy to test.

- [ ] **Step 4: Re-run the helper tests**

Run: `bun test apps/web/src/components/file-browser/file-entry-meta.test.ts`

Expected: exit `0`

---

### Task 7: Replace FileDropZone with a tab-aware AttachmentPanel

**Files:**
- Create: `apps/web/src/components/file-browser/AttachmentPanel.tsx`
- Modify: `apps/web/src/components/agent/SidePanel.tsx`
- Modify: `apps/web/src/lib/desktop-api/agent.ts` or the existing agent desktop-api module
- Delete: `apps/web/src/components/file-browser/FileDropZone.tsx`

- [ ] **Step 1: Extend pure helper coverage for attachment-panel copy**

Extend `apps/web/src/components/file-browser/file-entry-meta.test.ts` with one required case:

```ts
test("getEmptyStateCopy and attachment copy switch between thread and workspace wording", ...)
```

This test should lock the strings used by the bottom attachment panel so the UI copy remains deterministic even without a component harness.

- [ ] **Step 2: Implement AttachmentPanel**

Create `AttachmentPanel.tsx` with:
- title/description that switch by tab
- drag-and-drop support for files and folders
- two explicit buttons:
  - `附加文件`
  - `附加文件夹`
- upload state copy that names the destination scope

Use `openFileDialog` for file selection and existing `openFolderDialog` for folder selection. Route:
- thread tab → `agent:save-files-to-thread` / thread folder-copy RPC
- workspace tab → `agent:save-files-to-workspace` / workspace folder-copy RPC

- [ ] **Step 3: Mount AttachmentPanel in both tabs**

Update `SidePanel.tsx` so both tab bodies render:
- file tree
- new `AttachmentPanel`

Do not keep the old upload-only copy in workspace tab.

- [ ] **Step 4: Remove FileDropZone and swap imports fully**

Delete `apps/web/src/components/file-browser/FileDropZone.tsx` and update any remaining imports to point at `AttachmentPanel`. Do not keep a compatibility wrapper unless a concrete second caller is discovered during implementation and documented in the commit.

- [ ] **Step 5: Verify web build**

Run: `bun run --filter @lume/web build`

Expected: exit `0`

---

### Task 8: Render provenance badges, empty states, and workspace quick action in the tree views

**Files:**
- Modify: `apps/web/src/components/file-browser/FileBrowser.tsx`
- Modify: `apps/web/src/components/file-browser/WorkspaceFileBrowser.tsx`

- [ ] **Step 1: Add the failing UI logic assertions**

If there is still no component test harness, add/extend pure helper coverage so these render rules are locked:
- thread empty state copy mentions attaching file/folder to current thread
- workspace empty state copy mentions future reuse
- workspace item actions include `附加到当前线程`
- only external entries expose the `外部附加` badge + tooltip text

- [ ] **Step 2: Implement thread tree rendering updates**

Update `FileBrowser.tsx` to:
- use the new empty-state copy
- render an `外部附加` badge next to matching items
- show absolute source path in a tooltip/title on hover
- keep existing tree interaction intact

- [ ] **Step 3: Implement workspace tree rendering updates**

Update `WorkspaceFileBrowser.tsx` to:
- mirror the new badge/tooltip behavior
- add a lightweight `附加到当前线程` per-item action that calls the new RPC and refreshes both tabs
- keep browse/open behavior intact

- [ ] **Step 4: Verify targeted web logic and build**

Run:
- `bun test apps/web/src/components/file-browser/file-entry-meta.test.ts`
- `bun run --filter @lume/web build`

Expected: both exit `0`

---

### Task 9: End-to-end verification and cleanup

**Files:**
- Modify: any files touched in Chunk 2

- [ ] **Step 1: Run final focused verification**

Run:
- `bun test apps/sidecar/src/services/agent/agent-attachment-meta-service.test.ts`
- `bun test apps/sidecar/src/services/agent/agent-files-service.test.ts`
- `bun test apps/sidecar/src/rpc/agent-handlers.files.test.ts`
- `bun test apps/web/src/components/file-browser/file-entry-meta.test.ts`
- `bun run --filter @lume/sidecar build`
- `bun run --filter @lume/web build`

Expected: all exit `0`

- [ ] **Step 2: Manually sanity-check the UI flow**

Run:
- `bun run --filter @lume/web dev`

Expected:
- the web app starts without build-time errors
- the side panel still shows exactly two tabs: `线程` and `工作区共享`

Then manually verify:
- thread tab attaches files
- thread tab attaches folders
- workspace tab attaches files
- workspace tab attaches folders
- external attachments show the badge + absolute-path hover
- workspace items can be attached into the current thread
- Agent-generated files stay untagged

Record any gaps before claiming completion.

- [ ] **Step 3: Commit Chunk 2**

```bash
git add apps/web/src/components/file-browser apps/web/src/components/agent/SidePanel.tsx apps/web/src/lib/desktop-api
git commit -m "✨ feat(web): 重做线程与工作区文件附加面板"
```
