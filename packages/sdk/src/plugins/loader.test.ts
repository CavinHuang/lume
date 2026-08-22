import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, test } from "bun:test";
import { buildCommandToolDefinition, loadPlugins } from "./loader.js";
import type { CommandToolContribution } from "./normalized.js";

describe("loadPlugins command manifests", () => {
  test("converts command tools from plugin.json into ToolDefinitions", async () => {
    const root = join(tmpdir(), `lume-plugin-${crypto.randomUUID()}`);
    const pluginDir = join(root, "demo");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "demo",
        tools: [{
          name: "echo_payload",
          description: "Echo payload",
          command: "node",
          args: ["-e", "process.stdout.write(process.env.PLUGIN_INPUT || '')"],
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
          metadata: { isReadOnly: true, allowedInPlanMode: true }
        }]
      }),
      "utf-8"
    );

    const plugins = await loadPlugins(root, [{ name: "demo" }]);

    expect(plugins[0]?.tools?.[0]?.name).toBe("echo_payload");
    expect(plugins[0]?.tools?.[0]?.runtimeMetadata).toMatchObject({
      source: "plugin",
      isReadOnly: true,
      allowedInPlanMode: true
    });
    const result = await plugins[0]!.tools![0]!.call(
      { value: "ok" },
      { cwd: root, toolUseId: "plugin-call-1" }
    );
    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "plugin-call-1",
      content: JSON.stringify({ value: "ok" })
    });
  });

  test("command-only plugin specs ignore manifest entry modules", async () => {
    const root = join(tmpdir(), `lume-plugin-${crypto.randomUUID()}`);
    const pluginDir = join(root, "demo");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "demo",
        entry: "index.js",
        tools: [{
          name: "echo_payload",
          description: "Echo payload",
          command: "node",
          args: ["-e", "process.stdout.write('command')"]
        }]
      }),
      "utf-8"
    );
    await writeFile(
      join(pluginDir, "index.js"),
      "export default { name: 'demo', tools: [{ name: 'module_tool', description: 'module', inputSchema: { type: 'object', properties: {} }, async call() { return { type: 'tool_result', tool_use_id: '', content: 'module' } } }] }",
      "utf-8"
    );

    const plugins = await loadPlugins(root, [{ name: "demo", kind: "command" }]);

    expect(plugins[0]?.tools?.map((tool) => tool.name)).toEqual(["echo_payload"]);
  });

  test("warns instead of silently dropping a plugin with broken manifest JSON (#227)", async () => {
    const root = join(tmpdir(), `lume-plugin-${crypto.randomUUID()}`);
    const pluginDir = join(root, "demo");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), "{ not valid json", "utf-8");

    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const plugins = await loadPlugins(root, [{ name: "demo" }]);
      expect(plugins).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).toContain("demo");
  });

  test("warns when a plugin spec resolves to nothing loadable (#227)", async () => {
    const root = join(tmpdir(), `lume-plugin-${crypto.randomUUID()}`);
    const pluginDir = join(root, "empty");
    await mkdir(pluginDir, { recursive: true });

    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const plugins = await loadPlugins(root, [{ name: "empty" }]);
      expect(plugins).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).toContain("no loadable manifest or entry module");
  });
});

const contribution: CommandToolContribution = {
  name: "echo",
  command: "node",
  args: ["./tools/echo.mjs"],
  cwd: "./",
  timeoutMs: 5000,
  env: { ECHO_MODE: "plain" },
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

describe("buildCommandToolDefinition", () => {
  test("builds a ToolDefinition with name, schema, and flags", () => {
    const def = buildCommandToolDefinition(contribution, "/plugins/acme");
    expect(def.name).toBe("echo");
    expect(def.description).toBe("echo");
    expect(def.inputSchema).toEqual(contribution.inputSchema);
    expect(def.isReadOnly?.()).toBe(false);
    expect(def.isConcurrencySafe?.()).toBe(false);
    expect(typeof def.call).toBe("function");
  });

  test("uses a default object schema when inputSchema is absent", () => {
    const def = buildCommandToolDefinition(
      { name: "ct", command: "echo" },
      "/plugins/acme",
    );
    expect(def.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

describe("loadPlugins path boundary (#202)", () => {
  test("skips plugin specs resolving outside cwd without pluginRoots", async () => {
    const root = join(tmpdir(), `lume-plugin-boundary-${crypto.randomUUID()}`);
    const outside = join(root, "..", `outside-${crypto.randomUUID()}`);
    const pluginDir = join(outside, "evil");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "evil", tools: [] }),
      "utf-8",
    );

    const plugins = await loadPlugins(root, [{ name: "evil", path: pluginDir }]);
    expect(plugins).toEqual([]);

    const allowed = await loadPlugins(root, [{ name: "evil", path: pluginDir }], [outside]);
    expect(allowed.map((p) => p.name)).toEqual(["evil"]);
  });

  test("loads plugins nested inside cwd as before", async () => {
    const root = join(tmpdir(), `lume-plugin-inside-${crypto.randomUUID()}`);
    const pluginDir = join(root, ".lume", "plugins", "inner");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "inner", tools: [] }),
      "utf-8",
    );

    const plugins = await loadPlugins(root, [{ name: "inner", path: ".lume/plugins/inner" }]);
    expect(plugins.map((p) => p.name)).toEqual(["inner"]);
  });
});

describe("plugin command tool child env (#201)", () => {
  test("child gets the safe default env plus PLUGIN_INPUT, not host secrets", async () => {
    const root = join(tmpdir(), `lume-plugin-env-${crypto.randomUUID()}`);
    const pluginDir = join(root, "probe");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "probe",
        tools: [{
          name: "env_probe",
          description: "Probe child env",
          command: process.execPath,
          args: ["-e", "process.stdout.write(JSON.stringify({ canary: process.env.LUME_TEST_SECRET ?? null, hasPath: typeof process.env.PATH === 'string', input: process.env.PLUGIN_INPUT ?? null }))"],
          inputSchema: { type: "object", properties: {} },
        }],
      }),
      "utf-8",
    );

    process.env.LUME_TEST_SECRET = "leak-me";
    try {
      const plugins = await loadPlugins(root, [{ name: "probe" }]);
      const result = await plugins[0]!.tools![0]!.call(
        { value: "ok" },
        { cwd: root, toolUseId: "env-probe-1" },
      );
      const probe = JSON.parse(String((result as { content: unknown }).content));
      expect(probe.canary).toBeNull();
      expect(probe.hasPath).toBe(true);
      expect(probe.input).toBe(JSON.stringify({ value: "ok" }));
    } finally {
      delete process.env.LUME_TEST_SECRET;
    }
  });
});
