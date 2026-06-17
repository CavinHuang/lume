# Lume Plugin Platform MCP Merge-B — §8.1 MCP Gates + pluginId Stamping + Fixed-Name Tool Collision Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build MCP Merge-B — the follow-up to Merge-A that (1) fixes the silent functional regression where plugin-MCP fixed-name tools (`McpConfigTool`/`ListMcpResourcesTool`/`ReadMcpResourceTool`) overwrite their workspace counterparts in the shared `ToolRegistry` (last-`Map.set`-wins), (2) stamps `runtimeMetadata.pluginId`/`capability`/`mcpServerId` onto plugin-MCP tools so the Phase 3c `canUseTool` gate can source-bind them, (3) adds §8.1 server-start gating (`mcpServer:${pluginId}:${serverId}` key via `checkSensitiveCapability` before connect) on the plugin-scoped transient manager, and (4) wraps the session `dispose()` MCP cleanup in try/catch so a dispose failure cannot skip descriptor/ledger/skill cleanup (M-2).

**Architecture:** Plugin-MCP tools reach the runtime ungated today (Merge-A wired data + lifecycle only). Merge-B makes them source-bound and gated, WITHOUT touching the workspace singleton's behavior:

- `createWorkspaceMcpToolDefinitions` gains an optional per-tool `runtimeMetadata` resolver — workspace path passes nothing (unchanged), plugin path stamps `{ source:"plugin", pluginId, capability:"mcp", mcpServerId }` per tool. The `WorkspaceMcpManager` constructor gains an optional `authorizeConnect` callback; the `syncWorkspace` connect loop calls it before `ensureConnected`/`connect` (workspace singleton passes nothing → no gate; the plugin transient manager passes a closure that resolves `pluginId` from the namespaced server id and calls `checkSensitiveCapability` with `mcpServer:${serverId}`). `createRuntimeTools` gains `options?: { includeManagementTools?: boolean; toolMetadataProvider?: (serverId) => Record | undefined }` — plugin path sets `includeManagementTools:false` (drops the 3 fixed-name management tools entirely → no collision with workspace versions) and a `toolMetadataProvider` (resolves pluginId from `pluginAssembly.mcpServers`). The `sensitive-gate` learns to recognize `capability:"mcp"` + `mcpServerId` and emit a `mcpServer:${mcpServerId}` key (same key the start gate uses → a server approved at start is approved at call). `run.ts` constructs a stateless `PluginPermissionRuntime` (same state path as `attempt.ts`) for the start gate, passes the provider/options, and wraps `disposeWorkspace` in try/catch.

**Tech Stack:** TypeScript, Bun test, existing `WorkspaceMcpManager` (extended with 2 optional fields), Phase 3a `ResolvedMcpServer` + `assemblePluginRuntime.mcpServers`, Phase 3c `evaluatePluginSensitiveGate` + `PluginPermissionRuntime.checkSensitiveCapability`, MCP-A `buildPluginMcpManager`/`PLUGIN_MCP_WORKSPACE_SLUG`.

---

## Scope

Implements the **§8.1 MCP enforcement + pluginId attribution + collision fix** slice of [the approved design spec](../specs/2026-06-13-lume-plugin-platform-design.md) §8.1 ("MCP server 注册或启动" + "对本地 MCP server 暴露出的 MCP tools，执行时仍带 pluginId 和 server/tool name，按 MCP tool sensitive key 走首次确认") + §8.2 (source binding) + §16.4 (`mcpServer:${id}` sensitive key, already typed in `SensitiveCapabilityKey` but unused):

- **I-1 (collision fix):** plugin-MCP pool no longer registers the 3 fixed-name management tools → workspace `McpConfigTool`/`ListMcpResourcesTool`/`ReadMcpResourceTool` are never overwritten.
- **pluginId stamping:** plugin-MCP dynamic tools (`mcp__${pluginId}:${serverId}__${tool}`) carry `runtimeMetadata.pluginId` so the Phase 3c gate source-binds them.
- **§8.1 start gate:** before the plugin transient manager connects a server, `checkSensitiveCapability({ pluginId, key: \`mcpServer:${serverId}\` })`; `deny`/`ask` → skip connect (Phase 2 ask→block; Phase 4 adds UI).
- **§8.1 call gate:** `evaluatePluginSensitiveGate` recognizes a plugin-MCP tool (capability `"mcp"` + `mcpServerId`) and uses `mcpServer:${mcpServerId}` (same key as start gate → approval reuses).
- **M-2 (dispose leak):** `session.dispose()` wraps `pluginMcpManager.disposeWorkspace` in try/catch so a throw cannot skip `clearRuntimeToolDescriptors`/`clearRuntimeFileAccessLedger`/`unregisterSkill`.

**Out of scope (deferred):**

- **§8.1 remote-MCP host hard-block** (pre-connect URL host check against `permissions.network.outbound`) — the start gate covers the *approval* decision for all server types; the remote-host *hard block* is a later §8.1 extension.
- **McpConfigTool listing plugin servers** — by design the workspace `McpConfigTool` only sees workspace singleton servers; plugin server attribution is visible via tool names (`mcp__pluginId:serverId__tool`). A unified MCP-status RPC is a later UX task.
- **Phase 4 interactive prompt** — `ask` still means `block` here (Phase 2 convention); only the decision wiring changes.
- **State-path dedup** (`~/.lume/plugins-state.json` is constructed in `attempt.ts` + now `run.ts`) — noted in handoff; a shared factory is a cleanup task, not Merge-B.

**Constraints:**

- **Do NOT change workspace-singleton behavior.** `getWorkspaceMcpManager()` calls `createRuntimeTools` with NO options → `includeManagementTools` defaults to `true`, `toolMetadataProvider` is `undefined`, `authorizeConnect` is `undefined`. All new fields are optional with backward-compatible defaults.
- **Do NOT modify `attempt.ts`** (the Phase 3c call-gate integration point stays; Merge-B only extends `sensitive-gate.ts` which `attempt.ts` already calls).
- **Do NOT namespace tool names.** Plugin-MCP tool names stay `mcp__${pluginId}:${serverId}__${tool}` (from `buildMcpToolWrapperName`, already unique). Source binding is via `runtimeMetadata.pluginId` (same decision as Phase 3b command tools), NOT name mangling.
- **Touch surface:** `create-mcp-tools.ts` (+ test), `workspace-mcp-manager.ts` (+ test), `plugin-mcp-bridge.ts` (+ test), `sensitive-gate.ts` (+ test), `run.ts`. Do NOT touch `attempt.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `capability-resolver.ts`, `runtime-bridge.ts`, `getWorkspaceMcpConfig`, SDK.
- Match Phase 1-3d-hooks/MCP-A style: 2-space indent, double quotes in sidecar, no `any`, `bun:test`, `rtk bun test` prefix.

## Design Decisions

1. **Fixed-name collision fix = drop management tools for the plugin pool (`includeManagementTools:false`).** The 3 fixed-name tools (`McpConfigTool`/`ListMcpResourcesTool`/`ReadMcpResourceTool`) are MCP-metadata query helpers. The workspace singleton already provides exactly one of each, covering workspace servers. The plugin pool (an independent transient manager) would emit a SECOND set with the same names → `ToolRegistry.register` (`Map.set`) silently overwrites the workspace versions (last-wins, since `pluginMcpTools` group is registered after `mcpTools`). Dropping them for the plugin pool is the minimal, correct fix: plugin servers are still fully reachable via their dynamic tools (`mcp__pluginId:serverId__tool`), and the workspace management tools remain authoritative. (Renaming the plugin versions was rejected: it doubles tool count and confuses the agent.)

2. **pluginId stamping via a per-tool `runtimeMetadata` resolver on `createWorkspaceMcpToolDefinitions`.** The plugin transient manager serves multiple plugins' servers in one `createRuntimeTools` call, so pluginId is per-server, not per-call. `createWorkspaceMcpToolDefinitions` accepts `runtimeMetadata?: (tool) => Record | undefined`; `createRuntimeTools` adapts a `(serverId) => Record | undefined` provider into that via `(tool) => provider(tool.serverId)`. Each stamped tool gets `{ source:"plugin", pluginId, capability:"mcp", mcpServerId: tool.serverId }`. `mcpServerId` is the namespaced `${pluginId}:${serverId}` so the call-gate key matches the start-gate key exactly.

3. **Start gate via an optional `authorizeConnect` constructor callback.** `syncWorkspace`'s connect loop (workspace-mcp-manager.ts:285-302) is the single place servers actually spawn/connect. An optional `authorizeConnect?: (serverId: string) => Promise<{ decision:"allow"|"block"; reason?: string }>` on `WorkspaceMcpManagerOptions` is called there before connect; a `block` skips connect (logs a warning). Workspace singleton: no callback → no gate (unchanged). Plugin transient manager: a closure that resolves `pluginId` from a `Map<namespacedId, pluginId>` (built in `buildPluginMcpManager`) and calls `checkSensitiveCapability({ pluginId, key:\`mcpServer:${serverId}\` })`. `allow` → connect; `deny`/`ask` → block.

4. **Start gate + call gate share the SAME key `mcpServer:${serverId}`.** `resolveSensitiveApproval` is exact-key match (`r.key === key`). A server approved at start (`allow`) records that key; the call gate reads the same key and reuses the approval. This matches §8.1 ("server 启动后内部副作用视为用户已批准的 subprocess risk") — server-level approval is authoritative; the call gate is the spec-mandated second checkpoint but reuses the server decision, so there's no double-prompt for the same server. If start blocks, the server never connects and its tools never enter the toolset, so the call gate never fires for them.

5. **Call gate lives in `sensitive-gate.ts` (not `attempt.ts`).** `attempt.ts` already calls `evaluatePluginSensitiveGate` for every tool (Phase 3c). The gate reads `descriptor.definition.runtimeMetadata`; Merge-B teaches it to branch on `capability === "mcp"` + `mcpServerId` → `mcpServer:` key, else `commandTool:` key (unchanged for command tools). `attempt.ts` is untouched.

6. **`run.ts` constructs its own stateless `PluginPermissionRuntime` for the start gate.** The start gate runs at session-build time (`createRuntimeCoreSession` → `createRuntimeTools`), but `attempt.ts`'s `pluginPermissionRuntime` is per-attempt. The runtime is stateless (reads `FilePluginStateStore`), so a second instance in `run.ts` pointing at the same `~/.lume/plugins-state.json` is safe and shares approval records. (State-path dedup is a later cleanup.)

7. **M-2: try/catch around `disposeWorkspace`.** If `pluginMcpManager.disposeWorkspace` throws (e.g. a child process kill error), the original code skips `clearRuntimeToolDescriptors`/`clearRuntimeFileAccessLedger`/`unregisterSkill`, leaking descriptors/skills into the next session. Wrap it in try/catch; log and continue to the remaining cleanup.

## File Structure

Sidecar:

- Modify `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts` — `createWorkspaceMcpToolDefinitions` gains optional per-tool `runtimeMetadata` resolver.
- Modify `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts` — assert stamping behavior (create if absent; extend the existing test file).
- Modify `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts` — `WorkspaceMcpManagerOptions` gains `authorizeConnect?`; `createRuntimeTools` gains `options`; `syncWorkspace` calls the gate before connect.
- Modify `apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts` — assert gate is called + management-tool toggle (extend existing).
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts` — `buildPluginMcpManager` gains optional `{ permissionRuntime?, workspaceSlug? }`, builds the `authorizeConnect` closure.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts` — assert the closure blocks/allow (extend existing).
- Modify `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts` — branch on `capability:"mcp"` + `mcpServerId` → `mcpServer:` key.
- Modify `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts` — assert MCP key + command-key unchanged (extend existing).
- Modify `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` — construct plugin-MCP permission runtime, pass `includeManagementTools:false` + `toolMetadataProvider`, wrap `disposeWorkspace` in try/catch.

No changes to `attempt.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `capability-resolver.ts`, `runtime-bridge.ts`, `getWorkspaceMcpConfig`, SDK.

---

## Chunk 1: `createWorkspaceMcpToolDefinitions` per-tool `runtimeMetadata`

Stamp source-binding metadata onto MCP dynamic tools so the call gate can attribute them.

### Task 1: Add per-tool `runtimeMetadata` resolver to `createWorkspaceMcpToolDefinitions`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts`

- [ ] **Step 1: Write the failing test**

If `create-mcp-tools.test.ts` does not exist yet, create it importing from `./create-mcp-tools.js`. Add (or extend) a test for the resolver:

```ts
import { describe, expect, test } from "bun:test";
import { createWorkspaceMcpToolDefinitions } from "./create-mcp-tools";
import type { McpToolDetail } from "@lume/shared";

const tools: McpToolDetail[] = [
  {
    serverId: "acme:api",
    serverName: "acme-api",
    originalName: "search",
    wrapperName: "mcp__acme:api__search",
    description: "search acme",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
];

describe("createWorkspaceMcpToolDefinitions runtimeMetadata stamping", () => {
  test("stamps per-tool runtimeMetadata (including mcpServerId) when resolver provided", () => {
    const defs = createWorkspaceMcpToolDefinitions({
      workspaceSlug: "ws",
      tools,
      callTool: async () => ({ text: "", isError: false }),
      runtimeMetadata: (tool) => ({ source: "plugin", pluginId: "acme", capability: "mcp" }),
    });
    expect(defs).toHaveLength(1);
    expect(defs[0]?.runtimeMetadata).toMatchObject({
      source: "plugin",
      pluginId: "acme",
      capability: "mcp",
      mcpServerId: "acme:api",
    });
  });

  test("omits runtimeMetadata entirely when no resolver provided (workspace path unchanged)", () => {
    const defs = createWorkspaceMcpToolDefinitions({
      workspaceSlug: "ws",
      tools,
      callTool: async () => ({ text: "", isError: false }),
    });
    expect(defs[0]?.runtimeMetadata).toBeUndefined();
  });
});
```

(Confirm the `McpToolDetail` field set against `packages/shared/src/types/mcp.ts:22` — `serverId`, `serverName`, `originalName`, `wrapperName`, `description?`, `inputSchema`. Add only fields the type requires; omit optional ones it doesn't.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts -t "runtimeMetadata"`
Expected: FAIL — `runtimeMetadata` option does not exist / `undefined` does not match the object.

- [ ] **Step 3: Implement the resolver**

In `create-mcp-tools.ts`, change `createWorkspaceMcpToolDefinitions`'s input to accept a per-tool resolver and merge its result (plus `mcpServerId`) into each tool. Replace the function signature + the `return input.tools.map(...)` body:

```ts
export function createWorkspaceMcpToolDefinitions(input: {
  workspaceSlug: string;
  tools: McpToolDetail[];
  callTool: (
    workspaceSlug: string,
    serverId: string,
    originalToolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<McpCallResult>;
  isToolEnabled?: (workspaceSlug: string, tool: McpToolDetail) => boolean;
  /** Optional per-tool runtime metadata (e.g. pluginId for plugin-sourced tools). */
  runtimeMetadata?: (tool: McpToolDetail) => Record<string, unknown> | undefined;
}): ToolDefinition[] {
  return input.tools.map((tool) => {
    const extra = input.runtimeMetadata?.(tool);
    return {
      name: tool.wrapperName,
      description: tool.description ?? `MCP tool: ${tool.originalName} from ${tool.serverName}`,
      inputSchema: (tool.inputSchema as ToolDefinition["inputSchema"] | undefined) ?? { type: "object", properties: {} },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isEnabled: () => input.isToolEnabled?.(input.workspaceSlug, tool) ?? true,
      ...(extra ? { runtimeMetadata: { ...extra, mcpServerId: tool.serverId } } : {}),
      async call(args: Record<string, unknown>, context) {
        try {
          const result = await input.callTool(
            input.workspaceSlug,
            tool.serverId,
            tool.originalName,
            args,
            { signal: context.abortSignal }
          );
          return toolResult(renderMcpCallResult(result), context.toolUseId, result.isError);
        } catch (error) {
          return toolResult(
            `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
            context.toolUseId,
            true
          );
        }
      }
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts`
Expected: PASS — both new tests pass; if the file already existed with other tests they still pass (the change is additive).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts
git commit -m "✨ feat(sidecar): createWorkspaceMcpToolDefinitions 支持 per-tool runtimeMetadata stamping"
```

---

## Chunk 2: `WorkspaceMcpManager` — `authorizeConnect` gate + `createRuntimeTools` options

The server-start gate lives in `syncWorkspace`; the management-tool toggle + metadata provider thread through `createRuntimeTools`.

### Task 2: Add `authorizeConnect` to the constructor + gate the connect loop

**Files:**
- Modify: `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`
- Test: `apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the existing `workspace-mcp-manager.test.ts` (it already uses `setWorkspaceMcpManagerForTesting` + fake SDK managers). Add a test that a blocking `authorizeConnect` prevents connect:

```ts
test("authorizeConnect block skips connect for that server", async () => {
  const connected: string[] = [];
  const manager = new WorkspaceMcpManager({
    readConfig: () => ({
      servers: {
        "blocked-server": { enabled: true, transport: "stdio", command: "node", args: ["x.js"] },
        "ok-server": { enabled: true, transport: "stdio", command: "node", args: ["y.js"] },
      },
    }),
    sdkManagerFactory: () =>
      ({
        sync: () => {},
        ensureConnected: async (id: string) => {
          connected.push(id);
        },
        disconnect: async () => {},
        dispose: async () => {},
        getStatus: () => ({ "blocked-server": { status: "connected" }, "ok-server": { status: "connected" } }),
        getTools: () => [],
        callTool: async () => ({ text: "", isError: false }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }) satisfies WorkspaceSdkMcpManager,
    authorizeConnect: async (serverId) =>
      serverId === "blocked-server"
        ? { decision: "block", reason: "not approved" }
        : { decision: "allow" },
  });

  await manager.syncWorkspace("ws", { waitForConnections: true });

  expect(connected).toEqual(["ok-server"]);
});
```

(If the test file's existing fake-SDK shape differs, match it — the goal is: `ensureConnected` records the ids it was called with, and `authorizeConnect` blocks one. Adapt the `getStatus` return so the manager's connect loop runs.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts -t "authorizeConnect"`
Expected: FAIL — `authorizeConnect` is not a constructor option / both servers connected.

- [ ] **Step 3: Add `authorizeConnect` to options + gate the connect loop**

In `workspace-mcp-manager.ts`:

(a) Extend `WorkspaceMcpManagerOptions`:
```ts
export interface WorkspaceMcpManagerOptions {
  readConfig?: (workspaceSlug: string) => WorkspaceMcpConfig;
  sdkManagerFactory?: () => WorkspaceSdkMcpManager;
  logger?: Pick<Logger, "warn" | "error" | "info">;
  /** Optional pre-connect authorization (e.g. plugin §8.1 MCP start gate). Undefined = no gate (workspace singleton). */
  authorizeConnect?: (serverId: string) => Promise<{ decision: "allow" | "block"; reason?: string }>;
}
```

(b) Store it in the constructor:
```ts
export class WorkspaceMcpManager {
  private readonly readConfig: (workspaceSlug: string) => WorkspaceMcpConfig;
  private readonly sdkManagerFactory: () => WorkspaceSdkMcpManager;
  private readonly logger: Pick<Logger, "warn" | "error" | "info">;
  private readonly authorizeConnect?: (serverId: string) => Promise<{ decision: "allow" | "block"; reason?: string }>;
  private readonly workspaces = new Map<string, WorkspaceState>();

  constructor(options: WorkspaceMcpManagerOptions = {}) {
    this.readConfig = options.readConfig ?? getWorkspaceMcpConfig;
    this.sdkManagerFactory = options.sdkManagerFactory ?? (() => new McpClientManager());
    this.logger = options.logger ?? singletonLogger;
    this.authorizeConnect = options.authorizeConnect;
  }
```

(c) Gate the connect loop in `syncWorkspace` — replace the existing `for (const serverId of currentEnabledIds)` block (lines ~284-302) with:
```ts
    const connectionAttempts: Array<Promise<void>> = [];
    for (const serverId of currentEnabledIds) {
      if (this.authorizeConnect) {
        let gate: { decision: "allow" | "block"; reason?: string };
        try {
          gate = await this.authorizeConnect(serverId);
        } catch (error) {
          gate = {
            decision: "block",
            reason: `authorizeConnect threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (gate.decision === "block") {
          this.logger.warn("MCP server connection blocked by gate", {
            workspaceSlug,
            serverId,
            reason: gate.reason,
          });
          continue;
        }
      }
      const connect = state.sdk.ensureConnected ?? state.sdk.connect;
      if (!connect) {
        continue;
      }
      const attempt = connect.call(state.sdk, serverId).catch((error: unknown) => {
        this.logger.warn("MCP server connection failed", {
          workspaceSlug,
          serverId,
          error: mapPublicError(error, config.servers[serverId]).message
        });
      });
      if (options.waitForConnections) {
        connectionAttempts.push(attempt);
      } else {
        void attempt;
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`
Expected: PASS — the gate test passes; existing tests still pass (workspace singleton path passes no `authorizeConnect`, so the gate branch is skipped).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/mcp/workspace-mcp-manager.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
git commit -m "✨ feat(sidecar): WorkspaceMcpManager 支持 authorizeConnect 启动级网关（§8.1）"
```

### Task 3: Add `createRuntimeTools` options (`includeManagementTools` + `toolMetadataProvider`)

**Files:**
- Modify: `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`
- Test: `apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that `includeManagementTools:false` drops the 3 fixed-name tools, and `toolMetadataProvider` stamps the dynamic tools:

```ts
test("createRuntimeTools includeManagementTools:false drops fixed-name tools + stamps provider metadata", async () => {
  const manager = new WorkspaceMcpManager({
    readConfig: () => ({
      servers: {
        "acme:api": { enabled: true, transport: "stdio", command: "node", args: ["x.js"] },
      },
    }),
    sdkManagerFactory: () =>
      ({
        sync: () => {},
        ensureConnected: async () => {},
        disconnect: async () => {},
        dispose: async () => {},
        getStatus: () => ({
          "acme:api": {
            serverId: "acme:api",
            name: "acme-api",
            transport: "stdio",
            enabled: true,
            status: "connected",
            tools: [],
            toolDetails: [
              { serverId: "acme:api", serverName: "acme-api", originalName: "search", wrapperName: "mcp__acme:api__search", description: "s" },
            ],
          },
        }),
        getTools: () => [],
        callTool: async () => ({ text: "", isError: false }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }) satisfies WorkspaceSdkMcpManager,
  });

  const { tools } = await manager.createRuntimeTools("ws", {
    includeManagementTools: false,
    toolMetadataProvider: (serverId) => ({ source: "plugin", pluginId: "acme", capability: "mcp" }),
  });

  const names = tools.map((t) => t.name);
  expect(names).toEqual(["mcp__acme:api__search"]);
  expect(names).not.toContain("McpConfigTool");
  expect(names).not.toContain("ListMcpResourcesTool");
  expect(names).not.toContain("ReadMcpResourceTool");
  expect(tools[0]?.runtimeMetadata).toMatchObject({
    source: "plugin",
    pluginId: "acme",
    capability: "mcp",
    mcpServerId: "acme:api",
  });
});
```

(Match the `McpServerStatus` shape the existing tests use — the fields above are the ones `getStatus`/`createRuntimeTools` read: `serverId`, `name`, `transport`, `enabled`, `status`, `toolDetails`. Confirm against `mapSdkStatus` / the `McpServerStatus` type if the test's shape is rejected by TS.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts -t "includeManagementTools"`
Expected: FAIL — `createRuntimeTools` does not accept options / still returns management tools.

- [ ] **Step 3: Implement the options**

In `workspace-mcp-manager.ts`:

(a) Add an options interface near `WorkspaceMcpRuntimeTools`:
```ts
export interface CreateRuntimeToolsOptions {
  /** Include the fixed-name management tools (McpConfigTool/ListMcpResourcesTool/ReadMcpResourceTool). Default true (workspace). Plugin pool sets false to avoid collision. */
  includeManagementTools?: boolean;
  /** Optional per-server runtime metadata stamp (e.g. pluginId). Keyed by serverId. */
  toolMetadataProvider?: (serverId: string) => Record<string, unknown> | undefined;
}
```

(b) Update `createRuntimeTools` signature + body (lines ~443-483):
```ts
  async createRuntimeTools(
    workspaceSlug: string,
    options: CreateRuntimeToolsOptions = {},
  ): Promise<WorkspaceMcpRuntimeTools> {
    await this.syncWorkspace(workspaceSlug, { waitForConnections: true });
    const config = this.readConfig(workspaceSlug);
    const statuses = this.getStatus(workspaceSlug);
    const connectedTools = statuses
      .filter((status) => status.enabled && status.status === "connected")
      .flatMap((status) => status.toolDetails
        .filter((tool) => isMcpToolEnabled(tool, config.servers[status.serverId])));
    const diagnostics: ToolRuntimeDiagnostic[] = statuses
      .filter((status) => status.enabled && status.status !== "connected" && status.error)
      .map((status) => ({
        pluginName: `MCP: ${status.serverId}`,
        severity: "warning",
        reason: status.error?.message ?? `MCP server ${status.serverId} is not connected.`
      }));

    const includeManagement = options.includeManagementTools ?? true;

    return {
      tools: [
        ...createWorkspaceMcpToolDefinitions({
          workspaceSlug,
          tools: connectedTools,
          callTool: (targetWorkspaceSlug, serverId, originalToolName, args, opts) =>
            this.callRuntimeTool(targetWorkspaceSlug, serverId, originalToolName, args, opts),
          isToolEnabled: (targetWorkspaceSlug, tool) =>
            isMcpToolEnabled(tool, this.readConfig(targetWorkspaceSlug).servers[tool.serverId]),
          ...(options.toolMetadataProvider
            ? { runtimeMetadata: (tool) => options.toolMetadataProvider!(tool.serverId) }
            : {}),
        }),
        ...(includeManagement
          ? [
              createWorkspaceMcpConfigTool({
                workspaceSlug,
                getStatus: (targetWorkspaceSlug) => this.getStatus(targetWorkspaceSlug)
              }),
              ...createWorkspaceMcpResourceTools({
                workspaceSlug,
                listResources: (targetWorkspaceSlug, serverId) =>
                  this.listResources({ workspaceSlug: targetWorkspaceSlug, serverId }),
                readResource: (targetWorkspaceSlug, serverId, uri) =>
                  this.readResource({ workspaceSlug: targetWorkspaceSlug, serverId, uri })
              })
            ]
          : [])
      ],
      diagnostics
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`
Expected: PASS — the options test passes; existing tests (which call `createRuntimeTools(slug)` with no options) still pass — `includeManagement` defaults to `true`, no provider → unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/mcp/workspace-mcp-manager.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
git commit -m "✨ feat(sidecar): createRuntimeTools 支持 includeManagementTools + toolMetadataProvider"
```

---

## Chunk 3: `buildPluginMcpManager` — start-gate closure

The plugin transient manager wires `authorizeConnect` to `checkSensitiveCapability`.

### Task 4: Add `permissionRuntime`/`workspaceSlug` options + build the `authorizeConnect` closure

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts`
- Test: `apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Extend `plugin-mcp-bridge.test.ts` (created in MCP-A). The closure is private to the manager, so test it indirectly: construct the manager with a fake `PluginPermissionRuntime` and observe that a denied capability reaches `checkSensitiveCapability` with the right key. Because `authorizeConnect` runs inside `syncWorkspace`, drive it via `createRuntimeTools` (which calls `syncWorkspace`). Use a fake config + SDK:

```ts
import { describe, expect, test } from "bun:test";
import { buildPluginMcpManager, PLUGIN_MCP_WORKSPACE_SLUG } from "./plugin-mcp-bridge.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";
import type { PluginPermissionRuntime } from "./permission-runtime.js";

const fakeServers: ResolvedMcpServer[] = [
  { pluginId: "acme", serverId: "api", entry: { enabled: true, transport: "stdio", command: "node", args: ["s.js"] } },
];

function makeRuntime(decision: "allow" | "deny" | "ask"): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability() {
      return { decision, reason: `fake ${decision}` };
    },
  } as unknown as PluginPermissionRuntime;
}

describe("buildPluginMcpManager §8.1 start gate", () => {
  test("allow decision connects the server", async () => {
    const runtime = makeRuntime("allow");
    let connected = false;
    const manager = buildPluginMcpManager(fakeServers, {
      permissionRuntime: runtime,
      workspaceSlug: "ws",
      sdkManagerFactory: () => ({
        sync: () => {},
        ensureConnected: async () => { connected = true; },
        disconnect: async () => {},
        dispose: async () => {},
        getStatus: () => ({ "acme:api": { status: "connected", tools: [], toolDetails: [] } }),
        getTools: () => [],
        callTool: async () => ({ text: "", isError: false }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }),
    });
    await manager.createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG);
    expect(connected).toBe(true);
  });

  test("deny/ask decision blocks connect (server never connects)", async () => {
    const runtime = makeRuntime("ask");
    let connected = false;
    const manager = buildPluginMcpManager(fakeServers, {
      permissionRuntime: runtime,
      workspaceSlug: "ws",
      sdkManagerFactory: () => ({
        sync: () => {},
        ensureConnected: async () => { connected = true; },
        disconnect: async () => {},
        dispose: async () => {},
        getStatus: () => ({ "acme:api": { status: "connected", tools: [], toolDetails: [] } }),
        getTools: () => [],
        callTool: async () => ({ text: "", isError: false }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
      }),
    });
    await manager.createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG);
    expect(connected).toBe(false);
  });
});
```

(This requires `buildPluginMcpManager` to accept a `sdkManagerFactory` passthrough — see Step 3. The MCP-A unit tests that only assert the manager is constructed still pass because the new options are all optional.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts -t "start gate"`
Expected: FAIL — `buildPluginMcpManager` does not accept the options / no gate (server connects even on `ask`).

- [ ] **Step 3: Implement the closure + factory passthrough**

Replace `plugin-mcp-bridge.ts` contents:

```ts
import type { McpServerEntry, WorkspaceMcpConfig } from "@lume/shared";
import {
  WorkspaceMcpManager,
  type WorkspaceSdkMcpManager,
} from "../../mcp/workspace-mcp-manager.js";
import type { PluginPermissionRuntime } from "./permission-runtime.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";

/** Distinct slug so the plugin MCP pool never touches the workspace singleton's state. */
export const PLUGIN_MCP_WORKSPACE_SLUG = "__plugin__";

export interface BuildPluginMcpManagerOptions {
  /** §8.1 start gate. When provided, each server is checked before connect; deny/ask blocks connect. */
  permissionRuntime?: PluginPermissionRuntime;
  workspaceSlug?: string;
  /** Test seam (mirrors WorkspaceMcpManagerOptions.sdkManagerFactory). */
  sdkManagerFactory?: () => WorkspaceSdkMcpManager;
}

/**
 * Build a TRANSIENT WorkspaceMcpManager for plugin-declared MCP servers (spec §6.4/§16.7/§8.1).
 *
 * Independent of the getWorkspaceMcpManager() singleton — plugin servers never pollute the
 * workspace MCP pool. Server ids are namespaced `${pluginId}:${serverId}` to avoid cross-plugin
 * collisions. Lifecycle: caller must disposeWorkspace on session end (§16.7).
 *
 * §8.1 start gate: when `permissionRuntime` is provided, `syncWorkspace`'s connect loop calls
 * `checkSensitiveCapability({ pluginId, key: \`mcpServer:${serverId}\` })` per server before connect;
 * `deny`/`ask` skip connect (Phase 2 ask→block; Phase 4 adds UI). The call gate in sensitive-gate.ts
 * reuses the same key, so a server approved here is approved at call time too.
 */
export function buildPluginMcpManager(
  servers: ResolvedMcpServer[],
  options: BuildPluginMcpManagerOptions = {},
): WorkspaceMcpManager {
  const pluginIdByServerId = new Map<string, string>();
  const namespaced: WorkspaceMcpConfig = { servers: {} };
  for (const server of servers) {
    const id = `${server.pluginId}:${server.serverId}`;
    namespaced.servers[id] = server.entry as McpServerEntry;
    pluginIdByServerId.set(id, server.pluginId);
  }

  const { permissionRuntime, workspaceSlug, sdkManagerFactory } = options;
  const authorizeConnect = permissionRuntime
    ? async (serverId: string): Promise<{ decision: "allow" | "block"; reason?: string }> => {
        const pluginId = pluginIdByServerId.get(serverId);
        if (!pluginId) {
          return { decision: "allow" };
        }
        const result = await permissionRuntime.checkSensitiveCapability({
          pluginId,
          key: `mcpServer:${serverId}`,
          workspaceSlug,
        });
        if (result.decision === "allow") {
          return { decision: "allow" };
        }
        return {
          decision: "block",
          reason: `Plugin ${pluginId} MCP server ${serverId} blocked (sensitive, ${result.decision}): ${result.reason}`,
        };
      }
    : undefined;

  return new WorkspaceMcpManager({
    readConfig: () => namespaced,
    ...(sdkManagerFactory ? { sdkManagerFactory } : {}),
    ...(authorizeConnect ? { authorizeConnect } : {}),
  });
}
```

(Confirm `WorkspaceSdkMcpManager` is exported from `workspace-mcp-manager.ts` — it is, line 31. The `key: \`mcpServer:${serverId}\`` literal matches `SensitiveCapabilityKey`'s `` `mcpServer:${string}` `` branch.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts`
Expected: PASS — the two gate tests pass; the MCP-A unit tests (manager construction + slug constant) still pass (new options optional).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-mcp-bridge.test.ts
git commit -m "✨ feat(sidecar): buildPluginMcpManager 接入 §8.1 启动级网关（authorizeConnect + mcpServer key）"
```

---

## Chunk 4: `run.ts` — wire stamping provider + gate runtime + dispose fix

### Task 5: Wire plugin-MCP options + permission runtime + dispose try/catch in `createRuntimeCoreSession`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: READ the current code**

Read `run.ts`:
- Imports (top, ~line 82-85): `buildPluginMcpManager`, `PLUGIN_MCP_WORKSPACE_SLUG`.
- The plugin MCP block (~line 953-966): `buildPluginMcpManager(pluginAssembly.mcpServers)` → `createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG)`.
- The `PluginPermissionRuntime` / `FilePluginStateStore` / `homedir`/`join` imports — these are used in `attempt.ts`; check whether `run.ts` already imports them. (Phase 3c put them in `attempt.ts`; `run.ts` likely does NOT import them yet — add them.)
- The session `dispose()` (~line 1136-1144): `await pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG);` sits between `agent.close()` and `clearRuntimeToolDescriptors`.

- [ ] **Step 2: Add imports**

At the top of `run.ts`, add (near the existing `../plugins/...` imports):
```ts
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { FilePluginStateStore } from "../plugins/plugin-state-store.js";
```
And ensure `homedir` + `join` are imported (if not already):
```ts
import { homedir } from "node:os";
import { join } from "node:path";
```
(If `run.ts` already imports `homedir`/`join`, do not duplicate. The state path MUST be `join(homedir(), ".lume", "plugins-state.json")` — identical to `attempt.ts:679` so approval records are shared.)

- [ ] **Step 3: Construct the plugin-MCP permission runtime + pass options**

Replace the plugin MCP block (~line 953-966). The new version constructs a stateless `PluginPermissionRuntime` (same state path as `attempt.ts`), passes it to `buildPluginMcpManager` for the start gate, and passes `includeManagementTools:false` + a `toolMetadataProvider` (resolves pluginId from `pluginAssembly.mcpServers`) to `createRuntimeTools`:

```ts
  // Phase MCP Merge-A/B: plugin-declared MCP servers via a TRANSIENT WorkspaceMcpManager
  // (independent of the workspace singleton — zero pollution, §16.7 lifecycle via dispose).
  // Merge-B: §8.1 start gate (authorizeConnect → checkSensitiveCapability, mcpServer key) +
  // drop fixed-name management tools (includeManagementTools:false, avoids workspace collision) +
  // stamp pluginId/capability/mcpServerId so the call gate (sensitive-gate.ts) source-binds.
  // Stateless runtime, same state path as attempt.ts → shares approval records.
  const pluginMcpPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(join(homedir(), ".lume", "plugins-state.json")),
  });
  const pluginMcpServerIndex = new Map(
    pluginAssembly.mcpServers.map((server) => [`${server.pluginId}:${server.serverId}`, server.pluginId]),
  );
  const pluginMcpManager = buildPluginMcpManager(pluginAssembly.mcpServers, {
    permissionRuntime: pluginMcpPermissionRuntime,
    workspaceSlug: input.workspaceSlug,
  });
  const pluginMcpRuntime = await pluginMcpManager
    .createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG, {
      includeManagementTools: false,
      toolMetadataProvider: (serverId) => {
        const pluginId = pluginMcpServerIndex.get(serverId);
        if (!pluginId) return undefined;
        return { source: "plugin", pluginId, capability: "mcp" };
      },
    })
    .catch((error) => ({
      tools: [],
      diagnostics: [{
        pluginName: "PluginMCP",
        severity: "warning" as const,
        reason: error instanceof Error ? error.message : String(error),
      }],
    }));
```

- [ ] **Step 4: Wrap `disposeWorkspace` in try/catch (M-2)**

In the session `dispose()` method (~line 1136-1144), wrap the plugin-MCP dispose so a throw cannot skip descriptor/ledger/skill cleanup:

```ts
    async dispose() {
      await agent.close();
      try {
        await pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG);
      } catch (error) {
        // M-2: a dispose failure (e.g. child-process kill error) must not skip the
        // descriptor/ledger/skill cleanup below — those are required to avoid leaking
        // state into the next session. Log and continue.
        log.warn("Plugin MCP disposeWorkspace failed during session dispose", {
          sessionId: input.lumeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      clearRuntimeToolDescriptors(input.lumeSessionId);
      clearRuntimeFileAccessLedger(input.lumeSessionId);
      for (const name of registeredPluginSkillNames) {
        unregisterSkill(name);
      }
    }
```

- [ ] **Step 5: Verify typecheck + regression**

```bash
cd apps/sidecar && bun x tsc --noEmit 2>&1 | grep "run.ts" | head
rtk bun test apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: no new `run.ts` errors; all tests pass. **CRITICAL:** `应从 Lume plugin 目录加载命令型插件工具` (`run.test.ts`) still passes — its `demo` plugin declares no MCP, so `pluginAssembly.mcpServers` is empty, `buildPluginMcpManager([], {...})` builds a manager with empty config + an `authorizeConnect` that never finds a pluginId (no-op allow), `createRuntimeTools("__plugin__", { includeManagementTools:false, toolMetadataProvider })` returns `{ tools: [], diagnostics: [] }`, and nothing changes. The Phase 3c/3d-hooks/MCP-A tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): createRuntimeCoreSession 接入 plugin MCP §8.1 网关 + stamping + dispose 防泄漏（M-2）"
```

---

## Chunk 5: Call gate — `sensitive-gate.ts` MCP key branch

### Task 6: Branch on `capability:"mcp"` + `mcpServerId` in `evaluatePluginSensitiveGate`

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts`
- Test: `apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Extend `sensitive-gate.test.ts` (Phase 3c). Add a test that a plugin-MCP tool uses the `mcpServer:` key (and a command tool still uses `commandTool:`):

```ts
test("plugin MCP tool uses mcpServer:${mcpServerId} key", async () => {
  const calls: Array<{ pluginId: string; key: string }> = [];
  const runtime = {
    async checkSensitiveCapability(params: { pluginId: string; key: string }) {
      calls.push({ pluginId: params.pluginId, key: params.key });
      return { decision: "allow" as const, reason: "approved" };
    },
  };
  const result = await evaluatePluginSensitiveGate({
    descriptor: {
      name: "mcp__acme:api__search",
      canonicalName: "mcp__acme:api__search",
      source: "plugin",
      definition: {
        name: "mcp__acme:api__search",
        runtimeMetadata: { source: "plugin", pluginId: "acme", capability: "mcp", mcpServerId: "acme:api" },
      },
      metadata: {} as never,
    } as never,
    runtime: runtime as never,
    workspaceSlug: "ws",
  });
  expect(result.decision).toBe("allow");
  expect(calls).toEqual([{ pluginId: "acme", key: "mcpServer:acme:api" }]);
});

test("plugin command tool still uses commandTool:${name} key (unchanged)", async () => {
  const calls: Array<{ key: string }> = [];
  const runtime = {
    async checkSensitiveCapability(params: { key: string }) {
      calls.push({ key: params.key });
      return { decision: "deny" as const, reason: "denied" };
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
  expect(calls).toEqual([{ key: "commandTool:demo_echo" }]);
});
```

(Adapt the descriptor shape to what the existing Phase 3c test uses — the key fields are `definition.name` and `definition.runtimeMetadata`. If the existing tests construct a helper like `mkDescriptor(...)`, reuse it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts -t "MCP tool"`
Expected: FAIL — the MCP tool currently uses `commandTool:mcp__acme:api__search` (or the gate returns the wrong key).

- [ ] **Step 3: Implement the MCP key branch**

In `sensitive-gate.ts`, update the type cast + key construction:

```ts
export async function evaluatePluginSensitiveGate(
  input: SensitiveGateInput,
): Promise<SensitiveGateResult> {
  const definition = input.descriptor.definition as {
    name: string;
    runtimeMetadata?: { pluginId?: string; capability?: string; mcpServerId?: string };
  };
  const pluginId = definition.runtimeMetadata?.pluginId;
  if (!pluginId) {
    return { decision: "allow" };
  }

  // §8.1: plugin-MCP tools (capability "mcp" + mcpServerId) use the mcpServer:${serverId} key —
  // the SAME key the start gate (buildPluginMcpManager) uses, so a server approved at start is
  // approved at call time. Command tools keep commandTool:${name} (Phase 3c, unchanged).
  const isMcpTool = definition.runtimeMetadata?.capability === "mcp"
    && typeof definition.runtimeMetadata?.mcpServerId === "string";
  const key: SensitiveCapabilityKey = isMcpTool && definition.runtimeMetadata?.mcpServerId
    ? `mcpServer:${definition.runtimeMetadata.mcpServerId}`
    : `commandTool:${definition.name}`;

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

Also update the docstring's last paragraph (lines ~26-28) to reflect that MCP is now covered:

```ts
 * Covers command tools (commandTool:${name}) and plugin-MCP tools (mcpServer:${serverId},
 * §8.1) — both source-bound via runtimeMetadata.pluginId. hooks (`hook:`), network, and
 * filesystem-write keys remain deferred (hooks: Phase 3d gate; fs/net: later extension).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk bun test apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts`
Expected: PASS — the MCP-key test passes; the command-tool test passes; all Phase 3c tests pass (command-tool path unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.ts apps/sidecar/src/services/agent-runtime/plugins/sensitive-gate.test.ts
git commit -m "✨ feat(sidecar): sensitive-gate 支持 plugin MCP 工具（mcpServer key，§8.1 调用级网关）"
```

---

## Chunk 6: Full regression + boundary

### Task 7: Regression + boundary

**Files:** none (verification only)

- [ ] **Step 1: Full regression**

```bash
rtk bun test packages/sdk/src/plugins/ apps/sidecar/src/services/agent-runtime/plugins/ apps/sidecar/src/services/agent-runtime/tools/ apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts apps/sidecar/src/rpc/agent-handlers.list-plugins.test.ts
```
Expected: ALL PASS, 0 FAIL. MCP-A baseline was 162; Merge-B adds ~6 (create-mcp-tools ×2, workspace-mcp-manager ×2, plugin-mcp-bridge ×2, sensitive-gate ×2 → ~8 new).

- [ ] **Step 2: Boundary**

Merge-B base = the commit before Task 1 (`0f531f51`). Must NOT touch: `attempt.ts`, `permission-runtime.ts`, `permission-interceptor.ts`, `plugin-registry.ts`, `capability-resolver.ts`, `runtime-bridge.ts`, `getWorkspaceMcpConfig` (agent-workspace-manager.ts), SDK:
```bash
git diff --name-only 0f531f51..HEAD -- apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts apps/sidecar/src/services/agent-runtime/plugins/permission-runtime.ts apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts apps/sidecar/src/services/agent-runtime/plugins/plugin-registry.ts apps/sidecar/src/services/agent-runtime/plugins/capability-resolver.ts apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts apps/sidecar/src/services/agent/agent-workspace-manager.ts packages/sdk/src/
```
Expected: EMPTY.

Then the Merge-B change set:
```bash
git diff --name-only 0f531f51..HEAD
```
Expected: `create-mcp-tools.ts`, `create-mcp-tools.test.ts`, `workspace-mcp-manager.ts`, `workspace-mcp-manager.test.ts`, `plugin-mcp-bridge.ts`, `plugin-mcp-bridge.test.ts`, `sensitive-gate.ts`, `sensitive-gate.test.ts`, `run.ts`, + this plan doc.

- [ ] **Step 3: Commit final state (only if unstaged)**

If only `docs/superpowers/handoffs/`/`__pycache__` untracked, skip. Otherwise `✅ test(sidecar): Phase MCP Merge-B 回归与边界校验`.

---

## Notes for the executing agent

- **Run every command from the worktree root** `/Users/cavinhuang/.config/superpowers/worktrees/Lume/codex-plugin-platform-phase1`.
- **`WorkspaceMcpManager` is shared** (workspace singleton + plugin transient). Every new field (`authorizeConnect`, `includeManagementTools`, `toolMetadataProvider`) is **optional with a backward-compatible default**. The workspace singleton path (`getWorkspaceMcpManager().createRuntimeTools(slug)`) passes NOTHING → behavior is byte-identical to MCP-A. Verify this in Task 7 regression.
- **The `mcpServer:${serverId}` key must be identical in both gates.** Start gate (Task 4, `authorizeConnect` closure) and call gate (Task 6, `sensitive-gate.ts`) both use `` `mcpServer:${serverId}` `` where `serverId` is the namespaced `${pluginId}:${serverId}`. `resolveSensitiveApproval` is exact-match; a mismatch would force a second approval. The `mcpServerId` stamped on the tool (Task 1) is `tool.serverId` (the namespaced id), so the call-gate key matches.
- **State path consistency.** `run.ts` constructs `new FilePluginStateStore(join(homedir(), ".lume", "plugins-state.json"))` — identical to `attempt.ts:679`. The start gate (run.ts, session-build) and call gate (attempt.ts, per-tool) read the SAME file, so an approval recorded at start is visible at call. Do not invent a different path.
- **`includeManagementTools:false` is the I-1 fix.** Without it, the plugin pool's `McpConfigTool`/`ListMcpResourcesTool`/`ReadMcpResourceTool` overwrite the workspace versions in `ToolRegistry.register` (last-`Map.set`-wins, since `pluginMcpTools` registers after `mcpTools`). After the fix, the plugin pool contributes ONLY dynamic tools.
- **Empty plugin MCP.** A plugin with no MCP (e.g. the legacy `demo` plugin in `run.test.ts`): `pluginAssembly.mcpServers` is `[]`, `pluginMcpServerIndex` is empty, `buildPluginMcpManager([], {...})` builds a manager with `{ servers: {} }` + an `authorizeConnect` that returns `allow` (no pluginId match), `createRuntimeTools` returns `{ tools: [], diagnostics: [] }`. Verify this is a no-op (Task 5 Step 5).
- **`attempt.ts` is NOT modified.** The call gate is reached because `attempt.ts` already calls `evaluatePluginSensitiveGate` for every tool (Phase 3c); Merge-B only changes what the gate does for MCP-sourced tools. Do not touch `attempt.ts`.
- **Do not "improve" adjacent code.** Per `CLAUDE.md` §3, only touch the named files.
- **RTK prefix.** `rtk bun test ...` / `bun x tsc ...`.
- **Test-file existence.** `create-mcp-tools.test.ts` may not exist yet (MCP-A didn't create it) — Task 1 Step 1 creates it. `workspace-mcp-manager.test.ts`, `plugin-mcp-bridge.test.ts`, `sensitive-gate.test.ts` all exist (from earlier phases / MCP-A) — extend them.
