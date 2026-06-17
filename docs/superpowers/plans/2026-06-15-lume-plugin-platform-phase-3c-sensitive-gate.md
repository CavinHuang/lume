# Lume Plugin Platform Phase 3c — Sensitive Capability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3c of the plugin platform — the runtime **sensitive capability gate**: before a plugin-sourced command tool executes, check `PluginPermissionRuntime.checkSensitiveCapability` and block (deny) when there is no prior approval (`ask`/`deny`), emitting a `permission_review_required` denial. This is the first runtime enforcement of the Phase 2 sensitive-gate decision logic (which until now was only unit-tested, never called in production).

**Architecture:** A pure function `evaluatePluginSensitiveGate({ descriptor, runtime, workspaceSlug })` in `plugins/sensitive-gate.ts` recovers the source `pluginId` from `descriptor.definition.runtimeMetadata.pluginId` (written by the Phase 3b bridge), builds the `SensitiveCapabilityKey` `commandTool:${name}`, calls `PluginPermissionRuntime.checkSensitiveCapability`, and returns `{ decision: "allow" | "block"; reason? }`. Non-plugin tools (no `runtimeMetadata.pluginId`) pass through untouched (spec §8.2 source binding). `createCanUseToolHandler` (`attempt.ts`) calls this gate **after** the descriptor lookup and **before** `toolExecutionGateway.authorize`, blocking with `{ behavior: "deny" }` + `recordPermissionDenial(reasonCode: "permission_review_required")` when the gate blocks. The Phase 1 manifest-list interceptor (`createPluginPermissionInterceptor`) is **kept** (it owns hard-deny of `permissions.tools.deny`); the sensitive gate is an additional layer, not a replacement. A `PluginPermissionRuntime` instance is constructed in `runRuntimeCoreAttempt` (same state-store path as `SidecarPluginManager`) and threaded into `createCanUseToolHandler`.

**Tech Stack:** TypeScript, Bun test, existing `@lume/agent-sdk` gate exports (`SensitiveCapabilityKey`), Phase 2 `PluginPermissionRuntime` (`checkSensitiveCapability`) + `FilePluginStateStore`, Phase 3b's `runtimeMetadata.pluginId` on plugin command-tool `ToolDefinition`s, existing `recordPermissionDenial` + `getRuntimeToolDescriptor`.

---

## Scope

Implements the **sensitive-use gating** slice of [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §8.1 (confirmation timing: first sensitive runtime) + §8.2 (source binding) + §14.2 (sensitive default-block) + §14.3 (plugin sensitive capabilities pass through the Phase 2 gate):

- New `evaluatePluginSensitiveGate` pure function: `descriptor.runtimeMetadata.pluginId` → `commandTool:${name}` key → `checkSensitiveCapability` → allow/block.
- Wire the gate into `createCanUseToolHandler` (`attempt.ts`) after descriptor lookup, before `toolExecutionGateway.authorize`.
- Construct `PluginPermissionRuntime` in `runRuntimeCoreAttempt` and thread it into `createCanUseToolHandler`.
- `ask` and `deny` both → `behavior: "deny"` + `recordPermissionDenial(reasonCode: "permission_review_required")` (Phase 2's "ask → block" convention; Phase 4 replaces block-on-ask with an interactive prompt).
- Non-plugin tools unaffected (no `pluginId` → allow).

**Out of scope (deferred):**

- **MCP call gating** (`mcpServer:${id}` key) — plugin MCP merge is a separate plan (§16.7); once plugin MCP tools exist, extend the gate to recognize them.
- **Hook fire gating** (`hook:${event}:${matcher}` key) — Phase 3d (plugin hooks are inert until 3d rebuilds registration).
- **Filesystem-write / network first-use gating** (`filesystem:write:${path}` / `network:${host}`) — the Phase 1 interceptor already enforces the manifest `permissions.filesystem`/`network` lists; first-use sensitive confirmation for those is a later extension. 3c covers **command tools only** (the first plugin capability that reaches the runtime end-to-end).
- **`PluginAuditLog`** (spec §8.3) — not implemented anywhere; 3c uses the existing in-memory `recordPermissionDenial`. Persistent audit is Phase 4.
- **Interactive confirmation UI** — Phase 4 (3c blocks on `ask`).
- **Migrating/rewriting the Phase 1 `createPluginPermissionInterceptor`** — kept as-is (see Design Decision 1).

**Constraints:**

- **Source binding (§8.2):** a plugin's gate ONLY affects that plugin's tools (keyed by `runtimeMetadata.pluginId`). Built-in tools (no `pluginId`) are never blocked by the plugin gate. Plugin hard-deny (`permissions.tools.deny`) cannot be bypassed by `bypassPermissions` — that stays in the Phase 1 interceptor.
- **Touch surface:** `attempt.ts` (construct runtime + thread param + gate call site), new `sensitive-gate.ts` + test. Do NOT touch `run.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `workspace-mcp-manager.ts`, `agent.ts`, `hooks.ts`.
- Legacy command plugins (Phase 3b fast-paths them to `permissionState: loaded`) still go through this gate — they have no prior sensitive approval, so their first command-tool exec will block (`ask` → deny) until Phase 4 adds confirmation. That is the correct §8.1 behavior (legacy = unmediated subprocess → first-use confirmation).
- Match Phase 1/2/3a/3b style: 2-space indent, double quotes in sidecar, no `any`, `bun:test`.

## Design Decisions

1. **Layer, don't replace — the Phase 1 interceptor stays.** The Phase 3b plan's out-of-scope note said the interceptor path is "rewritten in Phase 3c with the sensitive gate." On investigation, the Phase 1 `createPluginPermissionInterceptor` enforces the manifest-declared `permissions.tools.deny` (hard-deny, unbypassable per §8.2) plus filesystem/network lists — that's a different dimension from the sensitive-gate's review-state check. Removing it would lose hard-deny semantics. So 3c **adds** the sensitive gate as a new layer (after descriptor lookup) and **keeps** the Phase 1 interceptor (manifest list, in the existing interceptor loop). They compose: manifest hard-deny (interceptor) → sensitive review-state (new gate) → global gateway.

2. **Gate placement: after descriptor lookup, before `toolExecutionGateway.authorize`.** The gate needs `descriptor.definition.runtimeMetadata.pluginId`, which only exists after `getRuntimeToolDescriptor` succeeds (attempt.ts:238). Placing it before the global gateway means a plugin's sensitive block takes precedence over (and short-circuits) the global permission engine — correct, because plugin gating is source-bound and should not leak into the global engine's logic.

3. **Pure-function extraction for testability.** `evaluatePluginSensitiveGate` is a standalone async function taking `{ descriptor, runtime, workspaceSlug }`. It's fully unit-testable with a fake `PluginPermissionRuntime` (or a real one over a temp `FilePluginStateStore`). `attempt.ts` only wires it in — the gate logic is not embedded in the deep `createCanUseToolHandler` body, so it can be tested without spinning up a runtime session.

4. **`pluginId` from `runtimeMetadata`, not tool name.** Phase 3b deliberately dropped command-tool name namespacing in favor of `definition.runtimeMetadata.pluginId` (see the 3b plan's "Execution Adjustments"). The gate reads `descriptor.definition.runtimeMetadata?.pluginId`. A tool without it is a built-in → allow (§8.2). `runtimeMetadata` survives tool wrapping (`tool-runtime-wrapper.ts:22-38`) and descriptor construction (`createToolDescriptorsFromDefinitions` preserves it).

5. **`ask` folds to `deny` (not `ask`).** `CanUseToolResult` supports `behavior: "ask"`, but the downstream approval-prompt flow (attempt.ts:454+) expects an interactive UI that plugin sensitive approval doesn't have yet — returning `ask` would hang. Per Phase 2's convention ("ask → block + diagnostic, no confirmation UI until Phase 4"), 3c maps both `ask` and `deny` from `checkSensitiveCapability` to `{ behavior: "deny", message }` + `recordPermissionDenial(reasonCode: "permission_review_required")`. Phase 4 replaces this with a real prompt that can record an approval and re-allow.

6. **Capability key: `commandTool:${name}` only in 3c.** Spec §16.4's `SensitiveCapabilityKey` union covers command tools, MCP, hooks, network, filesystem-write, and builtin tools. 3c implements only `commandTool:${descriptor.definition.name}` (the first plugin capability wired end-to-end). The `evaluatePluginSensitiveGate` function is structured so adding MCP/hook/etc. keys later is a localized extension (switch on a capability-type field), but 3c ships the command-tool path.

7. **`PluginPermissionRuntime` constructed per-attempt, same state path as `SidecarPluginManager`.** `PluginPermissionRuntime` is stateless (all state is in the `FilePluginStateStore` file), so constructing one per `runRuntimeCoreAttempt` is correct and matches how `plugin-registry.ts:254` already constructs a throwaway instance for `computeRuntimeState`. The state path is `~/.lume/plugins-state.json` (same default `SidecarPluginManager` uses). NOTE: this duplicates the path literal — acceptable for 3c (surgical); a future cleanup can expose a shared accessor on `SidecarPluginManager`.

8. **Audit = existing `recordPermissionDenial`.** `PluginAuditLog` (§8.3) is not implemented anywhere. 3c records denials via the existing in-memory `recordPermissionDenial` (which feeds `getPermissionDeniedSummary` back to the model to prevent retry loops). Persistent audit events (`sensitive_denial`/`capability_blocked`) are Phase 4.

## File Structure

Sidecar (the gate + wiring):

- Create `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts` — `evaluatePluginSensitiveGate({ descriptor, runtime, workspaceSlug }): Promise<{ decision: "allow" | "block"; reason? }>`.
- Create `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts` — unit tests with a fake `PluginPermissionRuntime`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/index.ts` — export `evaluatePluginSensitiveGate` + its types.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts` — construct `PluginPermissionRuntime` in `runRuntimeCoreAttempt` (~line 630); add `pluginPermissionRuntime?` param to `createCanUseToolHandler`; call `evaluatePluginSensitiveGate` after the descriptor lookup (~line 257), blocking with `deny` + `recordPermissionDenial` when it blocks; thread the runtime through the `createCanUseTool` factory (~line 655).

No SDK changes. No changes to `run.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`.

---

## Chunk 1: `evaluatePluginSensitiveGate` pure function

The gate logic, isolated and unit-testable.

### Task 1: Implement `evaluatePluginSensitiveGate`

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { evaluatePluginSensitiveGate } from "./sensitive-gate.js";
import type { LumeToolDescriptor } from "../tools/tool-types.js";
import type { PluginPermissionRuntime, SensitiveCheckResult } from "./permission-runtime.js";

/** Build a fake runtime returning a fixed decision for any key. */
function fakeRuntime(decision: SensitiveCheckResult["decision"]): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability(): Promise<SensitiveCheckResult> {
      return { decision, reason: decision === "allow" ? "prior allow" : "no prior approval" };
    },
  } as unknown as PluginPermissionRuntime;
}

function descriptor(name: string, pluginId?: string): LumeToolDescriptor {
  return {
    name,
    canonicalName: name,
    source: "plugin",
    definition: {
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      async call() { return { type: "tool_result", tool_use_id: "", content: "" }; },
      ...(pluginId ? { runtimeMetadata: { source: "plugin", pluginId } } : {}),
    },
  } as unknown as LumeToolDescriptor;
}

describe("evaluatePluginSensitiveGate", () => {
  test("allows a non-plugin tool (no runtimeMetadata.pluginId)", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("Bash"),
      runtime: fakeRuntime("deny"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("allow");
  });

  test("allows a plugin tool when checkSensitiveCapability returns allow", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("echo", "acme"),
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("allow");
  });

  test("blocks a plugin tool when checkSensitiveCapability returns deny", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("echo", "acme"),
      runtime: fakeRuntime("deny"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("acme");
    expect(result.reason).toContain("commandTool:echo");
  });

  test("blocks a plugin tool when checkSensitiveCapability returns ask (Phase 2 ask→block)", async () => {
    const result = await evaluatePluginSensitiveGate({
      descriptor: descriptor("echo", "acme"),
      runtime: fakeRuntime("ask"),
      workspaceSlug: "ws",
    });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("acme");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`
Expected: FAIL — `Cannot find module "./sensitive-gate.js"`.

- [ ] **Step 3: Implement `evaluatePluginSensitiveGate`**

Create `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts`:

```ts
import type { LumeToolDescriptor } from "../tools/tool-types.js";
import type { PluginPermissionRuntime } from "./permission-runtime.js";
import type { SensitiveCapabilityKey } from "@lume/agent-sdk";

export interface SensitiveGateInput {
  descriptor: LumeToolDescriptor;
  runtime: PluginPermissionRuntime;
  workspaceSlug?: string;
}

export interface SensitiveGateResult {
  decision: "allow" | "block";
  reason?: string;
}

/**
 * Phase 3c sensitive capability gate (design spec §8.1/§8.2/§14.2).
 *
 * For a plugin-sourced tool (descriptor.definition.runtimeMetadata.pluginId present),
 * check PluginPermissionRuntime.checkSensitiveCapability with a `commandTool:${name}`
 * key. `allow` → pass; `deny` OR `ask` → block (Phase 2's ask→block convention; Phase 4
 * replaces block-on-ask with an interactive prompt). Non-plugin tools (no pluginId)
 * pass through untouched (§8.2 source binding: built-in tools are unaffected by plugin
 * permissions).
 *
 * 3c covers command tools only. MCP (`mcpServer:`), hooks (`hook:`), network, and
 * filesystem-write keys are deferred (MCP: §16.7 plan; hooks: Phase 3d; fs/net:
 * later extension).
 */
export async function evaluatePluginSensitiveGate(
  input: SensitiveGateInput,
): Promise<SensitiveGateResult> {
  const definition = input.descriptor.definition as {
    name: string;
    runtimeMetadata?: { pluginId?: string };
  };
  const pluginId = definition.runtimeMetadata?.pluginId;
  if (!pluginId) {
    return { decision: "allow" };
  }

  const key: SensitiveCapabilityKey = `commandTool:${definition.name}`;
  const result = await input.runtime.checkSensitiveCapability({
    pluginId,
    key,
    workspaceSlug: input.workspaceSlug,
  });

  if (result.decision === "allow") {
    return { decision: "allow" };
  }

  return {
    decision: "block",
    reason: `Plugin ${pluginId} capability ${key} blocked (sensitive, ${result.decision}): ${result.reason}`,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`
Expected: PASS — all four tests pass.

- [ ] **Step 5: Export from the barrel**

In `apps/sidecar/src/services/agent-runtime/plugins/index.ts`, add:

```ts
export { evaluatePluginSensitiveGate } from "./sensitive-gate.js";
export type { SensitiveGateInput, SensitiveGateResult } from "./sensitive-gate.js";
```

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 新增 evaluatePluginSensitiveGate 纯函数"
```

---

## Chunk 2: Wire the gate into `createCanUseToolHandler`

Construct `PluginPermissionRuntime`, thread it into `createCanUseToolHandler`, and call `evaluatePluginSensitiveGate` after the descriptor lookup. This is the runtime-enforcement step.

### Task 2: Construct + thread `PluginPermissionRuntime`, call the gate

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts`

- [ ] **Step 1: READ the current code**

Read `attempt.ts:135-160` (`createCanUseToolHandler` signature + the `pluginInterceptors` setup), `attempt.ts:238-291` (descriptor lookup → `toolExecutionGateway.authorize` → deny pattern), and `attempt.ts:625-657` (`runRuntimeCoreAttempt`'s `pluginManager` construction + the `createCanUseTool` factory). Confirm exact text before editing.

- [ ] **Step 2: Add the import + construct the runtime in `runRuntimeCoreAttempt`**

At the top of `attempt.ts`, add imports near the existing plugin imports:

```ts
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { FilePluginStateStore } from "../plugins/plugin-state-store.js";
import { evaluatePluginSensitiveGate } from "../plugins/sensitive-gate.js";
import { homedir } from "node:os";
import { join } from "node:path";
```

(If `homedir`/`join` are already imported, do not duplicate. If `PluginPermissionRuntime`/`FilePluginStateStore` are already imported via the barrel, use those import paths instead — check existing imports first.)

Then in `runRuntimeCoreAttempt`, right AFTER the `pluginInterceptorContexts` construction (~line 634, after the `await pluginManager.buildInterceptorContexts(...)` call), add:

```ts
  // Phase 3c: sensitive-capability gate runtime. Stateless (state lives in the
  // FilePluginStateStore file); same state path SidecarPluginManager uses.
  const pluginPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(join(homedir(), ".lume", "plugins-state.json")),
  });
```

- [ ] **Step 3: Add `pluginPermissionRuntime` param to `createCanUseToolHandler`**

In the `createCanUseToolHandler` signature (~line 135-142), add a new optional parameter AFTER `pluginInterceptorContexts?`:

```ts
export function createCanUseToolHandler(
  params: AgentRuntimeRunParams,
  prepared: PreparedRuntimeCoreAttempt,
  emit: AgentRuntimeEmitter,
  askUserSignal: AbortSignal,
  runId?: string,
  workflowHooks?: LumeWorkflowHookRuntimeLike,
  pluginInterceptorContexts?: Array<{ pluginName: string; pluginRoot: string; permissions: Record<string, unknown> }>,
  pluginPermissionRuntime?: PluginPermissionRuntime,
): CanUseToolFn
```

- [ ] **Step 4: Call the gate after the descriptor lookup**

Inside the returned `CanUseToolFn` (the `return async (tool, input, metadata) => {` body), find the descriptor-lookup block (the `const descriptor = getRuntimeToolDescriptor(...)` + the `if (!descriptor) { ... return deny }` block, ~line 238-257). Immediately AFTER that block (after the `}` closing the `if (!descriptor)` block, BEFORE `const authorization = await toolExecutionGateway.authorize(...)` at ~line 258), insert the gate:

```ts
    // Phase 3c: plugin sensitive-capability gate (§8.1/§8.2). Source-bound: only
    // affects tools whose descriptor carries runtimeMetadata.pluginId. Runs after
    // descriptor lookup (needs pluginId from definition.runtimeMetadata) and before
    // the global gateway. ask/deny both → block (Phase 2 ask→block; Phase 4 adds UI).
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
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: "plugin_sensitive_blocked",
        });
        return {
          behavior: "deny",
          message: gateResult.reason ?? `Plugin tool ${toolName} blocked by sensitive-capability gate.`,
        };
      }
    }
```

(Match the surrounding 2-space indent and the existing deny/log pattern from the `descriptor_missing` and `authorization.status === "deny"` blocks above/below.)

- [ ] **Step 5: Thread the runtime through the `createCanUseTool` factory**

In the `return runner.runPreparedRuntimeCoreAttempt({...})` call (~line 651-657), the `createCanUseTool` factory currently is:

```ts
    createCanUseTool: (askUserSignal, workflowHooks) =>
      createCanUseToolHandler(params, prepared, runner.emit, askUserSignal, runner.getRunId(), workflowHooks, pluginInterceptorContexts)
```

Add `pluginPermissionRuntime` as the new last argument:

```ts
    createCanUseTool: (askUserSignal, workflowHooks) =>
      createCanUseToolHandler(params, prepared, runner.emit, askUserSignal, runner.getRunId(), workflowHooks, pluginInterceptorContexts, pluginPermissionRuntime)
```

- [ ] **Step 6: Verify typecheck + regression**

Run:
```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "attempt.ts" | head
```
Expected: no NEW `attempt.ts` errors (pre-existing unrelated sidecar failures out of scope).

Then run:
```bash
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: all PASS, 0 FAIL. **The `应从 Lume plugin 目录加载命令型插件工具` test (run.test.ts:502) should STILL PASS** — its `demo` legacy plugin's `demo_echo` tool has no prior sensitive approval, BUT the test only calls `getActiveToolNames()` / `getRuntimeToolDescriptor()` (it does NOT actually EXECUTE the tool through `canUseTool`), so the gate is never invoked. If that test now fails, the gate is firing at registration time (wrong) — re-check placement (it must be inside the `canUseTool` handler, not at session build).

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
git commit -m "✨ feat(sidecar): createCanUseToolHandler 接入 sensitive-capability gate"
```

---

## Chunk 3: Integration test + regression + boundary

Add one integration-level test proving the gate blocks a real plugin tool exec end-to-end, then full regression + boundary.

### Task 3: Integration test — gate blocks an unapproved plugin command tool exec

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `run.test.ts` (inside its top-level `describe`), a test that builds a session with a legacy `demo` plugin (which has NO prior sensitive approval → `checkSensitiveCapability` returns `ask`), then invokes the agent's `canUseTool` for `demo_echo` and asserts it blocks. READ the existing `应从 Lume plugin 目录加载命令型插件工具` test (run.test.ts:502-563) first to reuse its setup (configDir/cwd/pluginDir/plugin.json/enabled). The new test:

```ts
  test("未审批的插件 command tool 执行被 sensitive gate 阻断（§8.1/§14.2）", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-plugin-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-plugin-cwd-"));
    const agentDir = join(cwd, ".runtime-core-test");
    const pluginDir = join(cwd, ".lume", "plugins", "demo");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "demo",
        tools: [{
          name: "demo_echo",
          description: "Echo demo payload",
          command: "node",
          args: ["-e", "process.stdout.write(process.env.PLUGIN_INPUT || '')"],
        }],
      }),
      "utf-8",
    );
    updateLumeConfigSection({ source: "system", path: "plugins.enabled", value: ["demo"] });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "plugin-gate-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
    });

    // The demo plugin has no install record and no prior sensitive approval, so
    // checkSensitiveCapability returns "ask" → gate blocks (Phase 2 ask→block).
    // Invoke the agent's canUseTool path the same way the runner does.
    const agent = (result.session as unknown as { agent?: { canUseTool?: (tool: unknown, input: unknown) => Promise<{ behavior: string; message?: string }> } }).agent;
    // If the agent/canUseTool isn't directly accessible on session, fall back to
    // asserting via the descriptor + a direct evaluatePluginSensitiveGate call:
    if (!agent?.canUseTool) {
      const { evaluatePluginSensitiveGate } = await import("../plugins/sensitive-gate.js");
      const { PluginPermissionRuntime } = await import("../plugins/permission-runtime.js");
      const { FilePluginStateStore } = await import("../plugins/plugin-state-store.js");
      const runtime = new PluginPermissionRuntime({
        stateStore: new FilePluginStateStore(join(homedir(), ".lume", "plugins-state.json")),
      });
      const descriptor = getRuntimeToolDescriptor("plugin-gate-session", "demo_echo");
      expect(descriptor).toBeDefined();
      const gate = await evaluatePluginSensitiveGate({
        descriptor: descriptor!,
        runtime,
        workspaceSlug: undefined,
      });
      expect(gate.decision).toBe("block");
      expect(gate.reason).toContain("commandTool:demo_echo");
    } else {
      const decision = await agent.canUseTool(
        { name: "demo_echo", description: "demo_echo", inputSchema: { type: "object", properties: {} }, runtimeMetadata: { source: "plugin", pluginId: "demo" } },
        {},
      );
      expect(decision.behavior).toBe("deny");
      expect(decision.message).toContain("demo");
    }

    result.session.dispose();
  });
```

NOTE for the implementer: the direct-`canUseTool` path may not be reachable on `result.session` (the agent is internal). The fallback (descriptor + `evaluatePluginSensitiveGate` over the real `PluginPermissionRuntime`) is the robust assertion — it proves the gate blocks `demo_echo` given the real (empty) approval state. Prefer the fallback if `agent.canUseTool` isn't accessible. If NEITHER path works cleanly, simplify to just the fallback (delete the `if/else` and keep the descriptor + gate assertion). The goal is one assertion that `demo_echo` (a registered plugin tool with no approval) is gated as `block`.

- [ ] **Step 2: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "sensitive gate"`
Expected: PASS — the gate returns `block` for `demo_echo` (no prior approval).

(If it fails because `getRuntimeToolDescriptor` doesn't find `demo_echo` under sessionId `plugin-gate-session`, the descriptor session keying differs — read how `应从 Lume plugin 目录加载命令型插件工具` accesses the descriptor (run.test.ts:552) and match its sessionId. Adapt the test to the actual keying.)

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
git commit -m "✅ test(sidecar): 集成测试验证 sensitive gate 阻断未审批插件 command tool"
```

### Task 4: Full regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Run the full Phase 1+2+3a+3b+3c suite**

Run:
```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 FAIL. Pre-3c baseline was 145 (Phase 1+2+3a+3b); 3c adds ~5 (sensitive-gate.test.ts ×4 + the integration test). Any Phase 1/2/3a/3b test failing = regression → STOP and report.

- [ ] **Step 2: Boundary — confirm 3c's touch surface**

Phase 3c base = commit `0cd12d88` (3b plan-update commit = 3c start). 3c must NOT touch `run.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `workspace-mcp-manager.ts`, `agent.ts`, `hooks.ts`:

```bash
git diff --name-only 0cd12d88..HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.ts packages/sdk/src/agent.ts packages/sdk/src/hooks.ts
```
Expected: EMPTY.

Then the full 3c change set:
```bash
git diff --name-only 0cd12d88..HEAD
```
Expected: exactly `sensitive-gate.ts` (new), `sensitive-gate.test.ts` (new), `plugins/index.ts` (export), `attempt.ts` (wiring), `run.test.ts` (integration test), + this plan doc.

- [ ] **Step 3: Static confirmation the gate is live**

```bash
grep -n "evaluatePluginSensitiveGate\|pluginPermissionRuntime" apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
```
Expected: `evaluatePluginSensitiveGate` imported + called; `pluginPermissionRuntime` constructed + threaded.

- [ ] **Step 4: Commit final state (only if unstaged)**

If `git status --short` shows only `docs/superpowers/handoffs/`, skip. Otherwise commit with `✅ test(sidecar): Phase 3c sensitive gate 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`.
- **`attempt.ts` is large and central.** Task 2 is the risky step. READ the exact current text of `attempt.ts:135-160`, `:238-291`, `:625-657` before editing (line numbers drift). Match the existing deny/log pattern exactly. If the `createCanUseToolHandler` signature or the `createCanUseTool` factory differs from what's described, adapt and note the deviation.
- **`PluginPermissionRuntime`/`FilePluginStateStore` imports.** They are exported from `apps/sidecar/src/services/agent-runtime/plugins/index.ts` (Phase 2). Import from there OR from their source files (`./permission-runtime.js`, `./plugin-state-store.js` relative to attempt.ts: `../plugins/...`). Match existing import style in attempt.ts.
- **`homedir`/`join` imports.** Check if already imported in attempt.ts; if so, reuse. The state path `~/.lume/plugins-state.json` MUST match `SidecarPluginManager`'s default (`plugin-manager.ts:19`).
- **The integration test (Task 3) may need adaptation.** The `result.session.agent.canUseTool` path may not be directly accessible. The fallback (descriptor + `evaluatePluginSensitiveGate` over the real runtime) is the robust assertion — prefer it. If descriptor session keying differs, match the existing `应从 Lume plugin 目录加载命令型插件工具` test's access pattern (run.test.ts:552).
- **Do not "improve" adjacent code.** Per `CLAUDE.md` §3, only touch the files this plan names. The Phase 1 interceptor stays; do not refactor it.
- **RTK prefix.** `rtk bun test ...` / `bun x tsc ...`; plain `bun` works as fallback.
