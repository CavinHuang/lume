import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePluginCapabilities } from "./capability-resolver.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

/** Build a RegisteredPlugin fixture rooted at `root` with optional overrides. */
function makePlugin(root: string, overrides: Partial<RegisteredPlugin> = {}): RegisteredPlugin {
  return {
    pluginId: "acme",
    name: "acme",
    version: "1.0.0",
    root,
    manifestFormat: "lume",
    capabilities: { skills: [], commandTools: [] },
    permissions: {},
    diagnostics: [],
    permissionState: { state: "loaded", reason: "loaded" },
    ...overrides,
  };
}

describe("resolvePluginCapabilities — gating", () => {
  test("silently skips needs-review and not-loaded plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const loaded = makePlugin(join(root, "loaded"), { pluginId: "loaded" });
      const needsReview = makePlugin(join(root, "needs-review"), {
        pluginId: "needs-review",
        permissionState: { state: "needs-review", reason: "hash-mismatch" },
      });
      const notLoaded = makePlugin(join(root, "not-loaded"), {
        pluginId: "not-loaded",
        permissionState: { state: "not-loaded", reason: "no-review-state" },
      });

      const result = await resolvePluginCapabilities([loaded, needsReview, notLoaded]);

      expect(result.capabilities.map((c) => c.pluginId)).toEqual(["loaded"]);
      // Gating is silent: no diagnostics duplicated from the registry.
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves a loaded plugin with no declared capabilities to an empty capability set", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const result = await resolvePluginCapabilities([makePlugin(join(root, "acme"))]);

      expect(result.capabilities).toHaveLength(1);
      expect(result.capabilities[0]).toEqual({
        pluginId: "acme",
        skills: [],
        hooks: {},
        mcpServers: [],
        commandTools: [],
        diagnostics: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeSkill(pluginRoot: string, relativeRoot: string, skillName: string) {
  const skillFile = join(pluginRoot, relativeRoot, skillName, "SKILL.md");
  await mkdir(dirname(skillFile), { recursive: true });
  await writeFile(
    skillFile,
    "---\nname: frontmatter-name\ndescription: Greet the user\n---\nGreet body\n",
    "utf-8",
  );
}

describe("resolvePluginCapabilities — skills", () => {
  test("namespaces plugin skills as ${pluginId}:${skillName} and binds pluginId", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeSkill(pluginRoot, "./skills", "greet");
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [{ pluginId: "acme", version: "1.0.0", root: "./skills" }],
          commandTools: [],
        },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.skills).toEqual([
        {
          pluginId: "acme",
          name: "acme:greet",
          originalName: "greet",
          sourcePath: join(pluginRoot, "skills", "greet", "SKILL.md"),
          definition: expect.objectContaining({
            name: "acme:greet",
            description: "Greet the user",
          }),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands PLUGIN_DIR placeholders in skill prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      const skillFile = join(pluginRoot, "skills", "greet", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(
        skillFile,
        "---\nname: greet\ndescription: Greet the user\n---\nImport ${PLUGIN_DIR}/scripts/client.mjs\n",
        "utf-8",
      );
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [{ pluginId: "acme", version: "1.0.0", root: "./skills" }],
          commandTools: [],
        },
      });

      const result = await resolvePluginCapabilities([plugin]);
      const prompt = await result.capabilities[0]!.skills[0]!.definition.getPrompt("", {
        cwd: pluginRoot,
        sessionId: "test-session",
      });

      expect(prompt).toEqual([{
        type: "text",
        text: `Import ${pluginRoot.replaceAll("\\", "/")}/scripts/client.mjs`,
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

describe("resolvePluginCapabilities — hooks", () => {
  test("keeps events listed in permissions.hooks.events and strips Codex type", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
        hooks: {
          PreToolUse: [{ type: "command", command: "echo pre", matcher: "Bash" }],
          PostToolUse: [{ type: "command", command: "echo post" }],
        },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          hooksConfigPath: "./hooks/hooks.json",
          commandTools: [],
        },
        permissions: { hooks: { events: ["PreToolUse"] } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.hooks).toEqual({
        PreToolUse: [{ command: "echo pre", matcher: "Bash" }],
      });
      expect(result.diagnostics.map((d) => d.code)).toContain("capability_filtered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("filters all hooks when permissions.hooks.events is unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "no-events");
      await writeJson(join(pluginRoot, "hooks.json"), {
        Stop: [{ command: "echo stop" }],
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          hooksConfigPath: "./hooks.json",
          commandTools: [],
        },
        permissions: {}, // no hooks.events declared
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.hooks).toEqual({});
      expect(result.diagnostics.filter((d) => d.code === "capability_filtered")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits invalid_manifest when the hooks file cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "broken");
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(join(pluginRoot, "hooks", "hooks.json"), "{ not json", "utf-8");
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          hooksConfigPath: "./hooks/hooks.json",
          commandTools: [],
        },
        permissions: { hooks: { events: ["Stop"] } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.hooks).toEqual({});
      expect(result.diagnostics.map((d) => d.code)).toContain("invalid_manifest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePluginCapabilities — mcp", () => {
  test("parses MCP servers and binds pluginId", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: {
          "acme-api": { command: "node", args: ["server.js"], env: { KEY: "v" } },
        },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: true } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers).toEqual([
        {
          pluginId: "acme",
          serverId: "acme-api",
          entry: expect.objectContaining({
            enabled: true,
            transport: "stdio",
            command: "node",
            args: ["server.js"],
          }),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands PLUGIN_DIR placeholders in MCP server config", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "acme");
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: {
          "acme-api": {
            command: "node",
            args: ["${PLUGIN_DIR}/dist/mcp.js"],
            env: {
              PLUGIN_ROOT: "${PLUGIN_DIR}",
              CACHE_DIR: "${PLUGIN_DIR}/cache",
            },
          },
        },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: true } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers[0]?.entry).toMatchObject({
        command: "node",
        args: [`${pluginRoot}/dist/mcp.js`],
        env: {
          PLUGIN_ROOT: pluginRoot,
          CACHE_DIR: `${pluginRoot}/cache`,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips MCP entirely when permissions.mcpServers.register is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "no-register");
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: { "acme-api": { command: "node" } },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: false } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers).toEqual([]);
      expect(result.diagnostics.map((d) => d.code)).toContain("capability_filtered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits invalid_manifest when the MCP config cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "broken");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, "mcp.json"), "{ broken", "utf-8");
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [],
          mcpServersConfigPath: "./mcp.json",
          commandTools: [],
        },
        permissions: { mcpServers: { register: true } },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.mcpServers).toEqual([]);
      expect(result.diagnostics.map((d) => d.code)).toContain("invalid_manifest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePluginCapabilities — commandTools", () => {
  test("passes validated command tools through tagged with pluginId", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const plugin = makePlugin(join(root, "acme"), {
        capabilities: {
          skills: [],
          commandTools: [
            {
              name: "acme_echo",
              command: "node",
              args: ["./tools/echo.mjs"],
              cwd: "./",
              timeoutMs: 5000,
            },
          ],
        },
      });

      const result = await resolvePluginCapabilities([plugin]);

      expect(result.capabilities[0]?.commandTools).toEqual([
        {
          pluginId: "acme",
          contribution: {
            name: "acme_echo",
            command: "node",
            args: ["./tools/echo.mjs"],
            cwd: "./",
            timeoutMs: 5000,
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePluginCapabilities — hooksOnly", () => {
  test("skips skills, MCP, and command tools when lume.hooksOnly is true", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-resolver-"));
    try {
      const pluginRoot = join(root, "hook-only");
      await writeSkill(pluginRoot, "./skills", "greet");
      await writeJson(join(pluginRoot, "hooks.json"), {
        Stop: [{ command: "echo stop" }],
      });
      await writeJson(join(pluginRoot, "mcp.json"), {
        mcpServers: { "acme-api": { command: "node" } },
      });
      const plugin = makePlugin(pluginRoot, {
        capabilities: {
          skills: [{ pluginId: "hook-only", version: "1.0.0", root: "./skills" }],
          hooksConfigPath: "./hooks.json",
          mcpServersConfigPath: "./mcp.json",
          commandTools: [{ name: "ct", command: "echo" }],
        },
        permissions: { hooks: { events: ["Stop"] }, mcpServers: { register: true } },
        lume: { hooksOnly: true },
      });

      const result = await resolvePluginCapabilities([plugin]);
      const cap = result.capabilities[0];

      expect(cap?.skills).toEqual([]);
      expect(cap?.mcpServers).toEqual([]);
      expect(cap?.commandTools).toEqual([]);
      expect(cap?.hooks).toEqual({ Stop: [{ command: "echo stop" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
