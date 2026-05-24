import { describe, expect, test } from "bun:test";
import { WorkspaceMcpManager, type WorkspaceSdkMcpManager } from "./workspace-mcp-manager";
import type { WorkspaceMcpConfig } from "@lume/shared";

function createConfig(servers: WorkspaceMcpConfig["servers"]): WorkspaceMcpConfig {
  return { servers };
}

function createFakeSdkManager(): WorkspaceSdkMcpManager & {
  syncCalls: Array<Record<string, unknown>>;
  connectCalls: string[];
  disconnectCalls: string[];
  disposeCalls: number;
  callToolCalls: Array<{ serverId: string; originalToolName: string; args: Record<string, unknown> }>;
  listResourcesFailures: Set<string>;
  readResourceFailures: Set<string>;
  callToolFailure?: Error;
  status: ReturnType<WorkspaceSdkMcpManager["getStatus"]>;
} {
  const fake = {
    syncCalls: [] as Array<Record<string, unknown>>,
    connectCalls: [] as string[],
    disconnectCalls: [] as string[],
    disposeCalls: 0,
    callToolCalls: [] as Array<{ serverId: string; originalToolName: string; args: Record<string, unknown> }>,
    listResourcesFailures: new Set<string>(),
    readResourceFailures: new Set<string>(),
    callToolFailure: undefined as Error | undefined,
    status: {} as ReturnType<WorkspaceSdkMcpManager["getStatus"]>,
    sync(configs: Record<string, unknown>) {
      fake.syncCalls.push(configs);
    },
    async connect(serverId: string) {
      fake.connectCalls.push(serverId);
    },
    async ensureConnected(serverId: string) {
      fake.connectCalls.push(serverId);
    },
    async disconnect(serverId: string) {
      fake.disconnectCalls.push(serverId);
    },
    async dispose() {
      fake.disposeCalls += 1;
    },
    getStatus() {
      return fake.status;
    },
    getTools() {
      return [];
    },
    async listResources(serverId?: string) {
      if (serverId && fake.listResourcesFailures.has(serverId)) {
        throw Object.assign(new Error("connection failed: secret-token"), { code: "transport_error" });
      }
      return { resources: [{ uri: `file://${serverId ?? "all"}`, name: "A" }] };
    },
    async readResource(serverId: string, uri: string) {
      if (fake.readResourceFailures.has(serverId)) {
        throw Object.assign(new Error("read failed: secret-token"), { code: "transport_error" });
      }
      return { contents: [{ uri, text: "hello" }] };
    },
    async callTool(serverId: string, originalToolName: string, args: Record<string, unknown>) {
      fake.callToolCalls.push({ serverId, originalToolName, args });
      if (fake.callToolFailure) {
        throw fake.callToolFailure;
      }
      return { text: "ok", structuredContent: { ok: true } };
    }
  };
  return fake;
}

describe("WorkspaceMcpManager", () => {
  test("syncWorkspace creates one SDK manager per workspace and calls sync", async () => {
    const fake = createFakeSdkManager();
    let factoryCalls = 0;
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        local: { enabled: true, transport: "stdio", command: "node" }
      }),
      sdkManagerFactory: () => {
        factoryCalls += 1;
        return fake;
      }
    });

    await manager.syncWorkspace("demo");
    await manager.syncWorkspace("demo");

    expect(factoryCalls).toBe(1);
    expect(fake.syncCalls[0]?.local).toMatchObject({ enabled: true, transport: "stdio", command: "node" });
    expect(fake.connectCalls).toEqual(["local", "local"]);
  });

  test("getStatus returns saved servers as disconnected before sync", () => {
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        remote: { enabled: true, transport: "streamable_http", url: "https://example.com/mcp" }
      }),
      sdkManagerFactory: createFakeSdkManager
    });

    expect(manager.getStatus("demo")).toEqual([{
      serverId: "remote",
      name: "remote",
      transport: "streamable_http",
      enabled: true,
      status: "disconnected",
      tools: [],
      toolDetails: []
    }]);
  });

  test("syncWorkspace disconnects disabled and deleted servers", async () => {
    const fake = createFakeSdkManager();
    let config = createConfig({
      local: { enabled: true, transport: "stdio", command: "node" }
    });
    const manager = new WorkspaceMcpManager({
      readConfig: () => config,
      sdkManagerFactory: () => fake
    });

    await manager.syncWorkspace("demo");
    config = createConfig({
      local: { enabled: false, transport: "stdio", command: "node" }
    });
    await manager.syncWorkspace("demo");
    config = createConfig({});
    await manager.syncWorkspace("demo");

    expect(fake.disconnectCalls).toEqual(["local", "local"]);
  });

  test("maps SDK auth and transport errors to public statuses", async () => {
    const fake = createFakeSdkManager();
    fake.status = {
      remote: {
        serverId: "remote",
        name: "remote",
        transport: "streamable_http",
        enabled: true,
        status: "failed",
        tools: [],
        toolDetails: [],
        error: { code: "auth_error", message: "401" }
      },
      local: {
        serverId: "local",
        name: "local",
        transport: "stdio",
        enabled: true,
        status: "failed",
        tools: [],
        toolDetails: [],
        error: { code: "transport_error", message: "spawn failed" }
      }
    };
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        remote: { enabled: true, transport: "streamable_http", url: "https://example.com/mcp" },
        local: { enabled: true, transport: "stdio", command: "node" }
      }),
      sdkManagerFactory: () => fake
    });

    await manager.syncWorkspace("demo");
    const statuses = manager.getStatus("demo");

    expect(statuses.find((item) => item.serverId === "remote")?.status).toBe("auth_needed");
    expect(statuses.find((item) => item.serverId === "local")?.error?.code).toBe("spawn_failed");
  });

  test("listResources returns successful resources plus errors", async () => {
    const fake = createFakeSdkManager();
    fake.listResourcesFailures.add("broken");
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        ok: { enabled: true, transport: "stdio", command: "node" },
        broken: { enabled: true, transport: "streamable_http", url: "https://example.com/mcp", headers: { Authorization: "secret-token" } }
      }),
      sdkManagerFactory: () => fake
    });

    await manager.syncWorkspace("demo");
    const result = await manager.listResources({ workspaceSlug: "demo" });

    expect(result.resources.map((item) => item.serverId)).toEqual(["ok"]);
    expect(result.errors?.[0]).toMatchObject({ serverId: "broken", code: "connection_failed" });
    expect(result.errors?.[0]?.message).not.toContain("secret-token");
  });

  test("readResource forwards to the selected server and maps errors", async () => {
    const fake = createFakeSdkManager();
    fake.readResourceFailures.add("broken");
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        ok: { enabled: true, transport: "stdio", command: "node" },
        broken: { enabled: true, transport: "streamable_http", url: "https://example.com/mcp", headers: { Authorization: "secret-token" } }
      }),
      sdkManagerFactory: () => fake
    });

    await manager.syncWorkspace("demo");

    expect((await manager.readResource({ workspaceSlug: "demo", serverId: "ok", uri: "file://a" })).contents).toHaveLength(1);
    await expect(manager.readResource({ workspaceSlug: "demo", serverId: "broken", uri: "file://a" }))
      .rejects.toMatchObject({ code: "connection_failed", message: expect.not.stringContaining("secret-token") });
  });

  test("callToolDiagnostic forwards tool calls and redacts failures", async () => {
    const fake = createFakeSdkManager();
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        remote: {
          enabled: true,
          transport: "streamable_http",
          url: "https://example.com/mcp",
          headers: { Authorization: "secret-token" }
        }
      }),
      sdkManagerFactory: () => fake
    });

    await manager.syncWorkspace("demo");
    expect(await manager.callToolDiagnostic({
      workspaceSlug: "demo",
      serverId: "remote",
      originalToolName: "search",
      args: { q: "lume" }
    })).toMatchObject({ text: "ok", structuredContent: { ok: true } });
    expect(fake.callToolCalls[0]).toEqual({ serverId: "remote", originalToolName: "search", args: { q: "lume" } });

    fake.callToolFailure = Object.assign(new Error("bad token secret-token"), { code: "auth_error" });
    const failed = await manager.callToolDiagnostic({
      workspaceSlug: "demo",
      serverId: "remote",
      originalToolName: "search",
      args: {}
    });
    expect(failed.error).toMatchObject({ code: "auth_needed" });
    expect(failed.error?.message).not.toContain("secret-token");
  });

  test("disposeWorkspace closes and removes the SDK manager", async () => {
    const fake = createFakeSdkManager();
    const manager = new WorkspaceMcpManager({
      readConfig: () => createConfig({
        local: { enabled: true, transport: "stdio", command: "node" }
      }),
      sdkManagerFactory: () => fake
    });

    await manager.syncWorkspace("demo");
    await manager.disposeWorkspace("demo");

    expect(fake.disposeCalls).toBe(1);
    expect(manager.getStatus("demo")[0]?.status).toBe("disconnected");
  });
});
