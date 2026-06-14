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
});
