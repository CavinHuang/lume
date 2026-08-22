import { describe, expect, test } from "bun:test";
import {
  McpClientManager,
  type McpClientFactory,
  type McpTransportFactory,
  type NormalizedMcpServerConfig
} from "./manager.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeMcpFactory(options: {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  resources?: Array<{ uri: string; name?: string }>;
  toolResultText?: string;
  failFirstCallWithConnectionError?: boolean;
  connectDelayMs?: number;
  listToolsDelayMs?: number;
  callDelayMs?: number;
} = {}) {
  const state = {
    connectCalls: 0,
    callToolCalls: 0,
    transportKinds: [] as string[]
  };

  const clientFactory: McpClientFactory = () => ({
    async connect() {
      state.connectCalls += 1;
      if (options.connectDelayMs) await delay(options.connectDelayMs);
    },
    async listTools() {
      if (options.listToolsDelayMs) await delay(options.listToolsDelayMs);
      return {
        tools: options.tools ?? [{ name: "search", inputSchema: { type: "object" } }]
      };
    },
    async callTool() {
      state.callToolCalls += 1;
      if (options.callDelayMs) await delay(options.callDelayMs);
      if (options.failFirstCallWithConnectionError && state.callToolCalls === 1) {
        throw new Error("Connection closed");
      }
      return {
        content: [{ type: "text", text: options.toolResultText ?? "ok" }]
      };
    },
    async listResources() {
      return { resources: options.resources ?? [] };
    },
    async readResource() {
      return { contents: [{ uri: "file://a", text: "hello" }] };
    },
    async close() {}
  });

  const transportFactory: McpTransportFactory = (_serverId, config) => {
    state.transportKinds.push(config.transport);
    return { kind: config.transport };
  };

  return {
    ...state,
    get connectCalls() {
      return state.connectCalls;
    },
    get callToolCalls() {
      return state.callToolCalls;
    },
    transportKinds: state.transportKinds,
    clientFactory,
    transportFactory
  };
}

const fakeClientFactory: McpClientFactory = () => ({
  async connect() {},
  async listTools() {
    return { tools: [] };
  },
  async callTool() {
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {}
});

const fakeTransportFactory: McpTransportFactory = () => ({});

const authFailingClientFactory: McpClientFactory = () => ({
  async connect() {
    throw new Error("401 Unauthorized");
  },
  async listTools() {
    return { tools: [] };
  },
  async callTool() {
    return { content: [] };
  },
  async close() {}
});

describe("McpClientManager", () => {
  test("ensureConnected reuses the same connecting promise", async () => {
    const factory = createFakeMcpFactory({
      connectDelayMs: 5,
      tools: [{ name: "search", inputSchema: { type: "object" } }]
    });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.sync({ github: { enabled: true, transport: "stdio", command: "node" } });
    await Promise.all([manager.ensureConnected("github"), manager.ensureConnected("github")]);

    expect(factory.connectCalls).toBe(1);
  });

  test("register updates one server and connect explicitly opens it", async () => {
    const factory = createFakeMcpFactory({
      tools: [{ name: "search/issues", inputSchema: { type: "object", properties: { q: { type: "string" } } } }]
    });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.register("github", { enabled: true, transport: "stdio", command: "node" });
    await manager.connect("github");
    const tool = manager.getTools("github")[0];

    expect(manager.getStatus().github?.status).toBe("connected");
    expect(tool?.originalName).toBe("search/issues");
    expect(tool?.wrapperName).toBe("mcp__github__search_issues");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
  });

  test("sync preserves an existing connection when server config is unchanged", async () => {
    const factory = createFakeMcpFactory({
      tools: [{ name: "echo", inputSchema: { type: "object" } }]
    });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });
    const config = { enabled: true, transport: "streamable_http", url: "http://127.0.0.1:8787/mcp" } as const;

    manager.sync({ "lume-test-http": config });
    await manager.ensureConnected("lume-test-http");
    manager.sync({ "lume-test-http": { ...config } });
    await manager.ensureConnected("lume-test-http");

    expect(factory.connectCalls).toBe(1);
    expect(manager.getStatus()["lume-test-http"]?.status).toBe("connected");
    expect(manager.getTools("lume-test-http").map((tool) => tool.originalName)).toEqual(["echo"]);
  });

  test("sync closes a pending connection after its server is removed", async () => {
    let resolveConnect!: () => void;
    let markStarted!: () => void;
    let closeCalls = 0;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const manager = new McpClientManager({
      clientFactory: () => ({
        async connect() { markStarted(); await new Promise<void>((resolve) => { resolveConnect = resolve; }); },
        async listTools() { return { tools: [] }; },
        async close() { closeCalls += 1; },
      }),
      transportFactory: fakeTransportFactory,
    });

    manager.sync({ remote: { enabled: true, transport: "streamable_http", url: "https://connector.example.com/mcp" } });
    const connecting = manager.connect("remote");
    await started;
    manager.sync({});
    resolveConnect();

    await expect(connecting).rejects.toMatchObject({ code: "aborted" });
    expect(manager.getStatus().remote).toBeUndefined();
    expect(closeCalls).toBe(1);
  });

  test("sync reconnects when a reused config object is changed", async () => {
    const factory = createFakeMcpFactory();
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });
    const config: NormalizedMcpServerConfig = {
      enabled: true,
      transport: "streamable_http",
      url: "http://127.0.0.1:8787/mcp"
    };

    manager.sync({ remote: config });
    await manager.ensureConnected("remote");
    config.url = "http://127.0.0.1:8788/mcp";
    manager.sync({ remote: config });
    await manager.ensureConnected("remote");

    expect(factory.connectCalls).toBe(2);
  });

  test("creates deterministic wrapper suffixes for colliding tool names", async () => {
    const factory = createFakeMcpFactory({ tools: [{ name: "search/issues" }, { name: "search issues" }] });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.register("github", { enabled: true, transport: "stdio", command: "node" });
    await manager.connect("github");
    const names = manager.getTools("github").map((tool) => tool.wrapperName);

    expect(names[0]).toBe("mcp__github__search_issues");
    expect(names[1]).toMatch(/^mcp__github__search_issues_[a-z0-9]{6}$/);
  });

  test("callTool retries once after connection failure", async () => {
    const factory = createFakeMcpFactory({ failFirstCallWithConnectionError: true });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.sync({ github: { enabled: true, transport: "stdio", command: "node" } });
    const result = await manager.callTool("github", "search", { q: "lume" });

    expect(result.text).toContain("ok");
    expect(factory.connectCalls).toBe(2);
  });

  test("classifies auth errors", async () => {
    const manager = new McpClientManager({
      clientFactory: authFailingClientFactory,
      transportFactory: fakeTransportFactory
    });

    manager.sync({ remote: { enabled: true, transport: "streamable_http", url: "http://x/mcp" } });
    await manager.ensureConnected("remote").catch(() => undefined);

    expect(manager.getStatus().remote?.error?.code).toBe("auth_error");
  });

  test("truncates large tool results", async () => {
    const factory = createFakeMcpFactory({ toolResultText: "x".repeat(210_000) });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
    const result = await manager.callTool("local", "large", {});

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200_100);
  });

  test("selects stdio, sse, and streamable_http transports", async () => {
    const factory = createFakeMcpFactory();
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

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
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });

    expect((await manager.listResources("local")).resources[0]?.uri).toBe("file://a");
    expect((await manager.readResource("local", "file://a")).contents).toHaveLength(1);
  });

  test("times out or aborts slow tool calls", async () => {
    const factory = createFakeMcpFactory({ callDelayMs: 20 });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
    await expect(manager.callTool("local", "slow", {}, { timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const aborted = manager.callTool("local", "slow", {}, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
  });

  test("classifies invalid config before transport construction", async () => {
    const manager = new McpClientManager({
      clientFactory: fakeClientFactory,
      transportFactory: fakeTransportFactory
    });

    manager.sync({ broken: { enabled: true, transport: "stdio", command: "" } as NormalizedMcpServerConfig });

    await expect(manager.ensureConnected("broken")).rejects.toMatchObject({ code: "invalid_config" });
  });

  test("times out slow client.connect operations", async () => {
    const factory = createFakeMcpFactory({ connectDelayMs: 20 });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory,
      defaultConnectTimeoutMs: 1
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });

    await expect(manager.ensureConnected("local")).rejects.toMatchObject({ code: "timeout" });
  });

  test("times out slow listTools operations", async () => {
    const factory = createFakeMcpFactory({ listToolsDelayMs: 20 });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory,
      defaultConnectTimeoutMs: 1
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });

    await expect(manager.ensureConnected("local")).rejects.toMatchObject({ code: "timeout" });
  });

  test("aborts the underlying callTool request on timeout (#226)", async () => {
    let seenSignal: AbortSignal | undefined;
    let release!: () => void;
    const hanging = new Promise<unknown>((resolve) => { release = () => resolve({ content: [] }); });
    const manager = new McpClientManager({
      clientFactory: () => ({
        async connect() {},
        async listTools() { return { tools: [] }; },
        async callTool(_input, options) {
          seenSignal = options?.signal;
          return hanging;
        },
        async close() {},
      }),
      transportFactory: fakeTransportFactory,
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
    await expect(manager.callTool("local", "slow", {}, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    release();

    expect(seenSignal?.aborted).toBe(true);
  });

  test("getStatus toolDetails is a copy, not the live tool list (#226)", async () => {
    const factory = createFakeMcpFactory({
      tools: [
        { name: "zeta", inputSchema: { type: "object" } },
        { name: "alpha", inputSchema: { type: "object" } }
      ]
    });
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: factory.transportFactory
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
    await manager.ensureConnected("local");

    const status = manager.getStatus();
    status.local?.toolDetails.reverse();
    (status.local?.toolDetails as unknown[]).length = 0;

    expect(manager.getStatus().local?.toolDetails.map((tool) => tool.originalName)).toEqual(["zeta", "alpha"]);
  });

  test("does not misclassify token-limit messages as auth errors (#226)", async () => {
    const manager = new McpClientManager({
      clientFactory: () => ({
        async connect() {},
        async listTools() { return { tools: [] }; },
        async callTool() { throw new Error("exceeded token limit: 1000000 > 200000"); },
        async close() {},
      }),
      transportFactory: fakeTransportFactory,
    });

    manager.sync({ local: { enabled: true, transport: "stdio", command: "node" } });
    await expect(manager.callTool("local", "boom", {})).rejects.toMatchObject({ code: "protocol_error" });
  });
});

describe("McpClientManager #312 failed 负缓存", () => {
  function createFailingFactory() {
    let connectCalls = 0;
    const clientFactory: McpClientFactory = () => ({
      async connect() {
        connectCalls += 1;
        throw new Error("spawn ok but protocol hangs");
      },
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
      async close() {}
    });
    return { clientFactory, get connectCalls() { return connectCalls; } };
  }

  function failingConfig(): NormalizedMcpServerConfig {
    return {
      serverId: "hang",
      name: "hang",
      transport: "stdio",
      enabled: true,
      command: "whatever",
      args: []
    } as unknown as NormalizedMcpServerConfig;
  }

  test("退避窗口内 ensureConnected 快速抛缓存错误且不重连", async () => {
    const factory = createFailingFactory();
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: fakeTransportFactory,
      failureRetryBaseMs: 10_000,
      failureRetryMaxMs: 60_000
    });
    manager.register("hang", failingConfig());

    await expect(manager.ensureConnected("hang")).rejects.toThrow("protocol hangs");
    expect(factory.connectCalls).toBe(1);

    const startedAt = Date.now();
    await expect(manager.ensureConnected("hang")).rejects.toThrow(/backing off|protocol hangs/);
    // 负缓存命中:未发起新连接,且几乎零耗时(不再卡 connect timeout)
    expect(factory.connectCalls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("连续失败指数退避,窗口过后允许重试", async () => {
    const factory = createFailingFactory();
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: fakeTransportFactory,
      failureRetryBaseMs: 20,
      failureRetryMaxMs: 60
    });
    manager.register("hang", failingConfig());

    await expect(manager.ensureConnected("hang")).rejects.toThrow(); // failure 1 → backoff 20ms
    await expect(manager.ensureConnected("hang")).rejects.toThrow(); // 窗口内,不重连
    expect(factory.connectCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(manager.ensureConnected("hang")).rejects.toThrow("protocol hangs"); // 窗口过,真连
    expect(factory.connectCalls).toBe(2);
  });

  test("disconnect 清除负缓存,立即允许重试", async () => {
    const factory = createFailingFactory();
    const manager = new McpClientManager({
      clientFactory: factory.clientFactory,
      transportFactory: fakeTransportFactory,
      failureRetryBaseMs: 10_000
    });
    manager.register("hang", failingConfig());
    await expect(manager.ensureConnected("hang")).rejects.toThrow();
    await expect(manager.ensureConnected("hang")).rejects.toThrow();
    expect(factory.connectCalls).toBe(1);

    await manager.disconnect("hang");
    await expect(manager.ensureConnected("hang")).rejects.toThrow("protocol hangs");
    expect(factory.connectCalls).toBe(2);
  });

  test("连接成功后负缓存清零", async () => {
    let shouldFail = true;
    const clientFactory: McpClientFactory = () => ({
      async connect() {
        if (shouldFail) throw new Error("transient");
      },
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [] };
      },
      async close() {}
    });
    const manager = new McpClientManager({
      clientFactory,
      transportFactory: fakeTransportFactory,
      failureRetryBaseMs: 20
    });
    manager.register("flaky", failingConfig());
    await expect(manager.ensureConnected("flaky")).rejects.toThrow();
    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await manager.ensureConnected("flaky");
    expect(manager.getStatus().flaky?.status).toBe("connected");
  });
});
