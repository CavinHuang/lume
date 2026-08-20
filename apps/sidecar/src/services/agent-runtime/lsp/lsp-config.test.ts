import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import { resolveRuntimeLspConfig } from "./lsp-config.js";

describe("runtime LSP config", () => {
  test("merges user, reviewed plugin and project config in priority order", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-lsp-config-"));
    const pluginRoot = join(root, "plugin");
    try {
      await mkdir(pluginRoot);
      await writeFile(join(pluginRoot, "lsp.yaml"), [
        "servers:",
        "  ts:",
        "    command: plugin-ts",
        "  plugin-only:",
        "    command: plugin-ls",
      ].join("\n"));
      await writeFile(join(root, "lsp.json"), JSON.stringify({
        diagnosticsOnWrite: false,
        servers: { ts: { command: "project-ts" } },
      }));
      const plugin = {
        pluginId: "demo",
        version: "1.0.0",
        root: pluginRoot,
        permissionState: { state: "loaded", reason: "approved" },
        permissions: { shell: { allow: true } },
        capabilities: {
          skills: [],
          commandTools: [],
          lspServersConfigPath: "./lsp.yaml",
        },
      } as unknown as RegisteredPlugin;

      const result = await resolveRuntimeLspConfig({
        cwd: root,
        user: {
          diagnosticsOnWrite: true,
          servers: { ts: { command: "user-ts" }, user: { command: "user-ls" } },
        },
        plugins: [plugin],
      });
      expect(result.diagnosticsOnWrite).toBe(false);
      expect(result.servers?.ts?.command).toBe("project-ts");
      expect(result.servers?.["plugin-only"]?.command).toBe("plugin-ls");
      expect(result.servers?.user?.command).toBe("user-ls");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores plugin LSP config without loaded shell permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-lsp-plugin-"));
    try {
      const projectRoot = join(root, "project");
      const pluginRoot = join(root, "plugin");
      await mkdir(projectRoot);
      await mkdir(pluginRoot);
      await writeFile(join(pluginRoot, "lsp.json"), JSON.stringify({ servers: { hidden: { command: "hidden-ls" } } }));
      const plugin = {
        pluginId: "demo",
        version: "1.0.0",
        root: pluginRoot,
        permissionState: { state: "needs-review", reason: "changed" },
        permissions: { shell: { allow: true } },
        capabilities: { skills: [], commandTools: [], lspServersConfigPath: "./lsp.json" },
      } as unknown as RegisteredPlugin;
      const result = await resolveRuntimeLspConfig({ cwd: projectRoot, plugins: [plugin] });
      expect(result.servers?.hidden).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records an invalid reviewed plugin LSP config without blocking other config", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-lsp-invalid-plugin-"));
    try {
      const projectRoot = join(root, "project");
      const pluginRoot = join(root, "plugin");
      await mkdir(projectRoot);
      await mkdir(pluginRoot);
      await writeFile(join(projectRoot, "lsp.json"), JSON.stringify({
        servers: { project: { command: "project-ls" } },
      }));
      await writeFile(join(pluginRoot, "lsp.json"), "{ invalid");
      const plugin = {
        pluginId: "demo",
        version: "1.0.0",
        root: pluginRoot,
        permissionState: { state: "loaded", reason: "approved" },
        permissions: { shell: { allow: true } },
        capabilities: { skills: [], commandTools: [], lspServersConfigPath: "./lsp.json" },
        diagnostics: [],
      } as unknown as RegisteredPlugin;

      const result = await resolveRuntimeLspConfig({ cwd: projectRoot, plugins: [plugin] });

      expect(result.servers?.project?.command).toBe("project-ls");
      expect(plugin.diagnostics).toContainEqual(expect.objectContaining({
        code: "lsp_config_invalid",
        path: join(pluginRoot, "lsp.json"),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges .lume project defaults before direct project overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-lsp-project-layers-"));
    try {
      await mkdir(join(root, ".lume"));
      await writeFile(join(root, ".lume", "lsp.yaml"), [
        "diagnosticsOnWrite: true",
        "servers:",
        "  inherited:",
        "    command: inherited-ls",
        "  ts:",
        "    command: lume-ts",
      ].join("\n"));
      await writeFile(join(root, "lsp.json"), JSON.stringify({
        diagnosticsOnWrite: false,
        servers: { ts: { command: "direct-ts" } },
      }));

      const result = await resolveRuntimeLspConfig({ cwd: root, plugins: [] });

      expect(result.diagnosticsOnWrite).toBe(false);
      expect(result.servers?.ts?.command).toBe("direct-ts");
      expect(result.servers?.inherited?.command).toBe("inherited-ls");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes the lazy flag through so run startup can warm up servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-lsp-lazy-"));
    const bare = await mkdtemp(join(tmpdir(), "lume-lsp-lazy-bare-"));
    try {
      await writeFile(join(root, "lsp.json"), JSON.stringify({ lazy: false }));
      const result = await resolveRuntimeLspConfig({ cwd: root, plugins: [] });
      expect(result.lazy).toBe(false);

      const defaulted = await resolveRuntimeLspConfig({
        cwd: bare,
        plugins: [],
      });
      expect(defaulted.lazy).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("does not read configs above the containing git repository (#203)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-lsp-boundary-"));
    const sub = join(root, "sub");
    try {
      // No .git anywhere: only cwd is consulted, the ancestor config is ignored
      await mkdir(sub, { recursive: true });
      await writeFile(join(root, "lsp.json"), JSON.stringify({
        servers: { ancestor: { command: "ancestor-ls" } },
      }));

      const noGit = await resolveRuntimeLspConfig({ cwd: sub, plugins: [] });
      expect(noGit.servers?.ancestor).toBeUndefined();

      // With .git at root, the root config is reachable from a subdirectory,
      // and configs above the git root stay invisible
      await mkdir(join(root, ".git"));
      const withGit = await resolveRuntimeLspConfig({ cwd: sub, plugins: [] });
      expect(withGit.servers?.ancestor?.command).toBe("ancestor-ls");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
