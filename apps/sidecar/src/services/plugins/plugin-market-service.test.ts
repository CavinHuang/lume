import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { FilePluginStateStore } from "../agent-runtime/plugins/plugin-state-store";
import { PluginRegistry } from "../agent-runtime/plugins/plugin-registry";
import { getLumeConfigYamlPath } from "../infra/config-paths";
import { getEffectivePluginRuntimeConfig } from "../system/lume-config-service";
import {
  PluginMarketError,
  PluginMarketService
} from "./plugin-market-service";

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

const DISABLED_OFFICIAL_MARKET_SOURCE = {
  id: "official",
  name: "Lume Plugins",
  kind: "remote-index",
  url: "https://github.com/CavinHuang/lume-plugins",
  enabled: false
};

function makeService(root: string, fetchImpl?: typeof fetch) {
  return new PluginMarketService({
    installedRoot: join(root, "installed"),
    legacyGlobalRoot: join(root, "legacy"),
    statePath: join(root, "plugins-state.json"),
    fetchImpl
  });
}

describe("PluginMarketService", () => {
  let prevHome: string | undefined;
  let prevConfigDir: string | undefined;
  let root = "";

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    root = mkdtempSync(join(tmpdir(), "lume-plugin-market-"));
    process.env.HOME = root;
    process.env.LUME_CONFIG_DIR = join(root, "config");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("inspects a local plugin and summarizes permissions", async () => {
    const pluginRoot = join(root, "source", "local-plugin");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "local-plugin",
      version: "1.0.0",
      skills: ["./skills"],
      commandTools: [{ name: "hello", command: "echo", args: ["hello"] }],
      permissions: {
        filesystem: { read: ["./**"], write: ["./data/**"] },
        network: { outbound: ["api.example.com"] },
        shell: { allow: true },
        hooks: { events: ["BeforeToolUse"] }
      }
    });

    const inspected = await makeService(root).inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });

    expect(inspected.kind).toBe("plugin");
    expect(inspected.normalized.pluginId).toBe("local-plugin");
    expect(inspected.permissionsHash).toHaveLength(64);
    expect(inspected.permissionSummary.riskLabels).toContain("shell");
    expect(inspected.permissionSummary.riskLabels).toContain("network");
    expect(inspected.permissionSummary.hookEvents).toEqual(["BeforeToolUse"]);
  });

  test("requires accepted permissions hash before installing plugin", async () => {
    const pluginRoot = join(root, "source", "needs-review");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "needs-review",
      version: "1.0.0"
    });

    await expect(
      makeService(root).installMarketItem({
        workspaceSlug: "default",
        kind: "plugin",
        source: { type: "local", path: pluginRoot }
      })
    ).rejects.toMatchObject({ code: "permission_review_required" });
  });

  test("installs a reviewed local plugin and registry can load it", async () => {
    const pluginRoot = join(root, "source", "reviewed");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "reviewed",
      version: "1.0.0"
    });
    const service = makeService(root);
    const inspected = await service.inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });

    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      source: { type: "local", path: pluginRoot },
      acceptedPermissionsHash: inspected.permissionsHash,
      enableScope: "workspace"
    });

    const state = await new FilePluginStateStore(join(root, "plugins-state.json")).read();
    expect(state.plugins.reviewed?.activeVersion).toBe("1.0.0");
    expect(state.plugins.reviewed?.versions["1.0.0"]?.permissionsHash).toBe(inspected.permissionsHash);
    expect(getEffectivePluginRuntimeConfig("default").enabled).toEqual(["reviewed"]);

    const registry = new PluginRegistry({
      installedRoot: join(root, "installed"),
      legacyGlobalRoot: join(root, "legacy"),
      stateStore: new FilePluginStateStore(join(root, "plugins-state.json"))
    });
    const listed = await registry.list({ enabled: ["reviewed"], disabled: [], directories: [] });
    expect(listed.plugins.map((plugin) => plugin.pluginId)).toEqual(["reviewed"]);

    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        global: { enabled: ["reviewed"] },
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE]
      }
    }), "utf-8");
    const catalog = await service.getMarketCatalog({ workspaceSlug: "default" });
    expect(catalog.plugins.find((plugin) => plugin.pluginId === "reviewed")?.installState).toBe("installed");
  });

  test("blocks uninstall of enabled plugin unless forced", async () => {
    const pluginRoot = join(root, "source", "enabled-plugin");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "enabled-plugin",
      version: "1.0.0"
    });
    const service = makeService(root);
    const inspected = await service.inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });
    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      source: { type: "local", path: pluginRoot },
      acceptedPermissionsHash: inspected.permissionsHash,
      enableScope: "global"
    });

    await expect(service.uninstallPlugin({ pluginId: "enabled-plugin" }))
      .rejects.toMatchObject({ code: "uninstall_blocked" });

    const result = await service.uninstallPlugin({ pluginId: "enabled-plugin", force: true });
    expect(result.removedVersions).toEqual(["1.0.0"]);
    expect(getEffectivePluginRuntimeConfig("default").enabled).toEqual([]);
    expect(existsSync(join(root, "installed", "enabled-plugin", "1.0.0"))).toBeFalse();
  });

  test("reads marketplace indexes and reinspects resolved sources", async () => {
    const pluginRoot = join(root, "source", "indexed");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "indexed",
      version: "1.0.0"
    });
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "indexed",
          name: "Indexed",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const catalog = await makeService(root).getMarketCatalog({ workspaceSlug: "default" });
    expect(catalog.plugins.map((plugin) => plugin.pluginId)).toContain("indexed");

    const inspected = await makeService(root).inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "market-item", sourceId: "local-market", itemId: "indexed" }
    });
    expect(inspected.kind).toBe("plugin");
    expect(inspected.normalized.pluginId).toBe("indexed");
  });

  test("reads .lume-plugin marketplace manifests with plugin and skill entries", async () => {
    const marketRoot = join(root, "marketplace");
    await writeJson(join(marketRoot, ".lume-plugin", "plugin.json"), {
      schema: "lume-plugin/v1",
      name: "superpowers",
      version: "6.0.2"
    });
    await mkdir(join(marketRoot, "skills", "debugging"), { recursive: true });
    await writeFile(join(marketRoot, "skills", "debugging", "SKILL.md"), "---\nname: Debugging\nversion: 1.0.0\n---\n\nDebug carefully.", "utf-8");
    await writeJson(join(marketRoot, ".lume-plugin", "marketplace.json"), {
      name: "superpowers-dev",
      description: "Development marketplace",
      owner: { name: "Jesse Vincent", email: "jesse@fsck.com" },
      plugins: [
        {
          name: "superpowers",
          description: "Core skills library",
          version: "6.0.2",
          source: "./"
        }
      ],
      skills: [
        {
          name: "Debugging",
          description: "Debugging workflow",
          version: "1.0.0",
          source: "./skills/debugging"
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "superpowers", name: "Superpowers", kind: "local-index", path: marketRoot, enabled: true }]
      }
    }), "utf-8");

    const catalog = await makeService(root).getMarketCatalog({ workspaceSlug: "default" });

    expect(catalog.plugins.map((plugin) => plugin.pluginId)).toContain("superpowers");
    expect(catalog.skills.find((skill) => skill.id === "superpowers:debugging")).toMatchObject({
      slug: "debugging",
      name: "Debugging",
      sourceType: "subscribed-market",
      sourceId: "superpowers:debugging"
    });
  });

  test("installs marketplace skill entries by item id", async () => {
    const marketRoot = join(root, "marketplace");
    await mkdir(join(marketRoot, "skills", "debugging"), { recursive: true });
    await writeFile(join(marketRoot, "skills", "debugging", "SKILL.md"), "---\nname: Debugging\n---\n\nDebug carefully.", "utf-8");
    await writeJson(join(marketRoot, ".lume-plugin", "marketplace.json"), {
      name: "superpowers-dev",
      skills: [{ name: "Debugging", source: "./skills/debugging" }]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "superpowers", name: "Superpowers", kind: "local-index", path: marketRoot, enabled: true }]
      }
    }), "utf-8");

    const result = await makeService(root).installMarketItem({
      workspaceSlug: "default",
      kind: "skill",
      itemId: "superpowers:debugging"
    });

    expect(result).toMatchObject({ kind: "skill", id: "superpowers:debugging", installed: true });
    expect(readFileSync(join(process.env.LUME_CONFIG_DIR ?? "", "agent-workspaces", "default", "skills", "debugging", "SKILL.md"), "utf-8"))
      .toContain("Debug carefully");
  });

  test("inspects local plugins with .lume-plugin/plugin.json manifests", async () => {
    const pluginRoot = join(root, "source", "lume-dir-plugin");
    await writeJson(join(pluginRoot, ".lume-plugin", "plugin.json"), {
      schema: "lume-plugin/v1",
      name: "lume-dir-plugin",
      version: "1.0.0"
    });

    const inspected = await makeService(root).inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });

    expect(inspected.normalized.pluginId).toBe("lume-dir-plugin");
    expect(inspected.normalized.manifestFormat).toBe("lume");
  });

  test("installs marketplace plugin items by item id after permission review", async () => {
    const pluginRoot = join(root, "source", "indexed-install");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "indexed-install",
      version: "1.0.0",
      permissions: {
        filesystem: { write: ["./data/**"] }
      }
    });
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "indexed-install",
          name: "Indexed Install",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const service = makeService(root);
    const detail = await service.getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:indexed-install"
    });
    const detailItemId = detail.item.kind === "plugin" ? detail.item.plugin.id : "";
    const hash = detail.inspect?.kind === "plugin" ? detail.inspect.permissionsHash : "";
    expect(detailItemId).toBe("local-market:indexed-install");

    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: detailItemId,
      acceptedPermissionsHash: hash,
      enableScope: "workspace"
    });

    const state = await new FilePluginStateStore(join(root, "plugins-state.json")).read();
    expect(state.plugins["indexed-install"]?.activeVersion).toBe("1.0.0");
    expect(getEffectivePluginRuntimeConfig("default").enabled).toEqual(["indexed-install"]);

    const installedDetail = await service.getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: detailItemId
    });
    const installedItem = installedDetail.item.kind === "plugin" ? installedDetail.item.plugin : null;
    const installedInspect = installedDetail.inspect?.kind === "plugin" ? installedDetail.inspect : null;
    expect(installedItem?.installState).toBe("installed");
    expect(installedItem?.enableState).toBe("workspace-enabled");
    expect(installedInspect?.installState).toBe("installed");
    expect(installedInspect?.enableState).toBe("workspace-enabled");
    expect(installedItem?.enableState).toBe(installedInspect?.enableState);
  });

  test("plugin detail returns README content for local plugin sources", async () => {
    const pluginRoot = join(root, "source", "readme-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "readme-plugin",
      version: "1.0.0",
      description: "README demo"
    });
    await writeFile(join(pluginRoot, "README.md"), "# README demo\n\nUse this plugin carefully.", "utf-8");
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "readme-plugin",
          name: "README Plugin",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const detail = await makeService(root).getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:readme-plugin"
    });

    expect(detail.readme).toMatchObject({
      markdown: "# README demo\n\nUse this plugin carefully.",
      truncated: false
    });
    expect(detail.readme?.path).toEndWith("README.md");
  });

  test("plugin detail returns marketplace metadata and local thumbnail data URLs", async () => {
    const pluginRoot = join(root, "source", "marketplace-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "marketplace-plugin",
      version: "1.0.0",
      marketplace: {
        thumbnail: "./assets/thumbnail.svg",
        docs: "./README.md",
        setup: [
          {
            id: "pair",
            title: "Enter pairing code",
            description: "Use the code from the companion app.",
            kind: "pairing-code"
          }
        ]
      }
    });
    await mkdir(join(pluginRoot, "assets"), { recursive: true });
    await writeFile(join(pluginRoot, "assets", "thumbnail.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"><rect width=\"8\" height=\"8\"/></svg>", "utf-8");
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "marketplace-plugin",
          name: "Marketplace Plugin",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const detail = await makeService(root).getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:marketplace-plugin"
    });
    const item = detail.item.kind === "plugin" ? detail.item.plugin : null;

    expect(item?.marketplace?.thumbnail).toMatchObject({
      path: "./assets/thumbnail.svg"
    });
    expect(item?.marketplace?.thumbnail?.url?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(item?.marketplace?.docs).toBe("./README.md");
    expect(item?.marketplace?.setup?.[0]).toMatchObject({
      id: "pair",
      kind: "pairing-code"
    });
  });

  test("plugin detail tolerates missing README", async () => {
    const pluginRoot = join(root, "source", "missing-readme-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "missing-readme-plugin",
      version: "1.0.0"
    });
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "missing-readme-plugin",
          name: "Missing README Plugin",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const detail = await makeService(root).getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:missing-readme-plugin"
    });

    expect(detail.item.kind).toBe("plugin");
    expect(detail.readme).toBeUndefined();
  });

  test("plugin detail reads local readme filenames case-insensitively", async () => {
    const pluginRoot = join(root, "source", "lowercase-readme-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "lowercase-readme-plugin",
      version: "1.0.0"
    });
    await writeFile(join(pluginRoot, "readme.md"), "# lowercase readme", "utf-8");
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "lowercase-readme-plugin",
          name: "Lowercase README Plugin",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const detail = await makeService(root).getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:lowercase-readme-plugin"
    });

    expect(detail.readme?.markdown).toBe("# lowercase readme");
    expect(detail.readme?.path).toEndWith("readme.md");
  });

  test("github inspect uses mocked GitHub tree and raw files", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/git/trees/main")) {
        return Response.json({
          tree: [
            { path: "lume-plugin.json", type: "blob" },
            { path: "skills/demo/SKILL.md", type: "blob" }
          ]
        });
      }
      if (url.includes("raw.githubusercontent.com")) {
        return new Response(JSON.stringify({
          schema: "lume-plugin/v1",
          name: "github-plugin",
          version: "1.0.0",
          skills: ["./skills"]
        }), { status: 200 });
      }
      return Response.json({ default_branch: "main" });
    }) as unknown as typeof fetch;

    const inspected = await makeService(root, fetchImpl).inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "github", owner: "acme", repo: "plugin", ref: "main", url: "https://github.com/acme/plugin" }
    });

    expect(inspected.kind).toBe("plugin");
    expect(inspected.normalized.pluginId).toBe("github-plugin");
  });

  test("github inspect supports .codex-plugin plugin manifests", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/git/trees/main")) {
        return Response.json({ tree: [{ path: ".codex-plugin/plugin.json", type: "blob" }] });
      }
      if (url.includes("raw.githubusercontent.com")) {
        return new Response(JSON.stringify({
          name: "codex-github-plugin",
          version: "1.0.0",
          interface: { displayName: "Codex GitHub Plugin" }
        }), { status: 200 });
      }
      return Response.json({ default_branch: "main" });
    }) as unknown as typeof fetch;

    const inspected = await makeService(root, fetchImpl).inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "github", owner: "acme", repo: "plugin", ref: "main", url: "https://github.com/acme/plugin" }
    });

    expect(inspected.normalized.pluginId).toBe("codex-github-plugin");
    expect(inspected.normalized.manifestFormat).toBe("codex");
  });

  test("github install reports tarball download failures", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/git/trees/main")) {
        return Response.json({ tree: [{ path: "lume-plugin.json", type: "blob" }] });
      }
      if (url.includes("raw.githubusercontent.com")) {
        return new Response(JSON.stringify({
          schema: "lume-plugin/v1",
          name: "github-plugin",
          version: "1.0.0"
        }), { status: 200 });
      }
      if (url.includes("/tarball/")) {
        return new Response("nope", { status: 500 });
      }
      return Response.json({ default_branch: "main" });
    }) as unknown as typeof fetch;
    const service = makeService(root, fetchImpl);
    const inspected = await service.inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "github", owner: "acme", repo: "plugin", ref: "main", url: "https://github.com/acme/plugin" }
    });

    await expect(service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      source: { type: "github", owner: "acme", repo: "plugin", ref: "main", url: "https://github.com/acme/plugin" },
      acceptedPermissionsHash: inspected.permissionsHash
    })).rejects.toMatchObject({ code: "install_failed" });
  });
});
