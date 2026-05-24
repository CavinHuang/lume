# MCP Real Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real workspace MCP service connectivity for stdio, SSE, and Streamable HTTP, with Alice-style persistent sidecar management, real Settings diagnostics, runtime tool injection, and resource read/list support.

**Architecture:** Keep MCP protocol mechanics in the SDK, keep workspace lifecycle and redaction in sidecar, and keep Settings UI state in pure web helpers. The runtime must use one MCP source at a time: after the sidecar manager is wired in, remove the old per-run `mcpServers` injection path for workspace MCP configs.

**Tech Stack:** TypeScript, Bun tests, `@modelcontextprotocol/sdk`, Lume sidecar RPC, existing ToolRuntime, React/Vite Settings UI.

---

## File Structure

- `packages/shared/src/types/mcp.ts`: canonical MCP shared types, transport normalization, server/tool name normalization, secret masking helpers, JSON import shape helpers.
- `packages/shared/src/types/mcp.test.ts`: focused tests for transport compatibility, stable server/tool names, import parsing, and secret masking.
- `packages/shared/src/types/agent.ts`: re-export MCP types for existing imports; new MCP RPC channel entries are added in Chunk 3 when handlers are wired.
- `packages/shared/src/types/index.ts`: export MCP shared types.
- `packages/sdk/src/mcp/manager.ts`: reusable MCP client manager with register/sync/connect/status/call/resource APIs.
- `packages/sdk/src/mcp/manager.test.ts`: fake-client tests for connection lifecycle, retry, timeout, naming, truncation, and resources.
- `packages/sdk/src/mcp/client.ts`: keep compatibility exports by delegating one-shot `connectMCPServer` behavior to the new manager or shared helpers.
- `packages/sdk/src/index.ts`: export the new manager types/functions.
- `packages/sdk/src/types.ts`: keep legacy SDK MCP config compatibility, including `http` and `streamable_http` aliases where needed.
- `apps/sidecar/src/rpc/schemas.ts`: validate canonical and legacy MCP request payloads and new status/resource RPC inputs.
- `apps/sidecar/src/rpc/schemas.mcp.test.ts`: focused MCP schema validation tests.
- `apps/sidecar/src/rpc/agent-handlers.ts`: add MCP status/test/resource RPC handlers and sync manager after config save.
- `apps/sidecar/src/rpc/agent-handlers.mcp.test.ts`: handler-level tests for status/test/resource calls and save-triggered sync.
- `apps/sidecar/src/index.ts`: dispose all workspace MCP managers during sidecar shutdown.
- `apps/sidecar/src/services/agent/agent-workspace-manager.ts`: parse old `type: "http"`, save canonical `transport`, keep workspace plus `lume.yaml` merge behavior.
- `apps/sidecar/src/services/agent/agent-workspace-manager.test.ts`: config compatibility and canonical-save coverage.
- `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`: workspace-scoped manager wrapper around SDK manager, redaction, public error mapping, and runtime tool/resource adapters.
- `apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`: fake SDK manager tests for sync, auth_needed mapping, partial resource failures, and dispose.
- `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts`: ToolRuntime wrappers for MCP tools and resource list/read tools.
- `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts`: wrapper name, permission defaults, call forwarding, and resource tool input tests.
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`: inject MCP tools from workspace manager and remove old workspace `mcpServers` option injection.
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`: runtime-level tests for MCP tool availability and no duplicate old path.
- `apps/web/src/lib/desktop-api/mcp.ts`: typed web helpers for MCP RPC calls.
- `apps/web/src/components/settings/mcp-settings-state.ts`: pure UI state helpers for rows, import parsing, tool details, and secret masking.
- `apps/web/src/components/settings/mcp-settings-state.test.ts`: UI state tests.
- `apps/web/src/components/settings/McpSettings.tsx`: real status UI, test button, tool details, JSON import, canonical transport controls.

## Cleanup Plan

- Delete or stop using fake Settings status fields derived from config only.
- Delete or stop using workspace `buildMcpServers/mapWorkspaceMcpConfig` as a runtime source once manager-based tool injection is active.
- Do not delete SDK `Agent` MCP APIs in this feature; keep them for SDK compatibility and plugin/in-process MCP paths.
- Do not touch unrelated memory, agent role, subagent, or runtime event work already present in the dirty worktree.
- Keep all changes path-scoped and commit each chunk separately.

## Chunk 1: Shared MCP Protocol And Config Compatibility

Chunk 1 is intentionally limited to shared config/types/helpers plus sidecar config/schema compatibility. It does not wire RPC handlers, runtime tool injection, or Settings UI.

### Task 1: Add canonical shared MCP types and helpers

**Files:**
- Create: `packages/shared/src/types/mcp.ts`
- Create: `packages/shared/src/types/mcp.test.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Write failing shared MCP tests**

Create tests covering:

```ts
import {
  buildMcpToolWrapperName,
  maskMcpSecrets,
  normalizeMcpServerId,
  normalizeMcpTransport,
  parseMcpImportPayload
} from "./mcp";

test("normalizes legacy http to streamable_http", () => {
  expect(normalizeMcpTransport({ type: "http" })).toBe("streamable_http");
  expect(normalizeMcpTransport({ transport: "streamable_http" })).toBe("streamable_http");
});

test("keeps server id stable and independent from display name", () => {
  expect(normalizeMcpServerId("GitHub MCP")).toBe("github-mcp");
  expect(normalizeMcpServerId("")).toBeNull();
});

test("builds stable MCP wrapper names", () => {
  expect(buildMcpToolWrapperName("github-mcp", "search/issues")).toMatch(/^mcp__github-mcp__search_issues/);
});

test("adds deterministic suffixes for canonical tool name collisions", () => {
  const first = buildMcpToolWrapperName("github-mcp", "search/issues");
  const second = buildMcpToolWrapperName("github-mcp", "search issues", new Set([first]));
  expect(second).toMatch(/^mcp__github-mcp__search_issues_[a-z0-9]{6}$/);
  expect(buildMcpToolWrapperName("github-mcp", "search issues", new Set([first]))).toBe(second);
});

test("parses standard mcpServers import payload", () => {
  const parsed = parseMcpImportPayload({
    mcpServers: {
      alice: {
        url: "http://127.0.0.1:9000/mcp",
        headers: { Authorization: "Bearer token" }
      }
    }
  });
  expect(parsed.servers.alice.transport).toBe("streamable_http");
  expect(parsed.servers.alice.enabled).toBe(true);
});

test("parses direct import payload and defaults command entries to stdio", () => {
  const parsed = parseMcpImportPayload({
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  });
  expect(parsed.servers.filesystem.transport).toBe("stdio");
  expect(parsed.servers.filesystem.enabled).toBe(true);
});

test("masks secret headers and env values", () => {
  expect(maskMcpSecrets({ Authorization: "Bearer abc", DEBUG: "1" })).toEqual({
    Authorization: "********",
    DEBUG: "1"
  });
});
```

- [ ] **Step 2: Run shared tests and verify RED**

Run:

```bash
rtk bun test packages/shared/src/types/mcp.test.ts
```

Expected: FAIL because `packages/shared/src/types/mcp.ts` does not exist.

- [ ] **Step 3: Implement shared helpers minimally**

Add:

```ts
export type McpTransportType = "stdio" | "streamable_http" | "sse";
export type LegacyMcpTransportType = "stdio" | "http" | "sse";
export type McpPublicStatus = "disconnected" | "connecting" | "connected" | "error" | "auth_needed";

export interface McpServerEntry {
  name?: string;
  enabled: boolean;
  transport?: McpTransportType;
  type?: McpTransportType | LegacyMcpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface WorkspaceMcpConfig {
  servers: Record<string, McpServerEntry>;
}

export interface McpToolDetail {
  name: string;
  originalName: string;
  wrapperName: string;
  description?: string;
  inputSchema?: unknown;
  serverId: string;
  serverName: string;
}

export interface McpServerStatus {
  serverId: string;
  name: string;
  transport: McpTransportType;
  enabled: boolean;
  status: McpPublicStatus;
  tools: string[];
  toolDetails: McpToolDetail[];
  error?: { code: string; message: string };
  lastConnectedAt?: number;
  lastCheckedAt?: number;
}

export interface McpResourceSummary {
  serverId: string;
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
```

Implement:

- `normalizeMcpTransport(entry)` with one-way compatibility: read `type: "http"` as `streamable_http`, write `transport`.
- `normalizeMcpServerId(value)` using lowercase, `[^a-z0-9_-]` to `-`, collapsed dashes, empty returns `null`.
- `normalizeMcpToolName(value)` using ASCII letters/digits/underscore/hyphen, other chars to `_`, collapsed underscores.
- `buildMcpToolWrapperName(serverId, originalToolName, takenNames?)` returning `mcp__${serverNamespace}__${toolNamespace}` and adding a deterministic short hash suffix on collisions.
- `parseMcpImportPayload(value)` accepting `{ mcpServers: { id: config } }` and direct `{ id: config }`; imported entries default to `enabled: true`, infer `transport: "streamable_http"` from `url`, and infer `transport: "stdio"` from `command`.
- `maskMcpSecrets(record)` masking keys matching `authorization|cookie|api[-_]?key|token|secret|password`.

Also add shared RPC payload shapes from the spec:

- `GetMcpStatusRequest` / `GetMcpStatusResponse`
- `TestMcpServerRequest` / `TestMcpServerResponse`
- `ListMcpResourcesRequest` / `ListMcpResourcesResponse`
- `ReadMcpResourceRequest` / `ReadMcpResourceResponse`
- `CallMcpToolDiagnosticRequest` / `CallMcpToolDiagnosticResponse`

- [ ] **Step 4: Preserve existing imports**

In `packages/shared/src/types/agent.ts`, replace the local MCP type declarations with re-exports or imported aliases from `./mcp`, so existing imports like `import type { WorkspaceMcpConfig } from "@lume/shared"` still work.

In `packages/shared/src/types/index.ts`, export `./mcp`.

- [ ] **Step 5: Run shared tests and verify GREEN**

Run:

```bash
rtk bun test packages/shared/src/types/mcp.test.ts
```

Expected: PASS.

### Task 2: Normalize sidecar config parsing and schemas

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Create: `apps/sidecar/src/rpc/schemas.mcp.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-workspace-manager.ts`
- Modify: `apps/sidecar/src/services/agent/agent-workspace-manager.test.ts`

- [ ] **Step 1: Add failing workspace manager tests**

Add tests covering:

- `getWorkspaceMcpConfig()` accepts existing config with `type: "http"` and returns canonical `transport: "streamable_http"`.
- `saveWorkspaceMcpConfig()` writes `transport` and omits legacy-only `type` for new canonical entries.
- invalid entries without `command` for stdio or `url` for HTTP/SSE are skipped by parser but do not crash.

- [ ] **Step 2: Add failing MCP schema tests**

Create `apps/sidecar/src/rpc/schemas.mcp.test.ts` covering:

- `workspaceMcpConfigInputSchema` accepts canonical `transport: "streamable_http"`.
- `workspaceMcpConfigInputSchema` accepts legacy `type: "http"`.
- config entries with neither `transport` nor `type` are rejected at the RPC boundary.
- stdio entries without `command` are rejected.
- HTTP/SSE entries without `url` are rejected.
- `mcpStatusInputSchema` requires `workspaceSlug`.
- `mcpTestServerInputSchema` requires `workspaceSlug` and `serverId`.
- `mcpListResourcesInputSchema` accepts optional `serverId`.
- `mcpReadResourceInputSchema` requires `workspaceSlug`, `serverId`, and `uri`.
- `mcpCallToolDiagnosticInputSchema` requires `workspaceSlug`, `serverId`, `originalToolName`, and object `args`.

- [ ] **Step 3: Run workspace manager and schema tests and verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/agent-workspace-manager.test.ts
rtk bun test apps/sidecar/src/rpc/schemas.mcp.test.ts
```

Expected: FAIL on the new canonical transport and schema expectations.

- [ ] **Step 4: Update config parsing**

Use shared helpers from `@lume/shared`:

- Accept `entry.transport` or legacy `entry.type`.
- For stdio require non-empty `command`.
- For `streamable_http` and `sse` require non-empty `url`.
- Preserve `args`, string-only `env`, string-only `headers`, and `enabled`.
- When writing, call a local `toCanonicalWorkspaceMcpConfig(config)` that emits `transport` only.

- [ ] **Step 5: Update RPC schema**

Change `mcpServerEntrySchema` to accept:

```ts
transport: z.enum(["stdio", "streamable_http", "sse"]).optional(),
type: z.enum(["stdio", "http", "sse", "streamable_http"]).optional()
```

Then refine that one of them normalizes to a valid transport. Add new schemas for:

- `mcpStatusInputSchema`: `{ workspaceSlug }`
- `mcpTestServerInputSchema`: `{ workspaceSlug, serverId }`
- `mcpListResourcesInputSchema`: `{ workspaceSlug, serverId? }`
- `mcpReadResourceInputSchema`: `{ workspaceSlug, serverId, uri }`
- `mcpCallToolDiagnosticInputSchema`: `{ workspaceSlug, serverId, originalToolName, args, timeoutMs? }`

- [ ] **Step 6: Run sidecar config/schema tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/agent-workspace-manager.test.ts
rtk bun test apps/sidecar/src/rpc/schemas.mcp.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit chunk 1**

```bash
rtk git add packages/shared/src/types/mcp.ts packages/shared/src/types/mcp.test.ts packages/shared/src/types/agent.ts packages/shared/src/types/index.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/schemas.mcp.test.ts apps/sidecar/src/services/agent/agent-workspace-manager.ts apps/sidecar/src/services/agent/agent-workspace-manager.test.ts
rtk git commit -m "✨ feat(shared,sidecar): 规范化 MCP 配置协议" \
  -m "Constraint: 读取兼容 legacy http，保存只写 canonical transport" \
  -m "Tested: rtk bun test packages/shared/src/types/mcp.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/services/agent/agent-workspace-manager.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/rpc/schemas.mcp.test.ts"
```

## Chunk 2: SDK MCP Manager

### Task 3: Extract reusable MCP manager

**Files:**
- Create: `packages/sdk/src/mcp/manager.ts`
- Create: `packages/sdk/src/mcp/manager.test.ts`
- Modify: `packages/sdk/src/mcp/client.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/types.ts`

- [ ] **Step 1: Write failing manager tests with fakes**

Tests should inject fake client and transport factories, not start real MCP processes:

```ts
test("ensureConnected reuses the same connecting promise", async () => {
  const factory = createFakeMcpFactory({ tools: [{ name: "search", inputSchema: { type: "object" } }] });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.sync({ github: { enabled: true, transport: "stdio", command: "node" } });
  await Promise.all([manager.ensureConnected("github"), manager.ensureConnected("github")]);
  expect(factory.connectCalls).toBe(1);
});

test("register updates one server and connect explicitly opens it", async () => {
  const factory = createFakeMcpFactory({ tools: [{ name: "search/issues", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.register("github", { enabled: true, transport: "stdio", command: "node" });
  await manager.connect("github");
  const tool = manager.getTools("github")[0];
  expect(manager.getStatus().github.status).toBe("connected");
  expect(tool.originalName).toBe("search/issues");
  expect(tool.wrapperName).toBe("mcp__github__search_issues");
  expect(tool.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
});

test("creates deterministic wrapper suffixes for colliding tool names", async () => {
  const factory = createFakeMcpFactory({ tools: [{ name: "search/issues" }, { name: "search issues" }] });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.register("github", { enabled: true, transport: "stdio", command: "node" });
  await manager.connect("github");
  const names = manager.getTools("github").map((tool) => tool.wrapperName);
  expect(names[0]).toBe("mcp__github__search_issues");
  expect(names[1]).toMatch(/^mcp__github__search_issues_[a-z0-9]{6}$/);
});

test("callTool retries once after connection failure", async () => {
  const factory = createFakeMcpFactory({ failFirstCallWithConnectionError: true });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.sync({ github: { enabled: true, transport: "stdio", command: "node" } });
  const result = await manager.callTool("github", "search", { q: "lume" });
  expect(result.text).toContain("ok");
  expect(factory.connectCalls).toBe(2);
});

test("classifies auth errors", async () => {
  const manager = new McpClientManager({ clientFactory: authFailingClientFactory, transportFactory: fakeTransportFactory });
  manager.sync({ remote: { enabled: true, transport: "streamable_http", url: "http://x/mcp" } });
  await manager.ensureConnected("remote").catch(() => undefined);
  expect(manager.getStatus().remote.error?.code).toBe("auth_error");
});

test("truncates large tool results", async () => {
  const factory = createFakeMcpFactory({ toolResultText: "x".repeat(210_000) });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
  const result = await manager.callTool("local", "large", {});
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(200_100);
});

test("selects stdio, sse, and streamable_http transports", async () => {
  const factory = createFakeMcpFactory();
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.sync({
    local: { enabled: true, transport: "stdio", command: "node" },
    events: { enabled: true, transport: "sse", url: "http://x/sse" },
    remote: { enabled: true, transport: "streamable_http", url: "http://x/mcp" }
  });
  await manager.ensureConnected("local");
  await manager.ensureConnected("events");
  await manager.ensureConnected("remote");
  expect(factory.transportKinds).toEqual(["stdio", "sse", "streamable_http"]);
});

test("lists and reads resources per server", async () => {
  const factory = createFakeMcpFactory({ resources: [{ uri: "file://a", name: "A" }] });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
  expect((await manager.listResources("local")).resources[0].uri).toBe("file://a");
  expect((await manager.readResource("local", "file://a")).contents).toHaveLength(1);
});

test("times out or aborts slow tool calls", async () => {
  const factory = createFakeMcpFactory({ callDelayMs: 1000 });
  const manager = new McpClientManager({ clientFactory: factory.clientFactory, transportFactory: factory.transportFactory });
  manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
  await expect(manager.callTool("local", "slow", {}, { timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
  const controller = new AbortController();
  const aborted = manager.callTool("local", "slow", {}, { signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ code: "aborted" });
});

test("classifies invalid config before transport construction", async () => {
  const manager = new McpClientManager({ clientFactory: fakeClientFactory, transportFactory: fakeTransportFactory });
  manager.sync({ broken: { enabled: true, transport: "stdio", command: "" } });
  await expect(manager.ensureConnected("broken")).rejects.toMatchObject({ code: "invalid_config" });
});

test("times out slow client.connect operations", async () => {
  const factory = createFakeMcpFactory({ connectDelayMs: 1000 });
  const manager = new McpClientManager({
    clientFactory: factory.clientFactory,
    transportFactory: factory.transportFactory,
    defaultConnectTimeoutMs: 1
  });
  manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
  await expect(manager.ensureConnected("local")).rejects.toMatchObject({ code: "timeout" });
});

test("times out slow listTools operations", async () => {
  const factory = createFakeMcpFactory({ listToolsDelayMs: 1000 });
  const manager = new McpClientManager({
    clientFactory: factory.clientFactory,
    transportFactory: factory.transportFactory,
    defaultConnectTimeoutMs: 1
  });
  manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
  await expect(manager.ensureConnected("local")).rejects.toMatchObject({ code: "timeout" });
});
```

- [ ] **Step 2: Run manager tests and verify RED**

Run:

```bash
rtk bun test packages/sdk/src/mcp/manager.test.ts
```

Expected: FAIL because `McpClientManager` does not exist.

- [ ] **Step 3: Implement manager public API**

Implement:

```ts
export class McpClientManager {
  register(serverId: string, config: NormalizedMcpServerConfig): void
  sync(configs: Record<string, NormalizedMcpServerConfig>): void
  connect(serverId: string): Promise<void>
  ensureConnected(serverId: string): Promise<void>
  disconnect(serverId: string): Promise<void>
  dispose(): Promise<void>
  getStatus(): Record<string, McpClientServerStatus>
  getTools(serverId?: string): McpToolDetail[]
  callTool(serverId: string, originalToolName: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>
  listResources(serverId?: string): Promise<McpListResourcesResult>
  readResource(serverId: string, uri: string): Promise<McpReadResourceResult>
}
```

Implementation requirements:

- Internal status is `idle | connecting | connected | failed`.
- Public SDK technical errors are `invalid_config | transport_error | protocol_error | timeout | auth_error | aborted`.
- `streamable_http` uses `StreamableHTTPClientTransport`; legacy `http` is normalized before reaching this layer.
- stdio merges `{ ...process.env, ...env }` only at transport construction time.
- `ensureConnected` stores and reuses a `connecting` promise per server.
- `callTool` races MCP call with a 30s default timeout and supports `AbortSignal`.
- connection errors clear client state, reconnect once, then retry once.
- result extraction supports text blocks, non-text blocks as JSON, `structuredContent`, `isError`, and `truncated`.
- use a 200k character cap for text output and return `truncated: true` when applied.
- `register(serverId, config)` updates one server without syncing all others.
- `connect(serverId)` is an explicit connect alias used by tests/UI code; `ensureConnected(serverId)` may call it after checking current state.
- Keep `manager.ts` focused; if it grows beyond a comfortable review size, extract only private low-level helpers such as result normalization or error classification inside `packages/sdk/src/mcp/`.

- [ ] **Step 4: Keep compatibility `connectMCPServer`**

In `packages/sdk/src/mcp/client.ts`, preserve current exports:

- `connectMCPServer(name, config)` still returns `MCPConnection`.
- It may internally create a temporary `McpClientManager`.
- Existing SDK `Agent` tests should not need runtime behavior changes in this chunk.

- [ ] **Step 5: Export manager**

Update `packages/sdk/src/index.ts` to export:

```ts
export { McpClientManager } from "./mcp/manager.js";
export type {
  McpClientServerStatus,
  McpToolDetail,
  McpCallResult,
  NormalizedMcpServerConfig
} from "./mcp/manager.js";
```

Update `packages/sdk/src/types.ts` only for existing SDK MCP compatibility:

- allow `McpHttpConfig.type` to accept `"http" | "streamable_http"` if needed by `connectMCPServer`.
- do not duplicate manager-specific types there; export manager-specific types from `packages/sdk/src/mcp/manager.ts`.

- [ ] **Step 6: Run SDK focused tests**

Run:

```bash
rtk bun test packages/sdk/src/mcp/manager.test.ts
rtk bun test packages/sdk/src/agent.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit chunk 2**

```bash
rtk git add packages/sdk/src/mcp/manager.ts packages/sdk/src/mcp/manager.test.ts packages/sdk/src/mcp/client.ts packages/sdk/src/index.ts packages/sdk/src/types.ts
rtk git commit -m "✨ feat(sdk): 添加 MCP 客户端管理器" \
  -m "Constraint: 不新增依赖，测试使用 fake client/transport" \
  -m "Tested: rtk bun test packages/sdk/src/mcp/manager.test.ts" \
  -m "Tested: rtk bun test packages/sdk/src/agent.test.ts"
```

## Chunk 3: Sidecar Workspace MCP Manager And RPC

### Task 4: Add workspace-scoped sidecar MCP manager

**Files:**
- Create: `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`
- Create: `apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`
- Modify: `apps/sidecar/src/services/agent/agent-workspace-manager.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Modify: `apps/sidecar/src/index.ts`

- [ ] **Step 1: Write failing sidecar manager tests**

Cover:

- `syncWorkspace(workspaceSlug)` creates one SDK manager per workspace and calls `sync`.
- `getStatus(workspaceSlug)` returns saved servers as `disconnected` when no SDK manager exists yet, so Settings can show persisted config after restart.
- disabled or deleted servers are disconnected.
- SDK `auth_error` maps to public `auth_needed`.
- SDK `transport_error` maps to public `error` with `connection_failed` or `spawn_failed`.
- `listResources(workspaceSlug)` returns successful resources plus `errors` for failing servers.
- `readResource({ workspaceSlug, serverId, uri })` forwards to the correct server and maps SDK errors to public errors.
- `callToolDiagnostic(...)` forwards `serverId/originalToolName/args`, returns result text/structured content, and maps call errors without leaking secrets.
- `disposeWorkspace(workspaceSlug)` closes and removes the manager.
- redaction masks header/env secrets in status errors or diagnostics.

- [ ] **Step 2: Run sidecar manager tests and verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the sidecar manager**

Expose:

```ts
export function getWorkspaceMcpManager(): WorkspaceMcpManager

export class WorkspaceMcpManager {
  syncWorkspace(workspaceSlug: string): Promise<void>
  getStatus(workspaceSlug: string): McpServerStatus[]
  testServer(workspaceSlug: string, serverId: string): Promise<McpServerStatus>
  listResources(input: { workspaceSlug: string; serverId?: string }): Promise<ListMcpResourcesResponse>
  readResource(input: { workspaceSlug: string; serverId: string; uri: string }): Promise<ReadMcpResourceResponse>
  callToolDiagnostic(input: CallMcpToolDiagnosticRequest): Promise<CallMcpToolDiagnosticResponse>
  disposeWorkspace(workspaceSlug: string): Promise<void>
  disposeAll(): Promise<void>
}
```

Implementation notes:

- Sidecar status uses `connected | connecting | disconnected | error | auth_needed`.
- `testServer` only tests saved server ids.
- `syncWorkspace` starts enabled server connection but does not make config save wait on every slow server.
- Do not log full `headers` or `env`.
- Constructor should accept injectable config reader, SDK manager factory, and logger so tests can use fakes without touching disk or real MCP transports.
- Keep `workspace-mcp-manager.ts` focused; if it grows large, extract redaction and public error mapping helpers into adjacent files under `apps/sidecar/src/services/mcp/`.
- Wire `disposeWorkspace(workspaceSlug)` from workspace delete paths.
- In `DELETE_WORKSPACE`, resolve the workspace id to its current slug before deleting persisted workspace data, then call `disposeWorkspace(workspaceSlug)`.
- Add `disposeAll()` and call it from the existing sidecar shutdown path in `apps/sidecar/src/index.ts`.

- [ ] **Step 4: Run sidecar manager tests and verify GREEN**

Run:

```bash
rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
```

Expected: PASS.

### Task 5: Add MCP RPC handlers

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`
- Create: `apps/sidecar/src/rpc/agent-handlers.mcp.test.ts`

- [ ] **Step 1: Add failing handler tests**

Cover:

- `agent:save-mcp-config` calls `saveWorkspaceMcpConfig` and then `syncWorkspace`.
- if `syncWorkspace` rejects after save, the save RPC still returns `{ ok: true }` and logs a warning instead of creating an unhandled rejection.
- deleting a workspace calls `disposeWorkspace(workspaceSlug)` before or after deleting persisted workspace data.
- `agent:get-mcp-status` validates `workspaceSlug` and returns `servers`.
- `agent:test-mcp-server` validates `workspaceSlug/serverId`.
- resource list/read RPCs require `workspaceSlug`; read also requires `serverId/uri`.
- diagnostic tool call requires `workspaceSlug/serverId/originalToolName`.

- [ ] **Step 2: Add channels**

Add to `AGENT_IPC_CHANNELS`:

```ts
GET_MCP_STATUS: "agent:get-mcp-status",
TEST_MCP_SERVER: "agent:test-mcp-server",
LIST_MCP_RESOURCES: "agent:list-mcp-resources",
READ_MCP_RESOURCE: "agent:read-mcp-resource",
CALL_MCP_TOOL: "agent:call-mcp-tool"
```

- [ ] **Step 3: Wire handlers**

In `createAgentHandlers`:

- import `getWorkspaceMcpManager`.
- after `saveWorkspaceMcpConfig`, call `void getWorkspaceMcpManager().syncWorkspace(input.workspaceSlug).catch((error) => log.warn(...))` and return `{ ok: true }`.
- add status/test/resource/diagnostic handlers using the new schemas.

- [ ] **Step 4: Run handler tests**

Run:

```bash
rtk bun test apps/sidecar/src/rpc/agent-handlers.mcp.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit chunk 3**

```bash
rtk git add apps/sidecar/src/services/mcp/workspace-mcp-manager.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/agent-handlers.mcp.test.ts apps/sidecar/src/index.ts packages/shared/src/types/agent.ts
rtk git commit -m "✨ feat(sidecar,shared): 接入工作区 MCP 管理器与 RPC" \
  -m "Constraint: 配置保存不等待所有远端连接完成" \
  -m "Tested: rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/rpc/agent-handlers.mcp.test.ts"
```

## Chunk 4: Runtime Tool Injection And MCP Resources

### Task 6: Create ToolRuntime wrappers for MCP tools

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts`

- [ ] **Step 1: Write failing wrapper tests**

Cover:

- MCP tool wrapper uses `wrapperName` as `ToolDefinition.name`.
- MCP tool wrapper preserves `description` and `inputSchema` from `McpToolDetail`.
- wrapper forwards `serverId` and `originalToolName` to workspace manager.
- wrapper retains `workspaceSlug` in the closure so a test with two workspaces can assert calls route through the intended workspace.
- wrapper forwards `AbortSignal` from ToolRuntime context when available.
- `isReadOnly()` and `isConcurrencySafe()` default to false.
- tool result maps manager errors to `is_error: true`.
- tool result preserves `McpCallResult.isError` and `McpCallResult.truncated` in the returned content/metadata shape used by existing ToolRuntime tests.
- `ListMcpResourcesTool` accepts optional `serverId`.
- `ReadMcpResourceTool` requires `serverId` and `uri`.

- [ ] **Step 2: Run wrapper tests and verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts
```

Expected: FAIL because the file does not exist.

- [ ] **Step 3: Implement wrappers**

Expose:

```ts
export function createWorkspaceMcpToolDefinitions(input: {
  workspaceSlug: string;
  tools: McpToolDetail[];
  callTool: (workspaceSlug: string, serverId: string, originalToolName: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<McpCallResult>;
}): ToolDefinition[]

export function createWorkspaceMcpResourceTools(input: {
  workspaceSlug: string;
  listResources: (workspaceSlug: string, serverId?: string) => Promise<ListMcpResourcesResponse>;
  readResource: (workspaceSlug: string, serverId: string, uri: string) => Promise<ReadMcpResourceResponse>;
}): ToolDefinition[]
```

Keep resource tool names stable:

- `ListMcpResourcesTool`
- `ReadMcpResourceTool`

Do not include subscribe/unsubscribe tools in v1.

- [ ] **Step 4: Run wrapper tests and verify GREEN**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts
```

Expected: PASS.

### Task 7: Switch runtime to manager-backed MCP tools

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`
- Modify: `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts`
- Modify: `apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts`

- [ ] **Step 1: Add failing runtime tests**

Add coverage:

- when workspace manager returns one MCP tool, `createRuntimeCoreSession()` exposes `mcp__server__tool` in active tools.
- `AgentOptions` no longer receives workspace `mcpServers`.
- failed MCP server diagnostics do not block built-in tools.
- MCP resource tools are available when workspace MCP manager exists.
- wrapper logic stays in `apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts`; `run.ts` only imports the manager result and adds the MCP group.

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: FAIL because runtime still passes `mcpServers` through SDK options and does not inject manager tools.

- [ ] **Step 3: Wire manager into runtime**

Implementation direction:

- In `createRuntimeCoreSession`, before `buildRuntimeCoreTools`, call:

```ts
const workspaceMcp = input.workspaceSlug
  ? await getWorkspaceMcpManager().createRuntimeTools(input.workspaceSlug)
  : { tools: [], diagnostics: [] };
```

- Add `mcpTools` and `mcpDiagnostics` to `buildRuntimeCoreTools` input.
- Add `{ source: "mcp", tools: input.mcpTools ?? [] }` to `ToolRuntime.build` groups.
- Pass `mcpDiagnostics` into `ToolRuntime.build` alongside existing plugin diagnostics.
- Remove `buildMcpServers(input.workspaceSlug)` from `AgentOptions`.
- Delete `buildMcpServers` and `mapWorkspaceMcpConfig` if no longer used.

- [ ] **Step 4: Update workspace manager runtime tool creation**

Make `WorkspaceMcpManager.createRuntimeTools(workspaceSlug)`:

- call `syncWorkspace(workspaceSlug)` or `ensureWorkspaceConnected` for enabled saved servers.
- include only connected tools.
- include resource tools.
- return diagnostics for failed servers without throwing.
- expose the new method from `apps/sidecar/src/services/mcp/workspace-mcp-manager.ts` only in this chunk, after `createWorkspaceMcpToolDefinitions` exists.

Add failing `workspace-mcp-manager.test.ts` coverage before implementing this method:

- `createRuntimeTools(workspaceSlug)` syncs or ensures the saved enabled servers.
- connected server tools become ToolDefinitions.
- disconnected/error servers produce diagnostics and do not throw.
- returned tools include `ListMcpResourcesTool` and `ReadMcpResourceTool`.
- resource tools call back through the same `workspaceSlug`.

- [ ] **Step 5: Run runtime and sidecar manager tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts
rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit chunk 4**

```bash
rtk git add apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.ts apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.ts apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
rtk git commit -m "✨ feat(sidecar): 通过 MCP 管理器注入运行时工具" \
  -m "Constraint: 同一次 run 只允许一个 MCP 工具来源" \
  -m "Tested: rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts"
```

## Chunk 5: Settings UI Real Diagnostics

### Task 8: Add web MCP API and state helpers

**Files:**
- Create: `apps/web/src/lib/desktop-api/mcp.ts`
- Modify: `apps/web/src/lib/desktop-api/index.ts`
- Create: `apps/web/src/components/settings/mcp-settings-state.ts`
- Create: `apps/web/src/components/settings/mcp-settings-state.test.ts`

- [ ] **Step 1: Write failing state tests**

Cover:

- rows merge config and status by `serverId`.
- status badge data uses real public status instead of config-derived fake status.
- import parser accepts `{ mcpServers: { id: config } }`.
- import parser accepts direct `{ id: config }`.
- `url` without transport defaults to `streamable_http`.
- `command` without transport defaults to `stdio`.
- secret display masks `Authorization`, `Cookie`, `TOKEN`, `token`, `secret`, and `X-API-Key` case-insensitively.
- row timestamp display uses real `McpServerStatus.lastCheckedAt` or `lastConnectedAt` and never derives fake values from row index.
- tool detail model keeps `originalName`, `wrapperName`, `description`, and `inputSchema`.

- [ ] **Step 2: Run state tests and verify RED**

Run:

```bash
rtk bun test apps/web/src/components/settings/mcp-settings-state.test.ts
```

Expected: FAIL because state helpers do not exist.

- [ ] **Step 3: Implement web API helpers**

In `apps/web/src/lib/desktop-api/mcp.ts`, wrap:

- `getMcpConfig(workspaceSlug)`
- `saveMcpConfig(workspaceSlug, config)`
- `getMcpStatus(workspaceSlug)`
- `testMcpServer(workspaceSlug, serverId)`
- `listMcpResources(workspaceSlug, serverId?)`
- `readMcpResource(workspaceSlug, serverId, uri)`

Use `AGENT_IPC_CHANNELS` rather than raw string literals.
Export the helpers from `apps/web/src/lib/desktop-api/index.ts` if that is the existing barrel pattern.

- [ ] **Step 4: Implement pure state helpers**

Add:

- `buildMcpServerRows(config, status)`
- `parseMcpJsonImport(text)`
- `serializeMcpHeaders(headers)`
- `parseMcpHeaders(text)`
- `maskMcpDisplayRecord(record)`
- `getMcpStatusTone(status)`
- `formatMcpCheckedAt(status)`

Delegate import parsing, transport normalization, server id normalization, and secret masking to shared MCP helpers where practical. The web state file may add UI-specific row/tone/timestamp shaping, but it should not fork the normalization or masking rules.

- [ ] **Step 5: Run state tests and verify GREEN**

Run:

```bash
rtk bun test apps/web/src/components/settings/mcp-settings-state.test.ts
```

Expected: PASS.

### Task 9: Update McpSettings UI

**Files:**
- Modify: `apps/web/src/components/settings/McpSettings.tsx`
- Modify: `apps/web/src/components/settings/mcp-settings-state.test.ts`

- [ ] **Step 1: Replace fake rows with real status**

Use `getMcpConfig` and `getMcpStatus` during load. After save/toggle/delete:

- update local config
- call save RPC
- refresh status

Remove `lastChecked` values like `"3 分钟前"` derived from array index.
Replace them with formatted `McpServerStatus.lastCheckedAt` or `lastConnectedAt`; if neither exists, show `—`.
Keep pure formatting in `mcp-settings-state.ts`.
Delete hard-coded sample integration overview cards or replace them with real values derived from MCP config/status. No fake connected service, fake check time, or sample integration should remain visible.

- [ ] **Step 2: Add test button and tool details**

For each server row:

- `测试` calls `testMcpServer(workspaceSlug, serverId)`.
- show tool count from `McpServerStatus.toolDetails`.
- expand row or open a compact details panel with tool name, description, and input schema.

- [ ] **Step 3: Add JSON import UI**

Add a textarea or dialog that:

- parses via `parseMcpJsonImport`.
- accepts both standard `{ "mcpServers": { ... } }` and direct `{ "id": { ... } }` payloads.
- previews server ids.
- rejects conflicts unless user confirms replace.
- saves canonical config.

- [ ] **Step 4: Update transport controls**

Use canonical transport values in UI:

- `stdio`
- `streamable_http`
- `sse`

Display label can be `Streamable HTTP`.

- [ ] **Step 5: Run UI state tests**

Run:

```bash
rtk bun test apps/web/src/components/settings/mcp-settings-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run UI smoke with Browser**

Start the local dev server if needed and use Browser to inspect the Settings MCP page at desktop and narrow mobile-ish widths.

Expected:

- no overlapping buttons/text at desktop width
- no overlapping buttons/text around 390px width
- empty state renders
- rows render connected/error/auth_needed/disconnected badges
- tool detail panel can show long input schema without breaking layout
- JSON import dialog/textarea fits without clipping primary actions
- `McpSettings.tsx` stays focused on rendering; pure parsing, masking, row building, timestamp formatting stay in `mcp-settings-state.ts`.
- If `McpSettings.tsx` grows hard to review, extract render-only subcomponents while keeping state logic in `mcp-settings-state.ts`.

- [ ] **Step 7: Commit chunk 5**

```bash
rtk git add apps/web/src/lib/desktop-api/mcp.ts apps/web/src/lib/desktop-api/index.ts apps/web/src/components/settings/mcp-settings-state.ts apps/web/src/components/settings/mcp-settings-state.test.ts apps/web/src/components/settings/McpSettings.tsx
rtk git commit -m "💄 ui(web): 接入 MCP 真实状态诊断" \
  -m "Constraint: 设置页只测试已保存 MCP 服务" \
  -m "Tested: rtk bun test apps/web/src/components/settings/mcp-settings-state.test.ts" \
  -m "Tested: Browser smoke Settings MCP desktop and 390px"
```

## Chunk 6: Focused End-To-End Verification

### Task 10: Run targeted verification

**Files:**
- All files changed in chunks 1 to 5.

- [ ] **Step 1: Run shared and SDK tests**

Run:

```bash
rtk bun test packages/shared/src/types/mcp.test.ts
rtk bun test packages/sdk/src/mcp/manager.test.ts
rtk bun test packages/sdk/src/agent.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run sidecar MCP tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/agent-workspace-manager.test.ts
rtk bun test apps/sidecar/src/rpc/schemas.mcp.test.ts
rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts
rtk bun test apps/sidecar/src/rpc/agent-handlers.mcp.test.ts
rtk bun test apps/sidecar/src/services/agent-runtime/tools/mcp/create-mcp-tools.test.ts
rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run web MCP settings tests**

Run:

```bash
rtk bun test apps/web/src/components/settings/mcp-settings-state.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run Browser Settings UI smoke**

Start the local dev server if it is not already running, then use Browser to inspect the Settings MCP page at desktop width and around 390px width.

Expected:

- no overlapping controls or clipped text
- real status badges render for `connected`, `connecting`, `error`, `auth_needed`, and `disconnected` test data or mocked status state
- tool details can display a long input schema
- JSON import UI renders and primary actions remain visible

- [ ] **Step 5: Run local MCP fixture smoke**

Use a reproducible fixture from the implementation test helpers, for example a tiny stdio MCP server script under `apps/sidecar/src/services/mcp/fixtures/echo-mcp-server.mjs` if created during implementation. Do not add a dependency just for the smoke fixture.

Run the fixture manually through the Settings UI:

- add a stdio server pointing to the fixture command
- click `测试`
- disable the server

Expected:

- status changes to `connected`
- tool count is greater than zero
- disabling the server changes status to `disconnected`

If implementation does not create a reusable local fixture, record `Not-tested: local MCP fixture smoke | no repo-local MCP fixture exists and no new dependency was added` in the final report instead of inventing an external command.

- [ ] **Step 6: Inspect diff scope**

Run:

```bash
rtk git diff --stat
rtk git status --short
```

Expected:

- Only MCP-related files from this plan are changed.
- Existing unrelated dirty files remain untouched and unstaged.

- [ ] **Step 7: Final commit if verification required code-only fixes**

If verification required small fixes after prior commits:

```bash
rtk git add <only MCP-related files>
rtk git commit -m "🐛 fix(sidecar,web,sdk): 补齐 MCP 接入验证问题" \
  -m "Tested: rtk bun test packages/shared/src/types/mcp.test.ts" \
  -m "Tested: rtk bun test packages/sdk/src/mcp/manager.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/rpc/schemas.mcp.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/services/mcp/workspace-mcp-manager.test.ts" \
  -m "Tested: rtk bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts" \
  -m "Tested: rtk bun test apps/web/src/components/settings/mcp-settings-state.test.ts" \
  -m "Tested: Browser smoke Settings MCP desktop and 390px"
```

After any fix commit, rerun the exact tests affected by the fix plus `rtk git status --short`. Update commit trailers or final report with the fresh evidence.

## Execution Notes

- Before implementation, work from a clean branch or worktree if possible. The current repository has unrelated dirty files, so every `git add` must be path-specific.
- Use TDD for helper and manager logic. UI layout-only edits can rely on state tests plus visual smoke.
- Do not add dependencies.
- Do not read or import global Claude/Cursor MCP configs.
- Do not implement OAuth, MCP server export for Lume, encrypted secret storage, or resource subscription in this feature.
