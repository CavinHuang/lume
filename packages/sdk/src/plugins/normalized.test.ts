import { describe, expect, test } from "bun:test";
import { normalizePluginManifests } from "./normalized.js";

describe("normalizePluginManifests", () => {
  test("normalizes a Lume manifest without reading referenced files", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/acme",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "acme",
        version: "1.2.3",
        displayName: "Acme",
        description: "Acme plugin",
        skills: ["./skills/"],
        hooks: "./hooks/hooks.json",
        mcpServers: "./mcp.json",
        commandTools: [
          {
            name: "acme_echo",
            command: "node",
            args: ["./tools/echo.mjs"],
            cwd: "./",
            timeoutMs: 5000,
            inputSchema: { type: "object", properties: {} },
          },
        ],
        permissions: {
          mcpServers: { register: true },
          tools: { ask: ["acme_echo"] },
        },
      },
    });

    expect(result.pluginId).toBe("acme");
    expect(result.manifestFormat).toBe("lume");
    expect(result.capabilities.skills).toEqual([
      { pluginId: "acme", version: "1.2.3", root: "./skills/" },
    ]);
    expect(result.capabilities.hooksConfigPath).toBe("./hooks/hooks.json");
    expect(result.capabilities.mcpServersConfigPath).toBe("./mcp.json");
    expect(result.capabilities.commandTools[0]?.name).toBe("acme_echo");
    expect(result.permissions.mcpServers?.register).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("prefers Lume manifest over Codex manifest in the same root", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/dual",
      lumeManifest: { schema: "lume-plugin/v1", name: "dual", version: "1.0.0" },
      codexManifest: { name: "codex-dual", version: "9.9.9", interface: {} },
    });

    expect(result.pluginId).toBe("dual");
    expect(result.manifestFormat).toBe("lume");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("ignored_manifest");
  });

  test("normalizes Codex manifest with Codex-compatible defaults", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/codex",
      codexManifest: {
        name: "codex",
        version: "1.0.0",
        skills: "./skills/",
        mcpServers: "./mcp.json",
        interface: { displayName: "Codex Plugin" },
      },
    });

    expect(result.manifestFormat).toBe("codex");
    expect(result.displayName).toBe("Codex Plugin");
    expect(result.permissions.mcpServers?.register).toBe(true);
    expect(result.permissions.shell?.allow).toBe(true);
    expect(result.permissions.tools?.deny).toContain("Bash");
  });

  test("normalizes legacy plugin.json command tools", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/legacy",
      legacyManifest: {
        name: "legacy",
        version: "local",
        tools: [
          {
            name: "legacy_echo",
            description: "Echo",
            command: "echo",
            args: ["hello"],
          },
        ],
      },
    });

    expect(result.manifestFormat).toBe("legacy");
    expect(result.version).toBe("local");
    expect(result.capabilities.commandTools.map((tool) => tool.name)).toEqual(["legacy_echo"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("legacy_manifest");
  });

  test("rejects legacy plugin without command tools", () => {
    expect(() =>
      normalizePluginManifests({
        pluginRoot: "/plugins/legacy-empty",
        legacyManifest: { name: "legacy-empty", tools: [] },
      }),
    ).toThrow("command");
  });

  test("skips invalid command tools with diagnostics", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/bad-tool",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "bad-tool",
        version: "1.0.0",
        commandTools: [
          { name: "missing-command" },
          { name: "bad-cwd", command: "node", cwd: "../outside" },
        ],
      },
    });

    expect(result.capabilities.commandTools).toEqual([]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "command_tool_invalid")).toHaveLength(2);
  });

  test("skips command tools with invalid optional field shapes", () => {
    const invalidTools = [
      { name: "bad-args", command: "node", args: ["ok", 1] },
      { name: "bad-timeout", command: "node", timeoutMs: "1000" },
      { name: "bad-schema", command: "node", inputSchema: [] },
      { name: "bad-env", command: "node", env: { TOKEN: 1 } },
      { name: "bad-metadata", command: "node", metadata: [] },
    ];
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/bad-optional-fields",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "bad-optional-fields",
        version: "1.0.0",
        commandTools: invalidTools,
      },
    });

    expect(result.capabilities.commandTools).toEqual([]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "command_tool_invalid")).toHaveLength(invalidTools.length);
  });

  test("ignores executable module fields with diagnostics", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/entry",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "entry",
        version: "1.0.0",
        entry: "./dist/index.js",
      },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "unsupported_field",
      path: "entry",
    }));
  });

  test("carries lume.hooksOnly=true onto NormalizedPlugin", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/hook-only",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "hook-only",
        version: "1.0.0",
        hooks: "./hooks/hooks.json",
        lume: { hooksOnly: true },
      },
    });

    expect(result.lume).toEqual({ hooksOnly: true });
  });

  test("omits lume when hooksOnly is not set", () => {
    const result = normalizePluginManifests({
      pluginRoot: "/plugins/acme",
      lumeManifest: {
        schema: "lume-plugin/v1",
        name: "acme",
        version: "1.0.0",
      },
    });

    expect(result.lume).toBeUndefined();
  });
});
