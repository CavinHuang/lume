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
