# Lume Plugin Platform MCP Merge-A — Plugin MCP Data Wiring + Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build MCP Merge-A — wire plugin-declared MCP servers (from the Phase 3a resolver's `ResolvedMcpServer[]`) into the agent runtime via a **plugin-scoped transient `WorkspaceMcpManager`** (independent of the per-workspace singleton), so plugin MCP tools reach `createAgent`, with §16.7 connection lifecycle (plugin MCP child processes / network connections stop on session dispose). No §8.1 gating in A (deferred to MCP Merge-B).

**Architecture:** `assemblePluginRuntime` is extended to carry `mcpServers: ResolvedMcpServer[]`. A new pure factory `buildPluginMcpManager(servers)` namespaces each server id as `${pluginId}:${serverId}` (cross-plugin collision avoidance) and constructs a TRANSIENT `new WorkspaceMcpManager({ readConfig: () => ({ servers: namespaced }) })` — fully independent of the `getWorkspaceMcpManager()` singleton, so plugin servers NEVER pollute the workspace MCP pool (the singleton's `workspaces` Map, used by the settings UI / status RPCs). `createRuntimeCoreSession` builds this manager, calls `createRuntimeTools("__plugin__")` (a distinct slug so its connection pool is isolated), injects the resulting tools as a new `pluginMcpTools` group into `buildRuntimeCoreTools`, and `dispose()`s the manager in the session cleanup (§16.7). Reuses `WorkspaceMcpManager` + `McpClientManager` unchanged (same `StdioClientTransport`/HTTP/SSE spawn, retry, tool enumeration).

**Tech Stack:** TypeScript, Bun test, existing `@lume/shared` MCP types (`McpServerEntry`, `WorkspaceMcpConfig`), existing `WorkspaceMcpManager` (constructed with a custom `readConfig`), Phase 3a `ResolvedMcpServer` + Phase 3b `assemblePluginRuntime`/`PluginRuntimeAssembly`.

---

## Scope

Implements the **plugin MCP data wiring + connection lifecycle** slice of [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §6.4 (`PluginRuntimeBridge`: "将插件 MCP servers 合并进现有 MCP server config") + §14.3 (plugin declared capabilities reach runtime) + §16.7 (MCP lifecycle boundary):

- Extend `PluginRuntimeAssembly` to carry `mcpServers: ResolvedMcpServer[]`.
- New `buildPluginMcpManager(servers)` factory: namespace ids + construct a transient `WorkspaceMcpManager`.
- Wire `pluginMcpTools` into `buildRuntimeCoreTools` (new group) + `createRuntimeCoreSession` (build manager, call `createRuntimeTools("__plugin__")`, dispose on session end).

**Out of scope (deferred to MCP Merge-B):**

- **§8.1 server-start gating** (`mcpServer:${pluginId}:${serverId}` key via `checkSensitiveCapability` before connect) — Merge-B.
- **§8.1 MCP tool-call gating** (needs `createWorkspaceMcpToolDefinitions` to stamp `runtimeMetadata.pluginId` so the Phase 3c `canUseTool` gate picks up plugin MCP tools) — Merge-B.
- **`createWorkspaceMcpConfigTool` / `createWorkspaceMcpResourceTools` filtering** — `createRuntimeTools` returns config/resource management tools too; Merge-A passes ALL returned tools through (the config-tool name collision risk is LOW because plugin pool uses `__plugin__` slug, and `buildMcpToolWrapperName` namespaces by serverId — but verify in Task 4's regression; if a real collision appears, filter to just `createWorkspaceMcpToolDefinitions` output in Merge-B).
- **MCP diagnostics UI surfacing** (the diagnostics flow into `ToolRuntimeBuildResult.mcpDiagnostics` like workspace MCP — fine for now).

**Constraints:**

- **Do NOT modify `workspace-mcp-manager.ts`** — reuse it (`new WorkspaceMcpManager({ readConfig })`). The singleton (`getWorkspaceMcpManager()`) stays the workspace MCP source of truth.
- **Do NOT modify `getWorkspaceMcpConfig`** — the workspace config source of truth stays clean (used by settings UI, status RPC, testServer).
- **Do NOT modify `create-mcp-tools.ts`** in Merge-A (the `runtimeMetadata.pluginId` stamping is Merge-B). Plugin MCP tools in Merge-A are ungated (acceptable for A; B adds the gate).
- **Touch surface:** `runtime-bridge.ts` (extend assembly), new `plugin-mcp-bridge.ts` + test, `run.ts` (build manager + group + dispose), `plugins/index.ts` (exports). Do NOT touch `attempt.ts`, `sensitive-gate.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `workspace-mcp-manager.ts`, `getWorkspaceMcpConfig`, SDK.
- Match Phase 1-3d-hooks style: 2-space indent, double quotes in sidecar, no `any`, `bun:test`.

## Design Decisions

1. **Plugin-scoped TRANSIENT `WorkspaceMcpManager` (research "Option B").** The singleton (`getWorkspaceMcpManager()`) is per-workspace with a shared connection pool (`workspaces` Map by `workspaceSlug`). Plugin servers are per-session (resolver runs per `createRuntimeCoreSession`). Merging into the singleton's `readConfig` would pollute: session 1 (plugin A, server X) would leave X in the pool for session 2 (no plugin A). A TRANSIENT manager (its own `workspaces` Map, own `McpClientManager`) gives zero pollution + natural §16.7 lifecycle (`disposeWorkspace` in session `dispose()`). Reuses ALL of `WorkspaceMcpManager`/`McpClientManager` (spawn, retry, transport, tool enumeration) — no reimplementation.

2. **Server ID namespacing `${pluginId}:${serverId}`.** Two plugins both declaring `"github"` would collide in the `McpClientManager.servers` Map (keyed by serverId) — last-wins. Namespace at config-build time. `buildMcpToolWrapperName` already namespaces TOOL names (`mcp__${serverId}__${tool}`), so tool names stay unique; this only fixes the underlying server-map key.

3. **Distinct slug `"__plugin__"`.** `createRuntimeTools`/`syncWorkspace` key their per-workspace state by `workspaceSlug`. Using `"__plugin__"` (not the real workspace slug) keeps the plugin pool's `WorkspaceState` isolated from any workspace pool state (the singleton never sees `"__plugin__"`).

4. **New `pluginMcpTools` group (source `"plugin"`).** `buildRuntimeCoreTools` gets a `pluginMcpTools?: ToolDefinition[]` param (mirroring the Phase 3b `pluginCommandTools` pattern), pushed as `{ source: "plugin", tools }` when non-empty. Separate from `mcpTools` (workspace MCP) so diagnostics/attribution distinguish them, and so Merge-B can stamp `runtimeMetadata.pluginId` on this group's tools.

5. **`dispose()` stops plugin MCP (§16.7).** The session's `dispose()` (run.ts:~1109) adds `await pluginMcpManager.disposeWorkspace("__plugin__")` — kills child processes / closes connections. `lume-runner.ts:270` already calls `session.dispose()` in `finally`, so plugin MCP stop is bound to the agent lifecycle.

6. **No gate in A (deferred to B).** Plugin MCP tools reach the runtime ungated in A. This is acceptable for A's scope (data wiring + lifecycle); Merge-B adds §8.1 server-start + tool-call gates. (Until B, an unreviewed plugin's MCP tools would run — but plugin MCP is opt-in via `permissions.mcpServers.register`, and the whole plugin still goes through the only-loaded gate at the registry level.)

## File Structure

Sidecar:

- Modify `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts` — add `mcpServers: ResolvedMcpServer[]` to `PluginRuntimeAssembly`; collect `capability.mcpServers` in `assemblePluginRuntime`.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts` — assert the new field.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts` — `buildPluginMcpManager(servers)` factory.
- Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts` — unit test the namespacing + manager construction.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/index.ts` — export `buildPluginMcpManager`.
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` — `buildRuntimeCoreTools` gains `pluginMcpTools?` group; `createRuntimeCoreSession` builds `pluginMcpManager`, calls `createRuntimeTools("__plugin__")`, passes `pluginMcpTools`, disposes on session end.

No changes to `workspace-mcp-manager.ts`, `create-mcp-tools.ts`, `attempt.ts`, `sensitive-gate.ts`, `getWorkspaceMcpConfig`, SDK.

---

## Chunk 1: Extend `PluginRuntimeAssembly` with mcpServers

Carry the resolver's `ResolvedMcpServer[]` through the bridge (currently discarded).

### Task 1: Carry mcpServers in `PluginRuntimeAssembly`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

In `runtime-bridge.test.ts` (which already imports `mkdtemp`/`mkdir`/`writeFile`/`rm`/`tmpdir`/`join` from the Phase 3d-hooks Task 1 work), add a test:

```ts
  test("carries resolved plugin mcpServers (with pluginId + entry) in assembly.mcpServers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bridge-mcp-"));
    try {
      const pluginRoot = join(root, "acme");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "mcp.json"),
        JSON.stringify({ mcpServers: { "acme-api": { command: "node", args: ["server.js"] } } }),
        "utf-8",
      );
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          commandTools: [],
          mcpServersConfigPath: "./mcp.json",
        },
        permissions: { mcpServers: { register: true } },
      });

      const assembly = await assemblePluginRuntime([plugin]);

      expect(assembly.mcpServers).toHaveLength(1);
      expect(assembly.mcpServers[0]?.pluginId).toBe("acme");
      expect(assembly.mcpServers[0]?.serverId).toBe("acme-api");
      expect(assembly.mcpServers[0]?.entry.transport).toBe("stdio");
      expect(assembly.mcpServers[0]?.entry.command).toBe("node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts -t "mcpServers"`
Expected: FAIL — `assembly.mcpServers` is `undefined`.

- [ ] **Step 3: Extend `PluginRuntimeAssembly` + collect mcpServers**

In `runtime-bridge.ts`:

(a) Import `ResolvedMcpServer` from `./capability-resolver.js` (it's defined there, lines 23-27):
```ts
import { resolvePluginCapabilities, type ResolvedMcpServer } from "./capability-resolver.js";
```

(b) Add `mcpServers` to `PluginRuntimeAssembly`:
```ts
export interface PluginRuntimeAssembly {
  commandToolDefinitions: ToolDefinition[];
  skills: SkillDefinition[];
  hooks: Array<{ pluginId: string; hooks: HookConfig }>;
  /** Plugin MCP servers (resolver already gated on permissions.mcpServers.register). */
  mcpServers: ResolvedMcpServer[];
  diagnostics: PluginDiagnostic[];
}
```

(c) In `assemblePluginRuntime`, collect `mcpServers`:
```ts
  const mcpServers: ResolvedMcpServer[] = [];
  for (const capability of resolved.capabilities) {
    // ... existing commandTools + skills + hooks collection ...
    for (const server of capability.mcpServers) {
      mcpServers.push(server);
    }
  }
  return { commandToolDefinitions, skills, hooks, mcpServers, diagnostics: resolved.diagnostics };
```

(`capability.mcpServers` is `ResolvedMcpServer[]` on `ResolvedPluginCapability`, capability-resolver.ts:38.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts`
Expected: PASS — the new test passes; existing tests still pass (check for any `toEqual(assembly)` assertions broken by the new field — update if so).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.test.ts
git commit -m "✨ feat(sidecar): PluginRuntimeAssembly 携带 resolved plugin mcpServers"
```

---

## Chunk 2: `buildPluginMcpManager` factory

Pure factory: namespace server ids + construct a transient `WorkspaceMcpManager`.

### Task 2: Implement `buildPluginMcpManager`

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildPluginMcpManager, PLUGIN_MCP_WORKSPACE_SLUG } from "./plugin-mcp-bridge.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";

const servers: ResolvedMcpServer[] = [
  { pluginId: "acme", serverId: "api", entry: { enabled: true, transport: "stdio", command: "node", args: ["s.js"] } },
  { pluginId: "beta", serverId: "api", entry: { enabled: true, transport: "stdio", command: "deno", args: ["s.ts"] } },
];

describe("buildPluginMcpManager", () => {
  test("constructs a WorkspaceMcpManager (not the singleton)", () => {
    const manager = buildPluginMcpManager(servers);
    expect(manager).toBeDefined();
    // It exposes the createRuntimeTools/disposeWorkspace API surface.
    expect(typeof manager.createRuntimeTools).toBe("function");
    expect(typeof manager.disposeWorkspace).toBe("function");
  });

  test("PLUGIN_MCP_WORKSPACE_SLUG is the distinct __plugin__ slug", () => {
    expect(PLUGIN_MCP_WORKSPACE_SLUG).toBe("__plugin__");
  });
});
```

NOTE: The factory's namespacing (serverId → `${pluginId}:${serverId}`) is an internal detail of the `readConfig` it builds. The strongest test is the integration test in Chunk 4 (Task 4) proving two plugins' servers with the same id don't collide. For the unit test here, assert the manager is constructed with the right shape. If you want to test namespacing directly, add a test that reads the manager's `readConfig` behavior indirectly — but `readConfig` is private; prefer the integration test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `plugin-mcp-bridge.ts`**

Create `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts`:

```ts
import type { McpServerEntry, WorkspaceMcpConfig } from "@lume/shared";
import { WorkspaceMcpManager } from "../../mcp/workspace-mcp-manager.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";

/** Distinct slug so the plugin MCP pool never touches the workspace singleton's state. */
export const PLUGIN_MCP_WORKSPACE_SLUG = "__plugin__";

/**
 * Build a TRANSIENT WorkspaceMcpManager for plugin-declared MCP servers (spec §6.4/§16.7).
 *
 * Independent of the getWorkspaceMcpManager() singleton — plugin servers never pollute the
 * workspace MCP pool. Server ids are namespaced `${pluginId}:${serverId}` to avoid cross-plugin
 * collisions (two plugins declaring "github"). Lifecycle: caller must disposeWorkspace on
 * session end (§16.7: plugin MCP stops on session shutdown).
 *
 * Reuses WorkspaceMcpManager + McpClientManager unchanged (same StdioClientTransport/HTTP/SSE
 * spawn, retry, tool enumeration). No §8.1 gating here (Merge-B).
 */
export function buildPluginMcpManager(servers: ResolvedMcpServer[]): WorkspaceMcpManager {
  const namespaced: WorkspaceMcpConfig = { servers: {} };
  for (const server of servers) {
    const id = `${server.pluginId}:${server.serverId}`;
    namespaced.servers[id] = server.entry as McpServerEntry;
  }
  return new WorkspaceMcpManager({ readConfig: () => namespaced });
}
```

(Confirm the `WorkspaceMcpManager` import path — it's at `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`, so from `plugins/` it's `../../mcp/workspace-mcp-manager.js`. The constructor accepts `{ readConfig }` per `WorkspaceMcpManagerOptions`. `McpServerEntry`/`WorkspaceMcpConfig` from `@lume/shared`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the barrel**

In `apps/sidecar/src/services/agent-runtime/plugins/index.ts`:
```ts
export { buildPluginMcpManager, PLUGIN_MCP_WORKSPACE_SLUG } from "./plugin-mcp-bridge.js";
```

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 新增 buildPluginMcpManager（plugin-scoped 瞬态 MCP manager）"
```

---

## Chunk 3: `pluginMcpTools` group + run.ts wiring + dispose

The runtime integration. Add the group param, build the manager, call createRuntimeTools, dispose on session end.

### Task 3: Add `pluginMcpTools` group to `buildRuntimeCoreTools`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: Add the param + group**

In `buildRuntimeCoreTools` input type (run.ts:~614, after the Phase 3b `pluginCommandTools?: ToolDefinition[]`), add:
```ts
  pluginCommandTools?: ToolDefinition[];
  /** Plugin MCP tool definitions (Phase MCP Merge-A) from the plugin-scoped MCP manager. */
  pluginMcpTools?: ToolDefinition[];
```

In the `groups` array construction (run.ts:~791, after the Phase 3b `pluginCommandTools` conditional spread), add the plugin-mcp group (source `"plugin"` to match `pluginCommandTools`):
```ts
  ...(input.pluginMcpTools?.length
    ? [{ source: "plugin" as const, tools: input.pluginMcpTools }]
    : []),
```

- [ ] **Step 2: Verify typecheck + commit**

Run: `cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "run.ts" | head` → no new errors.

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): buildRuntimeCoreTools 接受 pluginMcpTools 组"
```

### Task 4: Wire plugin MCP into `createRuntimeCoreSession` + dispose

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: READ the current code**

Read run.ts:
- The `assemblePluginRuntime` call (~line 916, now returns `pluginAssembly.mcpServers` after Task 1).
- The workspace MCP block (~line 944-953): `getWorkspaceMcpManager().createRuntimeTools(input.workspaceSlug)`.
- The `buildRuntimeCoreTools({...})` call (~line 954-980): `mcpTools: workspaceMcpRuntime.tools`.
- The session `dispose()` (~line 1109-1116): `agent.close()` + `clearRuntimeToolDescriptors` + `unregisterSkill`.

- [ ] **Step 2: Add imports**

At the top of run.ts, add (near the existing `../plugins/...` imports):
```ts
import { buildPluginMcpManager, PLUGIN_MCP_WORKSPACE_SLUG } from "../plugins/plugin-mcp-bridge.js";
```

- [ ] **Step 3: Build the plugin MCP manager + call createRuntimeTools**

Right AFTER the `assemblePluginRuntime` call (~line 916) and BEFORE the workspace MCP block (~line 944), add:
```ts
  // Phase MCP Merge-A: plugin-declared MCP servers via a TRANSIENT WorkspaceMcpManager
  // (independent of the workspace singleton — zero pollution, §16.7 lifecycle via dispose).
  // No §8.1 gate here (Merge-B). Server ids namespaced `${pluginId}:${serverId}`.
  const pluginMcpManager = buildPluginMcpManager(pluginAssembly.mcpServers);
  const pluginMcpRuntime = await pluginMcpManager
    .createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG)
    .catch((error) => ({
      tools: [],
      diagnostics: [{
        pluginName: "PluginMCP",
        severity: "warning" as const,
        reason: error instanceof Error ? error.message : String(error),
      }],
    }));
```

- [ ] **Step 4: Pass `pluginMcpTools` into `buildRuntimeCoreTools`**

In the `buildRuntimeCoreTools({...})` call, add (near `mcpTools`/`pluginCommandTools`):
```ts
    pluginMcpTools: pluginMcpRuntime.tools,
```
And MERGE the plugin MCP diagnostics into the `mcpDiagnostics` (or `pluginDiagnostics`) — read the actual call to see where `workspaceMcpRuntime.diagnostics` goes, and append `pluginMcpRuntime.diagnostics` to the same array (spread both).

- [ ] **Step 5: Dispose the plugin MCP manager in session `dispose()`**

In the `dispose()` method of the returned session object (~line 1109-1116), add `await pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG);` — place it AFTER `await agent.close();` and BEFORE the descriptor/ledger cleanup:
```ts
    async dispose() {
      await agent.close();
      await pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG);
      clearRuntimeToolDescriptors(input.lumeSessionId);
      // ... existing cleanup ...
    }
```

- [ ] **Step 6: Verify typecheck + regression**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "run.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: no new run.ts errors; all tests pass. **CRITICAL:** `应从 Lume plugin 目录加载命令型插件工具` (run.test.ts:502) still passes — its `demo` plugin declares no MCP, so `pluginAssembly.mcpServers` is empty, `buildPluginMcpManager([])` builds a manager with empty config, `createRuntimeTools("__plugin__")` returns `{ tools: [], diagnostics: [] }`, and nothing changes. The Phase 3c/3d-hooks tests still pass (gates/hooks unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): createRuntimeCoreSession 接入 plugin MCP（plugin-scoped manager + §16.7 dispose）"
```

---

## Chunk 4: Full regression + boundary

### Task 5: Regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full regression**

```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 FAIL. Pre-MCP-A baseline was 158 (Phase 1+2+3a+3b+3c+3d-hooks); MCP-A adds ~3 (runtime-bridge mcpServers test + plugin-mcp-bridge ×2).

- [ ] **Step 2: Boundary**

MCP-A base = the commit before Task 1. Must NOT touch: `attempt.ts`, `sensitive-gate.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `workspace-mcp-manager.ts`, `create-mcp-tools.ts`, `getWorkspaceMcpConfig` (agent-workspace-manager.ts), SDK `agent.ts`/`hooks.ts`/`manager.ts`:
```bash
git diff --name-only <mcp-a-base>..HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.ts apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts apps/sidecar/src/services/agent/agent-workspace-manager.ts packages/sdk/src/agent.ts packages/sdk/src/hooks.ts
```
Expected: EMPTY.

Then the MCP-A change set:
```bash
git diff --name-only <mcp-a-base>..HEAD
```
Expected: `runtime-bridge.ts`, `runtime-bridge.test.ts`, `plugin-mcp-bridge.ts` (new), `plugin-mcp-bridge.test.ts` (new), `plugins/index.ts`, `run.ts`, + this plan doc.

- [ ] **Step 3: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test(sidecar): Phase MCP Merge-A 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`.
- **`run.ts` is central** (Phase 3b/3c/3d-hooks already modified it). Task 4 is the risky step. READ the actual `dispose()` + `buildRuntimeCoreTools` call + workspace MCP block before editing.
- **`WorkspaceMcpManager` import path** from `plugins/plugin-mcp-bridge.ts` is `../../mcp/workspace-mcp-manager.js` (up from `plugins/` to `agent-runtime/`, then into `mcp/`). Confirm by reading the file.
- **`PLUGIN_MCP_WORKSPACE_SLUG = "__plugin__"`** must be used consistently in BOTH `createRuntimeTools` and `disposeWorkspace`.
- **Empty plugin MCP** (a plugin with no MCP, or none enabled): `buildPluginMcpManager([])` builds a manager with `{ servers: {} }`; `createRuntimeTools` returns empty tools — verify this doesn't throw (it should be a no-op sync). The legacy `demo` plugin test covers this.
- **Do not "improve" adjacent code.** Per `CLAUDE.md` §3, only touch the named files.
- **RTK prefix.** `rtk bun test ...` / `bun x tsc ...`.
