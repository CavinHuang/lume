# Lume Plugin Platform Phase 4B (Core) — PluginAuditLog Infrastructure + High-Value Event Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the plugin audit-log infrastructure (jsonl store with both append AND read — the read side doesn't exist anywhere today) + `GET_PLUGIN_AUDIT_LOG` RPC, and hook the 4 highest-value event types that close the Phase 4A security-audit loop: `sensitive_approval`, `sensitive_denial`, `capability_blocked`, `needs_review`. The other 4 ready-to-hook types (`diagnostic_recorded`, `hook_filtered`, `mcp_start_failed`, `command_tool_invalid`) + the plugin-detail UI land in a follow-up Plan B; the 5 `install`/`uninstall`/`enable`/`disable`/`permission_accept` types stay FUTURE (depend on the unimplemented PluginMarketService).

**Architecture:** A new sidecar module `plugin-audit-store.ts` owns `~/.lume/plugins-audit.jsonl` (path from a new `getPluginAuditPath()` in config-paths, mirroring `getLumeConfigAuditPath`). It exposes `appendPluginAuditEntry(event)` (atomic jsonl append, copying the `appendAuditEntry` pattern from lume-config-service) AND `readPluginAuditEntries({ pluginId?, limit? })` (the read side that doesn't exist for any audit log yet — tail-read the jsonl, parse, filter). `PluginAuditEvent` is defined in `@lume/shared` (13-type union, including the FUTURE ones so the type is complete). A `GET_PLUGIN_AUDIT_LOG` RPC channel + handler expose the read API to the web. The 4 hooks call `appendPluginAuditEntry` at their existing branch points: `attempt.ts` (Phase 4A's allow_always/deny/block branches) + `plugin-registry.ts` (hash-mismatch needs-review).

**Tech Stack:** TypeScript, Bun test, existing `appendAuditEntry` jsonl pattern, `AGENT_IPC_CHANNELS` + handler-map pattern.

---

## Scope

Implements the **audit-log core** (spec §8.3 PluginAuditEvent + §16.2 GET_PLUGIN_AUDIT_LOG RPC):

- `PluginAuditEvent` type (13-type union) + `GET_PLUGIN_AUDIT_LOG` channel + result types in `@lume/shared`.
- `getPluginAuditPath()` in config-paths + `plugin-audit-store.ts` (append + read).
- `GET_PLUGIN_AUDIT_LOG` handler.
- 4 event hooks: `sensitive_approval` + `sensitive_denial` + `capability_blocked` (attempt.ts) + `needs_review` (plugin-registry.ts).

**Out of scope (Plan B / FUTURE):**

- `diagnostic_recorded` (unified diagnostic interception in `buildAgentPluginList`), `hook_filtered`, `mcp_start_failed`, `command_tool_invalid` — Plan B.
- Plugin-detail audit UI (web) — Plan B.
- `install`/`uninstall`/`enable`/`disable`/`permission_accept` — FUTURE (need PluginMarketService + SET_PLUGIN_ENABLEMENT).
- **Dedup of `needs_review`** — Plan A emits one event per hash-mismatch occurrence per `PluginRegistry.list()` call (acceptable; audit logs may repeat; createdAt distinguishes). In-memory dedup is Plan B.

**Constraints:**

- **append must not throw into the call path.** Audit is observational; a write failure logs a warning but does NOT break the operation being audited (wrap in try/catch).
- **read is best-effort.** Malformed jsonl lines are skipped (not fatal). Missing file returns `[]`.
- **Do NOT modify the SDK normalizer** (`packages/sdk/src/plugins/normalized.ts`) — `command_tool_invalid` diagnostics surface via `diagnostic_recorded` in Plan B's unified interception, not by SDK writing audit.
- **Touch surface:** `packages/shared/src/types/` (new plugin-audit.ts + agent.ts channel), `config-paths.ts`, new `plugin-audit-store.ts` (+test), `agent-handlers.ts` (+test), `attempt.ts`, `plugin-registry.ts`. Do NOT touch `lume-config-service.ts` (it's the template, not a dependency), SDK, `permission-gate.ts`.
- Match style: 2-space indent, double quotes (sidecar/shared), no `any`, `bun:test`.

## Design Decisions

1. **Separate `plugins-audit.jsonl`, NOT the config audit.** `~/.lume/lume.audit.jsonl` is for lume.yaml config changes (different schema, `LumeConfigAuditEntry`). Plugin audit has its own schema (`PluginAuditEvent` with pluginId/type/metadata) and its own file. Keeps both queryable independently.

2. **Read side built from scratch.** `lume-config-service` only appends audit, never reads. Phase 4B must implement `readPluginAuditEntries` (read file → split lines → JSON.parse each → filter by pluginId → tail to limit). This is the infra heavy-lift; called by the RPC handler.

3. **13-type union includes FUTURE types.** The `PluginAuditEvent.type` union lists all 13 (install/uninstall/enable/disable/permission_accept/sensitive_approval/sensitive_denial/needs_review/capability_blocked/diagnostic_recorded/mcp_start_failed/hook_filtered/command_tool_invalid). Plan A only emits 4; the rest are typed so future hooks + the UI render correctly without a type change.

4. **`appendPluginAuditEntry` is fire-and-forget-safe.** Sync `appendFileSync` (matching the config-audit pattern) inside try/catch; a failure logs via the module logger and continues. The audited operation (tool allow/deny, plugin list) is never blocked by an audit write failure.

5. **`id` + `createdAt` are generated at append time.** `id = crypto.randomUUID()`; `createdAt = new Date().toISOString()`. Callers pass `pluginId`, `type`, `summary`, `metadata?`, `version?`, `workspaceSlug?`.

6. **attempt.ts hooks sit in the Phase 4A branches.** `sensitive_approval` at the allow_always append point, `sensitive_denial` at the deny/timeout point, `capability_blocked` at the prior-deny hard-block point. All three already have `pluginId` + `capabilityKey` in scope.

7. **`needs_review` hook in plugin-registry.ts:270** — when `computeRuntimeState` returns `needs-review`. Emits per occurrence (no dedup in Plan A); the `createdAt` + the fact that `list()` runs per-session bounds the volume.

## File Structure

- Create `packages/shared/src/types/plugin-audit.ts` — `PluginAuditEvent` + result types.
- Modify `packages/shared/src/types/agent.ts` — `GET_PLUGIN_AUDIT_LOG` channel + result types (re-export from plugin-audit.ts or inline).
- Modify `apps/sidecar/src/services/infra/config-paths.ts` — `getPluginAuditPath()`.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-audit-store.ts` (+test) — `appendPluginAuditEntry` + `readPluginAuditEntries`.
- Modify `apps/sidecar/src/rpc/agent-handlers.ts` (+test) — `GET_PLUGIN_AUDIT_LOG` handler.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts` — 3 audit hooks.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts` — `needs_review` hook.

No changes to SDK, `lume-config-service.ts`, `permission-gate.ts`, `sensitive-gate.ts`, `run.ts`.

---

## Task 1: `PluginAuditEvent` type + `GET_PLUGIN_AUDIT_LOG` channel

**Files:**
- Create: `packages/shared/src/types/plugin-audit.ts`
- Modify: `packages/shared/src/types/agent.ts` (channel + re-export)
- Modify: `packages/shared/src/types/index.ts` (if it barrel-exports types — confirm)

- [ ] **Step 1: Create `plugin-audit.ts`**

```ts
export type PluginAuditEventType =
  | "install"
  | "uninstall"
  | "enable"
  | "disable"
  | "permission_accept"
  | "sensitive_approval"
  | "sensitive_denial"
  | "needs_review"
  | "capability_blocked"
  | "diagnostic_recorded"
  | "mcp_start_failed"
  | "hook_filtered"
  | "command_tool_invalid";

export interface PluginAuditEvent {
  id: string;
  pluginId: string;
  version?: string;
  workspaceSlug?: string;
  type: PluginAuditEventType;
  createdAt: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface GetPluginAuditLogInput {
  pluginId: string;
  workspaceSlug?: string;
  limit?: number;
}

export interface GetPluginAuditLogResult {
  events: PluginAuditEvent[];
}
```

- [ ] **Step 2: Add the channel in agent.ts**

In `AGENT_IPC_CHANNELS` near `LIST_PLUGINS`/`RELOAD_PLUGINS`, add:
```ts
    GET_PLUGIN_AUDIT_LOG: 'agent:get-plugin-audit-log',
```
Re-export the plugin-audit types from agent.ts (or wherever the barrel that agent-handlers imports from) — confirm how `AgentListPluginsResult` etc. are surfaced and mirror it:
```ts
export type { PluginAuditEvent, PluginAuditEventType, GetPluginAuditLogInput, GetPluginAuditLogResult } from "./plugin-audit";
```
(Adjust the relative path + whether agent.ts already re-exports sibling type files. If `packages/shared/src/types/index.ts` is the barrel, add the export there instead. Read the barrel first.)

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/shared && bun x tsc --noEmit 2>&1 | grep -E "plugin-audit|agent.ts" | head`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/plugin-audit.ts packages/shared/src/types/agent.ts
# + index.ts/barrel if changed
git commit -m "✨ feat(shared): PluginAuditEvent 类型 + GET_PLUGIN_AUDIT_LOG channel（Phase 4B 核心）"
```

---

## Task 2: `getPluginAuditPath` + `plugin-audit-store` (append + read)

**Files:**
- Modify: `apps/sidecar/src/services/infra/config-paths.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-audit-store.ts` (+test)

- [ ] **Step 1: Add `getPluginAuditPath` in config-paths.ts**

Near `getLumeConfigAuditPath` (~L105), add:
```ts
export function getPluginAuditPath(): string {
  return join(getConfigDir(), "plugins-audit.jsonl");
}
```
(Confirm `getConfigDir` + `join` are imported/used nearby — mirror exactly.)

- [ ] **Step 2: Write the failing test for the store**

Create `plugin-audit-store.test.ts` (use `mkdtemp` to isolate the file):
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { appendPluginAuditEntry, readPluginAuditEntries } from "./plugin-audit-store.js";
import type { PluginAuditEvent } from "@lume/shared";

describe("plugin-audit-store", () => {
  test("append then read round-trips, filtered by pluginId + limited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-"));
    const path = join(dir, "plugins-audit.jsonl");
    await appendPluginAuditEntry(path, { id: "1", pluginId: "acme", type: "sensitive_approval", createdAt: "t1", summary: "ok" });
    await appendPluginAuditEntry(path, { id: "2", pluginId: "beta", type: "sensitive_denial", createdAt: "t2", summary: "no" });
    await appendPluginAuditEntry(path, { id: "3", pluginId: "acme", type: "capability_blocked", createdAt: "t3", summary: "blocked" });

    const acme = await readPluginAuditEntries(path, { pluginId: "acme" });
    expect(acme).toHaveLength(2);
    expect(acme.map((e) => e.id)).toEqual(["1", "3"]);

    const limited = await readPluginAuditEntries(path, { pluginId: "acme", limit: 1 });
    expect(limited).toHaveLength(1);
    // limit tails the most recent
    expect(limited[0]?.id).toBe("3");
  });

  test("read returns [] for missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-missing-"));
    const events = await readPluginAuditEntries(join(dir, "nope.jsonl"), {});
    expect(events).toEqual([]);
  });

  test("read skips malformed lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-plugin-audit-bad-"));
    const path = join(dir, "plugins-audit.jsonl");
    await appendPluginAuditEntry(path, { id: "1", pluginId: "acme", type: "needs_review", createdAt: "t", summary: "x" });
    // corrupt the file with a bad line
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "this is not json\n", "utf-8");
    const events = await readPluginAuditEntries(path, {});
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-audit-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `plugin-audit-store.ts`**

```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getPluginAuditPath } from "../../infra/config-paths.js";
import type { PluginAuditEvent } from "@lume/shared";
import { createLogger } from "../../infra/logger.js";

const log = createLogger("plugin-audit-store");

/**
 * Append a plugin audit event to the jsonl store. Best-effort: a write failure logs a
 * warning but does NOT throw (audit is observational; it must not break the audited op).
 * If `path` is omitted, uses the default getPluginAuditPath().
 */
export async function appendPluginAuditEntry(
  path: string | undefined,
  event: Omit<PluginAuditEvent, "id" | "createdAt"> & Partial<Pick<PluginAuditEvent, "id" | "createdAt">>,
): Promise<void> {
  const target = path ?? getPluginAuditPath();
  const full: PluginAuditEvent = {
    id: event.id ?? randomUUID(),
    createdAt: event.createdAt ?? new Date().toISOString(),
    ...event,
  } as PluginAuditEvent;
  try {
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(full)}\n`, "utf-8");
  } catch (error) {
    log.warn("appendPluginAuditEntry failed", { pluginId: event.pluginId, type: event.type, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Read plugin audit events from the jsonl store. Best-effort: missing file → [];
 * malformed lines skipped. Filters by pluginId (if given) and tails to `limit`
 * (most recent first when limit is set).
 */
export async function readPluginAuditEntries(
  path: string,
  input: { pluginId?: string; limit?: number },
): Promise<PluginAuditEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: PluginAuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PluginAuditEvent;
      if (input.pluginId && parsed.pluginId !== input.pluginId) continue;
      events.push(parsed);
    } catch {
      // malformed line — skip
    }
  }
  // jsonl is append-order (chronological); tail to limit → most recent
  return input.limit && input.limit > 0 ? events.slice(-input.limit) : events;
}
```

(Confirm `createLogger` import path + signature match the file's convention. The `as PluginAuditEvent` cast handles the spread overriding id/createdAt — keep id/createdAt first so explicit values win. Verify `getPluginAuditPath` import path: from `plugins/` it's `../../infra/config-paths.js`.)

- [ ] **Step 5: Run to verify pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-audit-store.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-audit-store.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-audit-store.test.ts
git commit -m "✨ feat(sidecar): plugin-audit-store（jsonl append + read，Phase 4B 核心）"
```

---

## Task 3: `GET_PLUGIN_AUDIT_LOG` handler

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Create: `apps/sidecar/src/rpc/agent-handlers.plugin-audit.test.ts`

- [ ] **Step 1: READ + write the failing test**

Read `agent-handlers.ts` `LIST_PLUGINS`/`RELOAD_PLUGINS` handlers (~L987-998) as the template. Read `agent-handlers.list-plugins.test.ts` for the test-fixture pattern (context construction).

Create `agent-handlers.plugin-audit.test.ts` mirroring the list-plugins test setup (temp HOME via `mkdtempSync`, `createAgentHandlers(context)`). Assert: handler returns `{ events }` filtered by pluginId, by seeding the audit file then calling:
```ts
import { appendPluginAuditEntry } from "../services/agent-runtime/plugins/plugin-audit-store.js";
import { getPluginAuditPath } from "../services/infra/config-paths.js";
// ... seed appendPluginAuditEntry(getPluginAuditPath(), {...}) for pluginId "acme" + "beta"
// ... call handlers[AGENT_IPC_CHANNELS.GET_PLUGIN_AUDIT_LOG]({ pluginId: "acme" })
// ... expect(result.events).toHaveLength(seed-acme-count)
```
(Adapt the fixture so `getPluginAuditPath()` resolves into the temp HOME — same trick list-plugins.test.ts uses for the plugins-state path. Confirm how it isolates HOME.)

- [ ] **Step 2: Run to verify it fails**

Run: `rtk bun test apps/sidecar/src/rpc/agent-handlers.plugin-audit.test.ts`
Expected: FAIL — handler undefined.

- [ ] **Step 3: Implement the handler**

In `agent-handlers.ts`, add after `RELOAD_PLUGINS`:
```ts
    [AGENT_IPC_CHANNELS.GET_PLUGIN_AUDIT_LOG]: async (input: GetPluginAuditLogInput) => {
      const result = await readPluginAuditEntries(getPluginAuditPath(), {
        pluginId: input.pluginId,
        ...(input.limit ? { limit: input.limit } : {}),
      });
      log.info("GET_PLUGIN_AUDIT_LOG request", { pluginId: input.pluginId, count: result.length });
      return { events: result };
    },
```
(Import `readPluginAuditEntries` from `../services/agent-runtime/plugins/plugin-audit-store.js`, `getPluginAuditPath` from `../services/infra/config-paths.js`, `GetPluginAuditLogInput` from `@lume/shared`. Validate input has `pluginId` (required per spec) — mirror how other handlers validate, or trust the typed param.)

- [ ] **Step 4: Run to verify pass**

Run: `rtk bun test apps/sidecar/src/rpc/agent-handlers.plugin-audit.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts`
Expected: PASS — new test passes; list-plugins unaffected.

- [ ] **Step 5: Verify typecheck**

Run: `cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "agent-handlers" | head`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/agent-handlers.plugin-audit.test.ts
git commit -m "✨ feat(sidecar): GET_PLUGIN_AUDIT_LOG RPC handler（Phase 4B 核心）"
```

---

## Task 4: `sensitive_approval` + `sensitive_denial` + `capability_blocked` hooks (attempt.ts)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`

- [ ] **Step 1: READ the Phase 4A branches**

Read attempt.ts plugin gate (~L266-400): the `block` branch (~L280, prior-deny hard block → `capability_blocked`), the `ask`→`allow_always` branch (~L326, → `sensitive_approval`), the `ask`→deny/timeout branch (~L367, → `sensitive_denial`). All have `gateResult.pluginId` + `gateResult.capabilityKey` + `prepared.workspaceSlug` + `toolName` in scope.

- [ ] **Step 2: Add the 3 hooks**

Import at top:
```ts
import { appendPluginAuditEntry } from "../plugins/plugin-audit-store.js";
```

(a) `capability_blocked` — in the `block` branch (~L280), after `recordPermissionDenial`, before `return deny`:
```ts
        void appendPluginAuditEntry(undefined, {
          pluginId: gateResult.pluginId ?? "",
          ...(gateResult.pluginId ? {} : { pluginId: descriptor.definition.name }),
          type: "capability_blocked",
          summary: `Plugin tool ${toolName} blocked (prior deny)`,
          ...(prepared.workspaceSlug ? { workspaceSlug: prepared.workspaceSlug } : {}),
          metadata: { toolName, reason: gateResult.reason },
        });
```
Wait — `gateResult` in the block branch: confirm it carries pluginId. From sensitive-gate.ts, the block branch returns `{ decision: "block", reason }` WITHOUT pluginId (only ask carries pluginId). So use the descriptor's runtimeMetadata.pluginId. Fix:
```ts
        const blockPluginId = (descriptor.definition as { runtimeMetadata?: { pluginId?: string } }).runtimeMetadata?.pluginId ?? toolName;
        void appendPluginAuditEntry(undefined, {
          pluginId: blockPluginId,
          type: "capability_blocked",
          summary: `Plugin tool ${toolName} blocked (prior deny)`,
          ...(prepared.workspaceSlug ? { workspaceSlug: prepared.workspaceSlug } : {}),
          metadata: { toolName, reason: gateResult.reason },
        });
```
(Confirm the exact pluginId source in the block branch. `void` = fire-and-forget the async append; the store's internal try/catch makes it safe.)

(b) `sensitive_approval` — in the `allow_always` branch (~L326), after the `appendSensitiveApproval` try/catch, before `return allow`:
```ts
        void appendPluginAuditEntry(undefined, {
          pluginId: gateResult.pluginId,
          type: "sensitive_approval",
          summary: `Plugin ${gateResult.pluginId} sensitive capability approved (always, workspace)`,
          ...(prepared.workspaceSlug ? { workspaceSlug: prepared.workspaceSlug } : {}),
          metadata: { capabilityKey: gateResult.capabilityKey, toolName, scope: "workspace" },
        });
```

(c) `sensitive_denial` — in the deny/timeout branch (~L367), after `recordPermissionDenial`, before `return deny`:
```ts
        void appendPluginAuditEntry(undefined, {
          pluginId: gateResult.pluginId,
          type: "sensitive_denial",
          summary: pluginTimedOut ? `Plugin ${gateResult.pluginId} sensitive approval timed out` : `Plugin ${gateResult.pluginId} sensitive capability denied`,
          ...(prepared.workspaceSlug ? { workspaceSlug: prepared.workspaceSlug } : {}),
          metadata: { capabilityKey: gateResult.capabilityKey, toolName, reason: pluginTimedOut ? "timeout" : "user_denied" },
        });
```

- [ ] **Step 3: Verify typecheck + regression**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "attempt.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```
Expected: no new attempt.ts errors; run.test.ts passes (the audit hooks are fire-and-forget `void` calls; they don't change the gate's return behavior).

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
git commit -m "✨ feat(sidecar): attempt 三处审计埋点（sensitive_approval/denial + capability_blocked，Phase 4B）"
```

---

## Task 5: `needs_review` hook (plugin-registry.ts)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts`

- [ ] **Step 1: READ the needs-review point**

Read plugin-registry.ts:~L265-280 (`attachPermissionState`): when `computeRuntimeState` returns `state === "needs-review"`, a diagnostic is pushed with code `permission_review_required`. This is the hook point.

- [ ] **Step 2: Add the hook**

Import at top:
```ts
import { appendPluginAuditEntry } from "./plugin-audit-store.js";
```

In the `needs-review` branch (where the diagnostic with `permission_review_required` is pushed), add after the push:
```ts
          void appendPluginAuditEntry(undefined, {
            pluginId: plugin.pluginId,
            ...(version ? { version } : {}),
            type: "needs_review",
            summary: `Plugin ${plugin.pluginId} needs review (permissions hash mismatch)`,
            metadata: { reason: result.reason },
          });
```
(Confirm `plugin.pluginId` + `version` variable names in scope. This emits once per needs-review plugin per `list()` call — acceptable for Plan A; dedup is Plan B.)

- [ ] **Step 3: Verify typecheck + regression**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "plugin-registry" | head
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.test.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.permission-state.test.ts
```
Expected: no new errors; registry tests pass (the hook is fire-and-forget).

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts
git commit -m "✨ feat(sidecar): plugin-registry needs_review 审计埋点（Phase 4B）"
```

---

## Task 6: Regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full regression (from apps/sidecar cwd)**

```bash
rtk bun test ../../packages/shared/src/ ../../packages/sdk/src/plugins/ ./src/services/agent-runtime/plugins/ ./src/services/agent-runtime/runtime-core/run.test.ts ./src/rpc/agent-handlers.list-plugins.test.ts ./src/rpc/agent-handlers.reload-plugins.test.ts ./src/rpc/agent-handlers.plugin-audit.test.ts
```
Expected: ALL PASS, 0 new FAIL. New tests (plugin-audit-store ×3, plugin-audit RPC) pass; existing plugin/runtime/rpc tests unaffected.

- [ ] **Step 2: Boundary — Phase 4B-core change set**

Phase 4B-core base = Phase 4A HEAD (commit before Task 1 of this plan). The change set should be exactly:
```bash
git diff --name-only <4b-base>..HEAD
```
Expected: `packages/shared/src/types/plugin-audit.ts` (new), `packages/shared/src/types/agent.ts`, `packages/shared/src/types/index.ts` (if barrel), `config-paths.ts`, `plugin-audit-store.ts` (new), `plugin-audit-store.test.ts` (new), `agent-handlers.ts`, `agent-handlers.plugin-audit.test.ts` (new), `attempt.ts`, `plugin-registry.ts`, + this plan doc. **No other files** — in particular NOT SDK `normalized.ts`/`permission-gate.ts`, NOT `lume-config-service.ts`, NOT `sensitive-gate.ts`, NOT `run.ts`.

- [ ] **Step 3: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test: Phase 4B-core 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`. Cross-package suites from root; sidecar `./src/...` from `apps/sidecar`.
- **Audit is observational.** Every `appendPluginAuditEntry` call is `void`-prefixed (fire-and-forget); the store's internal try/catch guarantees a write failure never breaks the audited operation. Do NOT await these in the gate's hot path.
- **Read side is the infra novelty.** `lume-config-service` only appends audit; Phase 4B builds `readPluginAuditEntries` from scratch (read → split → parse → filter → tail). The Task 2 tests guard missing-file + malformed-line robustness.
- **`needs_review` may emit duplicates** across `list()` calls — acceptable for Plan A (createdAt distinguishes; per-session volume is bounded). Dedup is Plan B.
- **FUTURE types are typed but not emitted.** The 13-type union is complete; Plan A emits 4. Do NOT add hooks for install/uninstall/enable/disable/permission_accept (no mutation API exists).
- **Do not touch the SDK normalizer.** `command_tool_invalid` diagnostics surface via Plan B's `diagnostic_recorded` unified interception, not by SDK writes.
- **Do not "improve" adjacent code.** Per CLAUDE.md §3, only the named files.
- **RTK prefix** for tests: `rtk bun test ...`.
