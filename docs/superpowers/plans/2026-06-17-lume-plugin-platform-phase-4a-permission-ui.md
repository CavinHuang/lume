# Lume Plugin Platform Phase 4A — Interactive Permission Confirmation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 2 "ask→block" convention for plugin sensitive capabilities with an **interactive prompt** — when a plugin tool/mcp/hook's `checkSensitiveCapability` returns `ask`, the sidecar pauses via the existing `waitForToolPermissionDecision` pipeline, the web `PermissionBanner` asks the user (allow-once / allow-always / deny), and `allow_always` persists a `SensitiveApprovalRecord` to `plugins-state.json` so it's not asked again.

**Architecture:** The infrastructure is 90% present — `tool-permission-session.ts` already does "pause → emit request → await user → resume" for built-in tools, and `PermissionBanner.tsx` renders the allow-once/allow-always/deny UI. Phase 4A threads the plugin sensitive gate into this pipeline: (1) `SensitiveGateResult` gains an `ask` third state (instead of folding ask into block); (2) `attempt.ts`'s plugin-gate branch, on `ask`, builds an `AgentToolPermissionRequest` carrying a new `pluginSensitive` field and awaits `waitForToolPermissionDecision`; (3) `allow_always` calls a new `FilePluginStateStore.appendSensitiveApproval` (read-modify-write) so `resolveSensitiveApproval` finds it next time; (4) `PermissionBanner` renders the plugin dimension. Scope: **call gate only** (sensitive-gate.ts). The start gate (`plugin-mcp-bridge.ts` `authorizeConnect`) and hook gate (`plugin-hooks-bridge.ts`) keep ask→block for now — their pause context is harder (connect loop / hook handler), deferred to a follow-up. `allow_always` defaults to **workspace scope** (the current `workspaceSlug`); global-scope selection is a later UI refinement.

**Tech Stack:** TypeScript, Bun test (sidecar/sdk), React (web), existing `waitForToolPermissionDecision` + `AgentToolPermissionRequest` + `PermissionBanner` + `FilePluginStateStore`.

---

## Scope

Implements the **interactive permission confirmation** slice (spec §8.1/§8.2 + the "Phase 4 replaces block-on-ask with an interactive prompt" notes scattered across `sensitive-gate.ts:20`, `plugin-mcp-bridge.ts:35`, `attempt.ts:269`):

- `SensitiveGateResult` → three-state `{ decision: "allow" | "ask" | "block"; ... }` carrying `pluginId` + `capabilityKey` for `ask`.
- `FilePluginStateStore.appendSensitiveApproval()` (read-modify-write, atomic) + `PluginPermissionRuntime.appendSensitiveApproval()` wrapper.
- `AgentToolPermissionRequest.pluginSensitive` optional field (shared type).
- `attempt.ts` call-gate `ask` branch → `waitForToolPermissionDecision` → `allow_always` persists approval, `allow_once` passes, `deny`/timeout blocks.
- `PermissionBanner` renders pluginId + capability key when `pluginSensitive` is present.

**Out of scope (deferred):**

- **Start gate / hook gate interactive ask** — `plugin-mcp-bridge.ts` `authorizeConnect` + `plugin-hooks-bridge.ts` keep ask→block (pause context harder). Follow-up plan.
- **Global-scope `allow_always`** — Phase 4A defaults to workspace scope. A global/workspace toggle in `PermissionBanner` is a later UX refinement.
- **`network:` / `filesystem:write:` sensitive keys** — not gated at all yet (separate work).
- **PluginAuditLog** — Plan B (separate plan). Phase 4A does NOT write audit events (the `sensitive_approval`/`sensitive_denial` audit types land with Plan B).
- **`deny` persistence** — Phase 4A only persists `allow` (allow_always). A prior `deny` record (if any) already makes `checkSensitiveCapability` return `deny`→`block`. User-facing "always deny" UI is later.

**Constraints:**

- **Reuse `waitForToolPermissionDecision`, do NOT build a new permission signal.** It already supports `allow_once`/`allow_always`/`deny`, timeout, abort, and durable resume.
- **Do NOT change the built-in tool `approval_required` path** (attempt.ts:544-614) — only add a parallel `ask` branch to the plugin gate (attempt.ts:266-296).
- **`allow_always` for plugin sensitive ≠ `markToolFingerprintAllowed`.** Plugin allow_always writes a `SensitiveApprovalRecord` (workspace-scoped); it does NOT use the tool-fingerprint allowlist.
- **`appendSensitiveApproval` is the only state write** added. `FilePluginStateStore.write` already exists (atomic tmp+rename); the new method is read-modify-write on top of it.
- **Touch surface:** `sensitive-gate.ts` (+test), `plugin-state-store.ts` (+test), `permission-runtime.ts`, `packages/shared/src/types/agent.ts`, `attempt.ts`, `PermissionBanner.tsx`. Do NOT touch `plugin-mcp-bridge.ts`, `plugin-hooks-bridge.ts`, `tool-permission-session.ts`, `permission-gate.ts` (SDK pure logic), `run.ts`.
- Match style: 2-space indent, double quotes (sidecar), single quotes (web), no `any`, `bun:test`.

## Design Decisions

1. **Three-state gate, `ask` distinct from `block`.** `checkSensitiveCapability` returns `"allow"|"deny"|"ask"`. Today the gate folds `deny`+`ask`→`block`. Phase 4A: `allow`→allow, `deny`→block (hard, not interactive), `ask`→ask (interactive). This preserves "prior deny stays a hard block" (a user who denied before isn't re-prompted every call).

2. **`ask` carries `pluginId` + `capabilityKey`** so `attempt.ts` can build the permission request + persist the approval with the right key. The key is exactly what `checkSensitiveCapability` was called with (`commandTool:${name}` / `mcpServer:${serverId}`) — same key `resolveSensitiveApproval` matches on next call.

3. **`allow_always` = workspace-scoped `SensitiveApprovalRecord`.** `appendSensitiveApproval({ pluginId, record: { key, scope: "workspace", workspaceSlug, decision: "allow", createdAt, permissionsHash } })`. Next attempt's `checkSensitiveCapability` (same workspaceSlug) → `resolveSensitiveApproval` matches → `allow`. `permissionsHash` comes from the install record's accepted hash (reuse `resolveAcceptedHash` logic).

4. **`allow_once` = pass without persisting.** The tool runs this once; next call re-prompts (still `ask`). Matches built-in tool `allow_once` semantics.

5. **`PluginPermissionRuntime.appendSensitiveApproval` wrapper.** `attempt.ts` already holds a `pluginPermissionRuntime`; giving it the append method (delegating to its `FilePluginStateStore`) avoids threading the store separately into `canUseTool`.

6. **PermissionBanner reuses existing allow-once/allow-always/deny buttons.** The only UI addition is rendering the pluginId + capability key (a small info block) when `request.pluginSensitive` is present. No new buttons, no scope toggle (workspace is implicit in allow_always).

7. **`AgentToolPermissionRequest.pluginSensitive` is optional + additive.** Built-in tool requests don't set it; `PermissionBanner` only shows the plugin block when it's present. Zero impact on the existing flow.

## File Structure

- Modify `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts` (+test) — three-state result + `ask` branch.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts` (+test) — `appendSensitiveApproval`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts` — `appendSensitiveApproval` wrapper.
- Modify `packages/shared/src/types/agent.ts` — `AgentToolPermissionRequest.pluginSensitive` field + `AgentPluginSensitiveRequest` type.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts` — call-gate `ask` branch.
- Modify `apps/web/src/components/agent/PermissionBanner.tsx` — plugin dimension rendering.

No changes to `plugin-mcp-bridge.ts`, `plugin-hooks-bridge.ts`, `tool-permission-session.ts`, `permission-gate.ts` (SDK), `run.ts`.

---

## Task 1: `SensitiveGateResult` three-state + `ask` branch

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

In `sensitive-gate.test.ts`, extend the suite. The gate must now distinguish `ask` (no prior approval, interactive) from `block` (prior deny). Add:

```ts
test("ask decision (no prior approval) returns ask with pluginId + capabilityKey", async () => {
  const runtime = {
    async checkSensitiveCapability() {
      return { decision: "ask" as const, reason: "no prior approval" };
    },
  };
  const result = await evaluatePluginSensitiveGate({
    descriptor: {
      name: "demo_echo",
      canonicalName: "demo_echo",
      source: "plugin",
      definition: { name: "demo_echo", runtimeMetadata: { pluginId: "demo" } },
      metadata: {} as never,
    } as never,
    runtime: runtime as never,
    workspaceSlug: "ws",
  });
  expect(result.decision).toBe("ask");
  expect(result.pluginId).toBe("demo");
  expect(result.capabilityKey).toBe("commandTool:demo_echo");
});

test("deny decision (prior deny record) returns block, not ask", async () => {
  const runtime = {
    async checkSensitiveCapability() {
      return { decision: "deny" as const, reason: "prior deny" };
    },
  };
  const result = await evaluatePluginSensitiveGate({
    descriptor: {
      name: "demo_echo",
      canonicalName: "demo_echo",
      source: "plugin",
      definition: { name: "demo_echo", runtimeMetadata: { pluginId: "demo" } },
      metadata: {} as never,
    } as never,
    runtime: runtime as never,
  });
  expect(result.decision).toBe("block");
});
```

(Adapt the descriptor shape to the existing test helpers. The MCP-tool test from MCP-B already covers `mcpServer:` key — keep it; its assertion may need updating if it expected `block` on `ask`.)

- [ ] **Step 2: Run to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`
Expected: FAIL — `result.decision` is `"block"` (ask folded into block), no `pluginId`/`capabilityKey` fields.

- [ ] **Step 3: Implement the three-state gate**

In `sensitive-gate.ts`:

(a) Replace the `SensitiveGateResult` alias with a dedicated three-state interface:
```ts
export interface SensitiveGateResult {
  decision: "allow" | "ask" | "block";
  reason?: string;
  /** Present when decision is "ask": the plugin + capability to confirm interactively. */
  pluginId?: string;
  capabilityKey?: string;
}
```
(If `McpGateDecision` was aliased here, drop the alias — `McpGateDecision` stays in `workspace-mcp-manager.ts` for `authorizeConnect`; `SensitiveGateResult` is now independent.)

(b) Update `evaluatePluginSensitiveGate` — `deny`→block, `ask`→ask (carrying pluginId + key), `allow`→allow:
```ts
export async function evaluatePluginSensitiveGate(input: SensitiveGateInput): Promise<SensitiveGateResult> {
  const definition = input.descriptor.definition as {
    name: string;
    runtimeMetadata?: { pluginId?: string; capability?: string; mcpServerId?: string };
  };
  const pluginId = definition.runtimeMetadata?.pluginId;
  if (!pluginId) {
    return { decision: "allow" };
  }

  const isMcpTool = definition.runtimeMetadata?.capability === "mcp" && typeof definition.runtimeMetadata?.mcpServerId === "string";
  const capabilityKey: SensitiveCapabilityKey = isMcpTool && definition.runtimeMetadata?.mcpServerId
    ? `mcpServer:${definition.runtimeMetadata.mcpServerId}`
    : `commandTool:${definition.name}`;

  const result = await input.runtime.checkSensitiveCapability({
    pluginId,
    key: capabilityKey,
    workspaceSlug: input.workspaceSlug,
  });

  if (result.decision === "allow") {
    return { decision: "allow" };
  }
  if (result.decision === "ask") {
    return { decision: "ask", pluginId, capabilityKey, reason: result.reason };
  }
  // deny → hard block (prior deny record or hard-deny); not interactive.
  return {
    decision: "block",
    reason: `Plugin ${pluginId} capability ${capabilityKey} blocked (sensitive, ${result.decision}): ${result.reason}`,
  };
}
```

(c) Update the docstring (remove "Phase 4 replaces block-on-ask" since it's now implemented; note ask is interactive, deny is hard block):
```ts
 * Covers command tools (commandTool:${name}) and plugin-MCP tools (mcpServer:${serverId},
 * §8.1) — both source-bound via runtimeMetadata.pluginId. `allow` → pass; `ask` (no prior
 * approval) → interactive prompt (Phase 4A, attempt.ts threads it through
 * waitForToolPermissionDecision); `deny` (prior deny record) → hard block. Plugin hooks are
 * gated by plugin-hooks-bridge.ts. network/filesystem-write keys are a later extension.
```

- [ ] **Step 4: Run to verify pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`
Expected: PASS — new tests pass; existing command-tool + MCP-tool tests pass (update any that asserted `block` on `ask` to assert `ask`).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts
git commit -m "✨ feat(sidecar): SensitiveGateResult 扩展 ask 三态（区分 ask 交互 vs deny 硬 block，Phase 4A）"
```

---

## Task 2: `appendSensitiveApproval` (state-store + permission-runtime)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts` (+test)
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts`

- [ ] **Step 1: Write the failing test**

In `plugin-state-store.test.ts` (extend), add a test that `appendSensitiveApproval` adds a record that a subsequent `read()` returns (and that `resolveSensitiveApproval` would match). Use a temp state file:

```ts
test("appendSensitiveApproval persists a record readable on next read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lume-state-append-"));
  const store = new FilePluginStateStore(join(dir, "plugins-state.json"));
  // Seed an install record so append has a target
  await store.write({
    plugins: {
      demo: {
        pluginId: "demo",
        activeVersion: "1.0.0",
        versions: { "1.0.0": { pluginId: "demo", version: "1.0.0", source: {}, installedRoot: dir, installedAt: "t", sensitiveApprovals: [], permissionsHash: "h1" } },
        approvalsByHash: {},
      },
    },
  });
  await store.appendSensitiveApproval({
    pluginId: "demo",
    record: { key: "commandTool:demo_echo", scope: "workspace", workspaceSlug: "ws", decision: "allow", createdAt: "now", permissionsHash: "h1" },
  });
  const state = await store.read();
  const approvals = state.plugins.demo?.versions["1.0.0"]?.sensitiveApprovals ?? [];
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.key).toBe("commandTool:demo_echo");
});
```

(Adapt field names to the actual `PluginInstalledVersion` type — confirm `permissionsHash`, `sensitiveApprovals` live on the version. If the active source is `external`/`approvalsByHash` instead, the method must target whichever `collectSensitiveApprovals` reads; the test seeds `versions[activeVersion]` so target that path.)

- [ ] **Step 2: Run to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts -t "appendSensitiveApproval"`
Expected: FAIL — `appendSensitiveApproval` doesn't exist.

- [ ] **Step 3: Implement `appendSensitiveApproval` on `FilePluginStateStore`**

In `plugin-state-store.ts`, add (after `write`):
```ts
/**
 * Append a single sensitive-approval record to a plugin's install record (read-modify-write).
 * Targets the active source: activeVersion's version → else external → else approvalsByHash
 * (mirrors `collectSensitiveApprovals` read order). Atomic via `write`.
 */
async appendSensitiveApproval(input: {
  pluginId: string;
  record: SensitiveApprovalRecord;
}): Promise<void> {
  const state = await this.read();
  const rec = state.plugins[input.pluginId];
  if (!rec) {
    throw new Error(`appendSensitiveApproval: plugin not found: ${input.pluginId}`);
  }
  let target: { sensitiveApprovals: SensitiveApprovalRecord[] } | undefined;
  if (rec.activeVersion && rec.versions[rec.activeVersion]) {
    target = rec.versions[rec.activeVersion];
  } else {
    const external = Object.values(rec.external ?? {})[0];
    if (external) target = external;
  }
  if (!target) {
    // Fall back to approvalsByHash under a stable key
    const hash = input.record.permissionsHash || "default";
    rec.approvalsByHash[hash] ??= { sensitiveApprovals: [] } as never;
    target = rec.approvalsByHash[hash];
  }
  target.sensitiveApprovals.push(input.record);
  await this.write(state);
}
```
(Confirm `SensitiveApprovalRecord` is imported — it's from `@lume/agent-sdk`. Match the exact `PluginApprovalBundle`/`PluginInstalledVersion` field shapes by reading the types; the `as never` on approvalsByHash is only if the type is loose — prefer the real type. The method must target the SAME array `collectSensitiveApprovals` (permission-runtime.ts:82-95) reads, so next `checkSensitiveCapability` finds it.)

- [ ] **Step 4: Add the `PluginPermissionRuntime.appendSensitiveApproval` wrapper**

In `permission-runtime.ts`, add a method delegating to the store:
```ts
async appendSensitiveApproval(input: {
  pluginId: string;
  record: SensitiveApprovalRecord;
}): Promise<void> {
  await this.input.stateStore.appendSensitiveApproval(input);
}
```
(Import `SensitiveApprovalRecord` from `@lume/agent-sdk` if not already.)

- [ ] **Step 5: Run to verify pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.test.ts`
Expected: PASS — new test passes; existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-state-store.test.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts
git commit -m "✨ feat(sidecar): FilePluginStateStore.appendSensitiveApproval（读改写追加审批记录，Phase 4A）"
```

---

## Task 3: `AgentToolPermissionRequest.pluginSensitive` field

**Files:**
- Modify: `packages/shared/src/types/agent.ts`

- [ ] **Step 1: Add the type + field**

Near `AgentToolPermissionRequest` (~L709), add a type for the plugin dimension, then the optional field on the request:

```ts
/** Plugin sensitive-capability dimension on a tool permission request (Phase 4A). */
export interface AgentPluginSensitiveRequest {
  pluginId: string
  /** The SensitiveCapabilityKey being confirmed, e.g. commandTool:${name} / mcpServer:${id}. */
  capabilityKey: string
}
```

Then add to `AgentToolPermissionRequest` (after `automationTrigger?: string`, ~L736):
```ts
  /** Plugin sensitive-capability context (Phase 4A interactive approval). Undefined = built-in tool approval. */
  pluginSensitive?: AgentPluginSensitiveRequest
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/shared && bun x tsc --noEmit 2>&1 | grep agent.ts | head`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/agent.ts
git commit -m "✨ feat(shared): AgentToolPermissionRequest 新增 pluginSensitive 字段（Phase 4A 交互审批）"
```

---

## Task 4: `attempt.ts` call-gate `ask` branch

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`

- [ ] **Step 1: READ the current plugin gate + the approval_required path**

Read `attempt.ts`:
- The plugin sensitive gate (~L266-296): `if (pluginPermissionRuntime) { evaluatePluginSensitiveGate(...); if (block) { recordPermissionDenial; return deny; } }`.
- The built-in `approval_required` path (~L500-614): how it builds `request` (requestId, toolUseId, toolName, risk, reason, input, runId...) and calls `waitForToolPermissionDecision(request, askUserSignal, emit.onToolPermissionRequest, { onTimeout })`, then branches on `allow_always`/`allow_once`/`deny`.
- Confirm `askUserSignal`, `emit`, `requestRunId`, `approvalThreadId`, `descriptor`, `input`, `toolName` are all in scope at the plugin-gate branch (they are — they're earlier in the same `createCanUseToolHandler`).
- Confirm `randomUUID` (or equivalent) is available for `requestId`.

- [ ] **Step 2: Add the `ask` branch**

Replace the plugin gate block (~L266-296). Keep the `block` branch unchanged; add an `ask` branch that threads into `waitForToolPermissionDecision`. The new shape:

```ts
    if (pluginPermissionRuntime) {
      const gateResult = await evaluatePluginSensitiveGate({
        descriptor,
        runtime: pluginPermissionRuntime,
        workspaceSlug: prepared.workspaceSlug,
      });
      if (gateResult.decision === "block") {
        recordPermissionDenial({
          threadId: params.runtime.sessionId,
          descriptor,
          toolName,
          rawInput: input,
          reasonCode: "permission_review_required",
        });
        log.debug("[Agent 工具] 完成", { toolName, threadId: params.runtime.sessionId.slice(0, 8), durationMs: Date.now() - toolStartTime, ok: false, reason: "plugin_sensitive_blocked" });
        return { behavior: "deny", message: gateResult.reason ?? `Plugin tool ${toolName} blocked by sensitive-capability gate.` };
      }
      if (gateResult.decision === "ask" && gateResult.pluginId && gateResult.capabilityKey) {
        // Phase 4A: interactive plugin sensitive approval via the existing tool-permission pipeline.
        const pluginRequest: AgentToolPermissionRequest = {
          threadId: approvalThreadId,
          ...(requestRunId ? { runId: requestRunId } : {}),
          requestId: `${params.runtime.sessionId}:${toolName}:${crypto.randomUUID()}`,
          toolUseId: `plugin-sensitive:${toolName}`,
          toolName,
          risk: "high",
          reason: gateResult.reason ?? `插件 ${gateResult.pluginId} 请求敏感能力 ${gateResult.capabilityKey}`,
          reasonCode: "plugin_sensitive_review",
          input,
          pluginSensitive: { pluginId: gateResult.pluginId, capabilityKey: gateResult.capabilityKey },
        };
        let pluginTimedOut = false;
        const pluginDecision = await waitForToolPermissionDecision(
          pluginRequest,
          askUserSignal,
          (req) => emit.onToolPermissionRequest(req),
          { onTimeout: () => { pluginTimedOut = true; } },
        );
        if (pluginDecision === "allow_always") {
          // Persist workspace-scoped approval so the next attempt's checkSensitiveCapability returns allow.
          try {
            await pluginPermissionRuntime.appendSensitiveApproval({
              pluginId: gateResult.pluginId,
              record: {
                key: gateResult.capabilityKey as never,
                scope: "workspace",
                ...(prepared.workspaceSlug ? { workspaceSlug: prepared.workspaceSlug } : {}),
                decision: "allow",
                createdAt: new Date().toISOString(),
                permissionsHash: "", // accepted hash resolved at read time via collectSensitiveApprovals; empty is tolerated by resolveSensitiveApproval (it matches on key+scope+decision)
              },
            });
          } catch (error) {
            log.warn("Plugin sensitive approval persist failed; allowing once only", { pluginId: gateResult.pluginId, error: error instanceof Error ? error.message : String(error) });
          }
          return { behavior: "allow" };
        }
        if (pluginDecision === "allow_once") {
          return { behavior: "allow" };
        }
        // deny / timeout / null (aborted)
        recordPermissionDenial({
          threadId: params.runtime.sessionId,
          descriptor,
          toolName,
          rawInput: input,
          reasonCode: pluginTimedOut ? "approval_timeout" : "user_denied",
        });
        return { behavior: "deny", message: pluginTimedOut ? `插件权限确认超时: ${toolName}` : `用户拒绝执行插件工具: ${toolName}` };
      }
    }
```

(Confirm: `AgentToolPermissionRequest` + `waitForToolPermissionDecision` are imported. `crypto.randomUUID` — confirm `crypto` is imported (the test files use `crypto.randomUUID()`); if not, import from `node:crypto`. `approvalThreadId` / `requestRunId` — confirm their names match the surrounding code. The `permissionsHash: ""` note: verify `resolveSensitiveApproval` (permission-gate.ts:37-69) does NOT require a non-empty hash to match — it matches on `key + scope + workspaceSlug + decision` only. If it DOES require hash, resolve the accepted hash via the install record instead — read `resolveAcceptedHash` usage. Adjust accordingly.)

- [ ] **Step 3: Verify typecheck + regression**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "attempt.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts
```
Expected: no new attempt.ts errors; tests pass. **CRITICAL:** `应从 Lume plugin 目录加载命令型插件工具` (run.test.ts) still passes — its `demo` plugin's command tool, when `checkSensitiveCapability` returns `allow` (loaded plugin with no prior deny), goes through the `allow` branch unchanged. The `ask`/`block` branches only fire for plugins actually requiring approval.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
git commit -m "✨ feat(sidecar): attempt call-gate ask 分支接入 waitForToolPermissionDecision（Phase 4A 交互审批 + allow_always 持久化）"
```

---

## Task 5: `PermissionBanner` plugin dimension rendering

**Files:**
- Modify: `apps/web/src/components/agent/PermissionBanner.tsx`

- [ ] **Step 1: READ the current banner**

Read `PermissionBanner.tsx` — the info block (~L99-120) renders `request.toolName`, risk badge, `request.reason`, `request.reasonCode`. The `pluginSensitive` field (added in Task 3) is now on the request type.

- [ ] **Step 2: Render the plugin dimension**

In the info block, after the `request.reason` paragraph (~L111), add a conditional plugin line when `request.pluginSensitive` is present:

```tsx
          <p className="mt-0.5 text-[12px] leading-5 text-[#8a8f98]">{request.reason}</p>
          {request.pluginSensitive && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-[#8a8f98]">
              <span className="rounded-full bg-[#f0f1f3] px-1.5 py-0.5 font-mono text-[#5c626d]">{request.pluginSensitive.pluginId}</span>
              <span className="font-mono">{request.pluginSensitive.capabilityKey}</span>
            </div>
          )}
```

(Place it inside the `px-1 pb-1.5` div, after the reason `<p>`. Single-quote style to match the file. The pluginId + capabilityKey badges give the user the context to decide allow/deny.)

- [ ] **Step 3: Verify typecheck (web)**

Run: `cd apps/web && bun x tsc --noEmit 2>&1 | grep "PermissionBanner" | head`
Expected: no new errors.

- [ ] **Step 4: Manual behavior note**

No component-test harness. Manual: when a plugin tool triggers `ask`, the banner now shows the pluginId + capability key badges above the allow-once/allow-always/deny buttons. allow_always persists a workspace-scoped approval (next call is auto-allowed). allow_once runs once. deny/timeout blocks.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/PermissionBanner.tsx
git commit -m "✨ feat(web): PermissionBanner 展示插件敏感能力维度（pluginId + capabilityKey，Phase 4A）"
```

---

## Task 6: Regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full regression (from repo root)**

```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 new FAIL. The new `sensitive-gate` ask tests + `plugin-state-store` append test pass; existing command-tool/MCP/hook gate tests pass (update any that assumed ask→block). `run.test.ts` demo-plugin path unaffected.

- [ ] **Step 2: Boundary — Phase 4A change set**

Phase 4A base = the 3d-reload HEAD (commit before Task 1 of this plan). The change set should be exactly:
```bash
git diff --name-only <4a-base>..HEAD
```
Expected: `sensitive-gate.ts`, `sensitive-gate.test.ts`, `plugin-state-store.ts`, `plugin-state-store.test.ts`, `permission-runtime.ts`, `packages/shared/src/types/agent.ts`, `attempt.ts`, `PermissionBanner.tsx`, + this plan doc. **No other files** — in particular NOT `plugin-mcp-bridge.ts`, `plugin-hooks-bridge.ts`, `tool-permission-session.ts`, `permission-gate.ts` (SDK), `run.ts`.

- [ ] **Step 3: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test: Phase 4A 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`. (Test commands that use repo-root-relative paths must run from root; the `runtime-event-boundary` + `run.test.ts` suites are cwd-sensitive — run from root or from `apps/sidecar` consistently per the suite. When in doubt, run a suite from both and compare, but the canonical run is repo-root for cross-package suites, `apps/sidecar` for sidecar-only `./src/...` paths.)
- **This is additive to the existing tool-permission pipeline.** Do NOT modify `waitForToolPermissionDecision`, `tool-permission-session.ts`, or the built-in `approval_required` path. The plugin `ask` branch builds its own request + calls the same `waitForToolPermissionDecision` function.
- **`permissionsHash` in appendSensitiveApproval (Task 4).** Verify `resolveSensitiveApproval` (permission-gate.ts:37-69) does not gate on a non-empty hash — it matches `key + scope + workspaceSlug + decision`. If it DOES require hash, resolve the accepted hash from the install record (`resolveAcceptedHash`-style logic) instead of `""`. Read the function before finalizing Task 4 Step 2.
- **`ask` vs `deny` distinction is the crux.** `checkSensitiveCapability` returns `ask` when there's NO prior record (prompt) and `deny` when there's a prior deny record (hard block). Don't collapse them. The Task 1 tests guard this.
- **call gate only.** `plugin-mcp-bridge.ts` (start gate) + `plugin-hooks-bridge.ts` (hook gate) keep ask→block. Do NOT touch them.
- **`allow_always` is workspace-scoped.** `scope: "workspace"` + the current `workspaceSlug`. Global scope is a later refinement.
- **No audit events in Phase 4A.** The `sensitive_approval`/`sensitive_denial` PluginAuditEvent types land with Plan B. Phase 4A persists the approval (plugins-state.json) but does NOT write plugins-audit.jsonl.
- **Do not "improve" adjacent code.** Per CLAUDE.md §3, only the named files.
- **RTK prefix** for sidecar/sdk tests: `rtk bun test ...`. Web typecheck: `bun x tsc`.
