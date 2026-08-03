import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { getWorkspaceMcpPath } from "../services/infra/config-paths";

const syncWorkspaceMock = mock(async (_workspaceSlug: string) => undefined);
const disposeWorkspaceMock = mock(async (_workspaceSlug: string) => undefined);
const getStatusMock = mock((_workspaceSlug: string) => [{
  serverId: "remote",
  name: "remote",
  transport: "streamable_http",
  enabled: true,
  status: "connected",
  tools: ["search"],
  toolDetails: []
}]);
const testServerMock = mock(async (_workspaceSlug: string, serverId: string) => ({
  serverId,
  name: serverId,
  transport: "stdio",
  enabled: true,
  status: "connected",
  tools: [],
  toolDetails: []
}));
const listResourcesMock = mock(async (_input: { workspaceSlug: string; serverId?: string }) => ({
  resources: [{ serverId: "remote", serverName: "remote", uri: "file://a" }]
}));
const readResourceMock = mock(async (input: { workspaceSlug: string; serverId: string; uri: string }) => ({
  serverId: input.serverId,
  uri: input.uri,
  contents: [{ text: "hello" }]
}));
const callToolDiagnosticMock = mock(async (input: {
  workspaceSlug: string;
  serverId: string;
  originalToolName: string;
  args: Record<string, unknown>;
}) => ({
  serverId: input.serverId,
  originalToolName: input.originalToolName,
  text: "ok"
}));

mock.module("../services/mcp/workspace-mcp-manager", () => ({
  WorkspaceMcpManager: class WorkspaceMcpManager {},
  getWorkspaceMcpManager: () => ({
    syncWorkspace: syncWorkspaceMock,
    disposeWorkspace: disposeWorkspaceMock,
    getStatus: getStatusMock,
    testServer: testServerMock,
    listResources: listResourcesMock,
    readResource: readResourceMock,
    callToolDiagnostic: callToolDiagnosticMock
  })
}));

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const next = join(tmpdir(), `lume-agent-handlers-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.LUME_CONFIG_DIR = next;
  return () => {
    if (previous === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previous;
    }
    rmSync(next, { recursive: true, force: true });
  };
}

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    isLikelyExecutionRequest: () => false,
    getPhase: () => "idle",
    clearSession: () => undefined
  } as unknown as PlanModePhaseTracker;
}

async function createHandlers() {
  const { createAgentHandlers } = await import("./agent-handlers");
  return createAgentHandlers({
    writeNotification: () => undefined,
    planModePhaseTracker: createTestPlanModePhaseTracker(),
    notifyPlanModePhaseChange: () => undefined
  });
}

describe("agent-handlers MCP RPC", () => {
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
    syncWorkspaceMock.mockReset();
    disposeWorkspaceMock.mockReset();
    getStatusMock.mockClear();
    testServerMock.mockClear();
    listResourcesMock.mockClear();
    readResourceMock.mockClear();
    callToolDiagnosticMock.mockClear();
  });

  test("save-mcp-config saves canonical config and triggers workspace sync", async () => {
    restoreEnv = withTempConfigDir();
    const handlers = await createHandlers();

    expect(await handlers[AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG]!({
      workspaceSlug: "demo",
      config: {
        servers: {
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            enabled: true
          }
        }
      }
    })).toEqual({ ok: true });

    const saved = JSON.parse(readFileSync(getWorkspaceMcpPath("demo"), "utf-8"));
    expect(saved.servers.remote.transport).toBe("streamable_http");
    expect(syncWorkspaceMock).toHaveBeenCalledWith("demo");
  });

  test("save-mcp-config still returns ok when async sync rejects", async () => {
    restoreEnv = withTempConfigDir();
    syncWorkspaceMock.mockImplementationOnce(async () => {
      throw new Error("sync failed");
    });
    const handlers = await createHandlers();

    expect(await handlers[AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG]!({
      workspaceSlug: "demo",
      config: {
        servers: {
          local: {
            transport: "stdio",
            command: "node",
            enabled: true
          }
        }
      }
    })).toEqual({ ok: true });
    await Promise.resolve();

    expect(syncWorkspaceMock).toHaveBeenCalledWith("demo");
  });

  test("delete-workspace disposes the workspace MCP manager", async () => {
    restoreEnv = withTempConfigDir();
    const handlers = await createHandlers();
    const projectPath = join(process.env.LUME_CONFIG_DIR!, "project");
    mkdirSync(projectPath, { recursive: true });
    const workspace = await handlers[AGENT_IPC_CHANNELS.CREATE_WORKSPACE]!({
      name: "Demo Workspace",
      projectPath
    }) as { id: string; slug: string };

    await handlers[AGENT_IPC_CHANNELS.DELETE_WORKSPACE]!({ id: workspace.id, mode: "keepHistory" });

    expect(disposeWorkspaceMock).toHaveBeenCalledWith(workspace.slug);
  });

  test("get-mcp-status validates workspaceSlug and returns servers", async () => {
    const handlers = await createHandlers();
    syncWorkspaceMock.mockClear();

    const result = await handlers[AGENT_IPC_CHANNELS.GET_MCP_STATUS]!({ workspaceSlug: "demo" }) as any;

    expect(result.servers.map((server: { serverId: string }) => server.serverId)).toEqual(["remote", "node_repl"]);
    expect(result.servers.find((server: { serverId: string }) => server.serverId === "node_repl")).toMatchObject({
      name: "node_repl",
      status: "connected",
      tools: ["mcp__node_repl__js", "mcp__node_repl__js_reset", "mcp__node_repl__js_add_node_module_dir"]
    });
    expect(syncWorkspaceMock).toHaveBeenCalledWith("demo", { waitForConnections: true });
    await expect(handlers[AGENT_IPC_CHANNELS.GET_MCP_STATUS]!({})).rejects.toThrow();
  });

  test("get-mcp-status can read current status without waiting for connections", async () => {
    const handlers = await createHandlers();
    syncWorkspaceMock.mockClear();

    await handlers[AGENT_IPC_CHANNELS.GET_MCP_STATUS]!({ workspaceSlug: "demo", waitForConnections: false });

    expect(syncWorkspaceMock).toHaveBeenCalledWith("demo", { waitForConnections: false });
  });

  test("test-mcp-server validates workspaceSlug and serverId", async () => {
    const handlers = await createHandlers();

    expect(await handlers[AGENT_IPC_CHANNELS.TEST_MCP_SERVER]!({ workspaceSlug: "demo", serverId: "remote" }))
      .toMatchObject({ server: { serverId: "remote", status: "connected" } });
    await expect(handlers[AGENT_IPC_CHANNELS.TEST_MCP_SERVER]!({ workspaceSlug: "demo" })).rejects.toThrow();
  });

  test("resource RPCs validate inputs and forward to manager", async () => {
    const handlers = await createHandlers();

    expect(await handlers[AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES]!({ workspaceSlug: "demo" }))
      .toEqual({ resources: [{ serverId: "remote", serverName: "remote", uri: "file://a" }] });
    expect(await handlers[AGENT_IPC_CHANNELS.READ_MCP_RESOURCE]!({
      workspaceSlug: "demo",
      serverId: "remote",
      uri: "file://a"
    })).toMatchObject({ serverId: "remote", uri: "file://a" });
    await expect(handlers[AGENT_IPC_CHANNELS.READ_MCP_RESOURCE]!({ workspaceSlug: "demo", serverId: "remote" })).rejects.toThrow();
  });

  test("call-mcp-tool validates diagnostic tool calls", async () => {
    const handlers = await createHandlers();

    expect(await handlers[AGENT_IPC_CHANNELS.CALL_MCP_TOOL]!({
      workspaceSlug: "demo",
      serverId: "remote",
      originalToolName: "search",
      args: { q: "lume" }
    })).toEqual({ serverId: "remote", originalToolName: "search", text: "ok" });
    await expect(handlers[AGENT_IPC_CHANNELS.CALL_MCP_TOOL]!({
      workspaceSlug: "demo",
      serverId: "remote",
      originalToolName: "search",
      args: []
    })).rejects.toThrow();
  });
});
