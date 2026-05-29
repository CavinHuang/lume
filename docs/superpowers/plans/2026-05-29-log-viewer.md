# Log Viewer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings log viewer and improve redacted diagnostic log collection across Lume runtime paths.

**Architecture:** Reuse the existing sidecar logger and log directory. Add a focused log service plus RPC methods for list/read/export/open, then consume them from a new Settings tab. Add small logging helpers at runtime boundaries instead of creating a second diagnostics store.

**Tech Stack:** Bun tests, TypeScript, React, Tauri sidecar RPC, existing `@lume/shared` IPC constants.

---

## Chunk 1: Sidecar Log Access

### Task 1: Log Service

**Files:**
- Create: `apps/sidecar/src/services/infra/log-viewer-service.ts`
- Test: `apps/sidecar/src/services/infra/log-viewer-service.test.ts`
- Modify: `packages/shared/src/types/general-settings.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/system-handlers.ts`

- [ ] Write failing tests for listing `.log` files, reading lines with search/level filters, and exporting all logs.
- [ ] Implement minimal service functions.
- [ ] Add shared IPC channel constants and result/input interfaces.
- [ ] Wire schemas and system handlers.
- [ ] Run focused sidecar tests.

## Chunk 2: Redacted Runtime Logging

### Task 2: Diagnostic Logging Helpers

**Files:**
- Modify: `apps/sidecar/src/services/infra/logger.ts`
- Test: `apps/sidecar/src/services/infra/logger.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime-wrapper.ts`
- Modify: `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`
- Modify: `apps/sidecar/src/services/agent/agent-workspace-manager.ts`
- Modify as needed: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`

- [ ] Write failing tests for sensitive-key redaction and log summary truncation.
- [ ] Export a small redaction/summarization helper from the logger module.
- [ ] Add tool start/finish/error logs with summaries.
- [ ] Add MCP connection/status logs at existing manager boundaries.
- [ ] Convert skill load parse/copy/delete console logs to logger calls.
- [ ] Run focused sidecar tests.

## Chunk 3: Settings UI

### Task 3: Log Viewer UI

**Files:**
- Create: `apps/web/src/components/settings/LogSettings.tsx`
- Modify: `apps/web/src/lib/desktop-api/system.ts`
- Modify: `apps/web/src/components/settings/settings-view-state.ts`
- Modify: `apps/web/src/components/settings/settings-view-state.test.ts`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`
- Modify: `apps/web/src/components/settings/SettingsView.test.ts`

- [ ] Write failing metadata tests for the `logs` tab.
- [ ] Add desktop API helpers for list/read/export/open.
- [ ] Add the new Settings tab and render `LogSettings`.
- [ ] Build the log file selector, level selector, search box, action buttons, and log body.
- [ ] Run focused web typecheck or build if TypeScript surface changed.

## Verification

- [ ] `rtk bun test apps/sidecar/src/services/infra/log-viewer-service.test.ts`
- [ ] `rtk bun test apps/sidecar/src/services/infra/logger.test.ts`
- [ ] `rtk bun test apps/web/src/components/settings/settings-view-state.test.ts apps/web/src/components/settings/SettingsView.test.ts`
- [ ] Targeted package typecheck only if the touched shared/API/UI types require it.
