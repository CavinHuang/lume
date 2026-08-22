import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { FilePluginStateStore } from "../agent-runtime/plugins/plugin-state-store";
import { PluginRegistry } from "../agent-runtime/plugins/plugin-registry";
import { getLumeConfigYamlPath } from "../infra/config-paths";
import { getEffectivePluginRuntimeConfig } from "../system/lume-config-service";
import {
  clearPluginMarketInMemoryCatalogLeasesForTest,
  PluginMarketError,
  PluginMarketService,
  selectPluginSetupArtifact,
} from "./plugin-market-service";

test("selectPluginSetupArtifact chooses the current platform runtime", () => {
  const step = {
    artifacts: [
      { path: "./runtime/win32-x64/host.exe", kind: "native-binary" as const, platform: "win32" as const, arch: "x64" as const },
      { path: "./runtime/darwin-arm64/host", kind: "native-binary" as const, platform: "darwin" as const, arch: "arm64" as const },
    ],
  };
  expect(selectPluginSetupArtifact(step, { platform: "win32", arch: "x64" })?.path).toBe("./runtime/win32-x64/host.exe");
  expect(selectPluginSetupArtifact(step, { platform: "linux", arch: "x64" })).toBeUndefined();
});

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
  let prevUserProfile: string | undefined;
  let prevConfigDir: string | undefined;
  let root = "";

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    root = mkdtempSync(join(tmpdir(), "lume-plugin-market-"));
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.LUME_CONFIG_DIR = join(root, "config");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
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

  test("plugin install records sensitive approval for declared MCP servers", async () => {
    const pluginRoot = join(root, "source", "obsidian-bridge");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "obsidian-bridge",
      version: "0.1.0",
      mcpServers: "./mcp.json",
      permissions: {
        mcpServers: { register: true }
      }
    });
    await writeJson(join(pluginRoot, "mcp.json"), {
      mcpServers: {
        "obsidian-bridge": {
          command: "node",
          args: ["server.js"]
        }
      }
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
    const approvals = state.plugins["obsidian-bridge"]?.versions["0.1.0"]?.sensitiveApprovals ?? [];
    expect(approvals).toContainEqual(expect.objectContaining({
      key: "mcpServer:obsidian-bridge:obsidian-bridge",
      scope: "workspace",
      workspaceSlug: "default",
      decision: "allow",
      permissionsHash: inspected.permissionsHash
    }));
  });

  test("installing a new permissions hash prunes approval bundles from older hashes (#344)", async () => {
    const pluginRoot = join(root, "source", "prune");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "prune",
      version: "1.0.0",
      commandTools: [{ name: "prune_echo", command: "echo", args: ["hi"] }],
      permissions: { tools: { allow: ["Read"] } }
    });
    const statePath = join(root, "plugins-state.json");
    // Seed an approval bundle recorded under a previous, now-stale hash.
    await writeJson(statePath, {
      plugins: {
        prune: {
          pluginId: "prune",
          versions: {},
          approvalsByHash: {
            stalehash: {
              permissionsHash: "stalehash",
              sensitiveApprovals: [
                {
                  key: "commandTool:prune_echo",
                  scope: "global",
                  decision: "allow",
                  createdAt: "2026-01-01T00:00:00Z",
                  permissionsHash: "stalehash"
                }
              ]
            }
          }
        }
      }
    });

    const service = makeService(root);
    const inspected = await service.inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });
    expect(inspected.permissionsHash).not.toBe("stalehash");

    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      source: { type: "local", path: pluginRoot },
      acceptedPermissionsHash: inspected.permissionsHash
    });

    const state = await new FilePluginStateStore(statePath).read();
    expect(Object.keys(state.plugins.prune?.approvalsByHash ?? {})).toEqual([inspected.permissionsHash]);
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

  test("marks plugin update only when market semver is higher than active version", async () => {
    const pluginRoot = join(root, "source", "semver-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "semver-plugin",
      version: "1.2.0"
    });
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "semver-plugin",
          name: "Semver Plugin",
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
      itemId: "local-market:semver-plugin"
    });
    const hash = detail.inspect?.kind === "plugin" ? detail.inspect.permissionsHash : "";
    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:semver-plugin",
      acceptedPermissionsHash: hash,
      enableScope: "workspace"
    });

    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "semver-plugin",
      version: "1.3.0"
    });
    const newer = await service.getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:semver-plugin"
    });
    expect(newer.inspect?.kind === "plugin" ? newer.inspect.installState : "").toBe("update-available");

    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "semver-plugin",
      version: "1.1.9"
    });
    const lower = await service.getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:semver-plugin"
    });
    expect(lower.inspect?.kind === "plugin" ? lower.inspect.installState : "").toBe("installed");
  });

  test("updates plugin versions while preserving enablement and one rollback version", async () => {
    const pluginRoot = join(root, "source", "update-plugin");
    const indexPath = join(root, "market.json");
    const writePlugin = (version: string) => writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "update-plugin",
      version,
      permissions: { filesystem: { read: ["./**"] } }
    });
    await writePlugin("1.0.0");
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "update-plugin",
          name: "Update Plugin",
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
    const initialDetail = await service.getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:update-plugin"
    });
    const initialHash = initialDetail.inspect?.kind === "plugin" ? initialDetail.inspect.permissionsHash : "";
    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:update-plugin",
      acceptedPermissionsHash: initialHash,
      enableScope: "workspace"
    });

    await writePlugin("1.1.0");
    const firstUpdate = await service.updatePlugin({
      workspaceSlug: "default",
      pluginId: "update-plugin"
    });
    expect(firstUpdate).toMatchObject({
      pluginId: "update-plugin",
      installedVersion: "1.1.0",
      activeVersion: "1.1.0",
      previousActiveVersion: "1.0.0",
      retainedVersions: ["1.1.0", "1.0.0"]
    });
    expect(getEffectivePluginRuntimeConfig("default").enabled).toEqual(["update-plugin"]);

    await writePlugin("1.2.0");
    const secondUpdate = await service.updatePlugin({
      workspaceSlug: "default",
      pluginId: "update-plugin"
    });
    expect(secondUpdate.retainedVersions).toEqual(["1.2.0", "1.1.0"]);
    const state = await new FilePluginStateStore(join(root, "plugins-state.json")).read();
    expect(state.plugins["update-plugin"]?.activeVersion).toBe("1.2.0");
    expect(Object.keys(state.plugins["update-plugin"]?.versions ?? {}).sort()).toEqual(["1.1.0", "1.2.0"]);
    expect(existsSync(join(root, "installed", "update-plugin", "1.0.0"))).toBe(false);
    const updatedDetail = await service.getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:update-plugin"
    });
    const updatedItem = updatedDetail.item.kind === "plugin" ? updatedDetail.item.plugin : null;
    expect(updatedItem?.installedVersion).toBe("1.2.0");
    expect(updatedItem?.rollbackVersion).toBe("1.1.0");
    expect(updatedItem?.installedPermissionsHash).toBe(state.plugins["update-plugin"]?.versions["1.2.0"]?.permissionsHash);

    const rollback = await service.setPluginActiveVersion({
      pluginId: "update-plugin",
      version: "1.1.0"
    });
    expect(rollback).toMatchObject({
      previousActiveVersion: "1.2.0",
      activeVersion: "1.1.0",
      needsReview: false
    });
  });

  test("requires permission review when updating to changed plugin permissions", async () => {
    const pluginRoot = join(root, "source", "permission-update-plugin");
    const writePlugin = (version: string, writePermission = false) => writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "permission-update-plugin",
      version,
      permissions: writePermission ? { filesystem: { write: ["./data/**"] } } : {}
    });
    await writePlugin("1.0.0");

    const service = makeService(root);
    const initial = await service.inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });
    await service.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      source: { type: "local", path: pluginRoot },
      acceptedPermissionsHash: initial.permissionsHash,
      enableScope: "workspace"
    });

    await writePlugin("1.1.0", true);
    await expect(
      service.updatePlugin({
        workspaceSlug: "default",
        pluginId: "permission-update-plugin"
      })
    ).rejects.toMatchObject({ code: "permission_review_required" });

    const changed = await service.inspectMarketSource({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    });
    const updated = await service.updatePlugin({
      workspaceSlug: "default",
      pluginId: "permission-update-plugin",
      acceptedPermissionsHash: changed.permissionsHash
    });
    expect(updated.activeVersion).toBe("1.1.0");
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

  test("prepares and saves a declared local companion package by opaque catalog key", async () => {
    const pluginRoot = join(root, "source", "package-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "package-plugin",
      version: "1.0.0",
      marketplace: {
        setup: [{
          id: "save-extension",
          title: "Save extension",
          description: "Export the Chrome extension package.",
          artifact: { path: "./packages/extension.zip", kind: "chrome-extension" }
        }]
      }
    });
    await mkdir(join(pluginRoot, "packages"), { recursive: true });
    await writeFile(join(pluginRoot, "packages", "extension.zip"), "extension-bytes", "utf-8");
    await writeJson(indexPath, {
      items: [{ kind: "plugin", id: "package-plugin", source: { type: "local", path: pluginRoot } }]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");
    const service = makeService(root);
    const catalog = await service.getMarketCatalog({ workspaceSlug: "default" });
    const item = catalog.plugins.find((plugin) => plugin.pluginId === "package-plugin");
    expect(item?.catalogItemKey).toBeTruthy();
    clearPluginMarketInMemoryCatalogLeasesForTest();

    const prepared = await service.preparePluginPackage({
      workspaceSlug: "default",
      catalogItemKey: item!.catalogItemKey!,
      setupStepId: "save-extension",
      ownerWebContentsId: 11,
      ownerGeneration: 2,
    });
    const target = join(root, "exported", "extension.zip");
    await service.finalizePluginPackage({
      token: prepared.token,
      ownerWebContentsId: 11,
      ownerGeneration: 2,
      targetPath: target,
    });
    expect(readFileSync(target, "utf8")).toBe("extension-bytes");

    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "package-plugin",
      version: "1.0.1",
      marketplace: {
        setup: [{
          id: "save-extension",
          title: "Save extension",
          description: "Export the Chrome extension package.",
          artifact: { path: "./packages/extension.zip", kind: "chrome-extension" }
        }]
      }
    });
    await expect(service.preparePluginPackage({
      workspaceSlug: "default",
      catalogItemKey: item!.catalogItemKey!,
      setupStepId: "save-extension",
      ownerWebContentsId: 11,
      ownerGeneration: 2,
    })).rejects.toThrow(/内容已变化/);
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

  test("remote marketplace pins commits, deduplicates trees, and isolates invalid entries", async () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [
          DISABLED_OFFICIAL_MARKET_SOURCE,
          { id: "remote-market", name: "Remote", kind: "remote-index", url: "https://github.com/acme/market", enabled: true }
        ]
      }
    }), "utf-8");

    const sha = "a".repeat(40);
    let treeRequests = 0;
    const fetchImpl = (async (url: string) => {
      if (url === "https://api.github.com/repos/acme/market") {
        return Response.json({ default_branch: "main" });
      }
      if (url === "https://api.github.com/repos/acme/market/commits/main") {
        return Response.json({ sha });
      }
      if (url === `https://raw.githubusercontent.com/acme/market/${sha}/.lume-plugin/marketplace.json`) {
        return new Response(JSON.stringify({
          plugins: [
            { name: "remote-plugin", description: "Remote plugin", source: "./plugins/remote-plugin" },
            { name: "broken-plugin", description: "Broken plugin", source: "./plugins/broken-plugin" }
          ]
        }), { status: 200 });
      }
      if (url.includes(`/git/trees/${sha}`)) {
        treeRequests++;
        return Response.json({ tree: [
          { path: "plugins/remote-plugin/lume-plugin.json", type: "blob" },
          { path: "plugins/broken-plugin/lume-plugin.json", type: "blob" }
        ] });
      }
      if (url === `https://raw.githubusercontent.com/acme/market/${sha}/plugins/remote-plugin/.lume-plugin/plugin.json`) {
        return new Response("missing", { status: 404 });
      }
      if (url === `https://raw.githubusercontent.com/acme/market/${sha}/plugins/remote-plugin/lume-plugin.json`) {
        return new Response(JSON.stringify({
          schema: "lume-plugin/v1",
          name: "remote-plugin",
          displayName: "Remote Plugin",
          version: "1.0.0"
        }), { status: 200 });
      }
      if (url === `https://raw.githubusercontent.com/acme/market/${sha}/plugins/broken-plugin/lume-plugin.json`) {
        return Response.json({ schema: "lume-plugin/v1" });
      }
      return new Response("unexpected url", { status: 500 });
    }) as unknown as typeof fetch;

    const catalog = await makeService(root, fetchImpl).getMarketCatalog({ workspaceSlug: "default" });

    expect(catalog.plugins.map((plugin) => plugin.pluginId)).toEqual(["remote-plugin"]);
    expect(treeRequests).toBe(1);
    expect(catalog.diagnostics.some((diagnostic) => diagnostic.message.includes("broken-plugin"))).toBe(true);
    expect(catalog.plugins[0]?.installState).toBe("not-installed");
    expect(catalog.syncedAt).toBeTruthy();
  });

  test("prefers a configured mirror snapshot without calling GitHub", async () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [{
          id: "official",
          name: "Lume Plugins",
          kind: "remote-index",
          url: "https://github.com/CavinHuang/lume-plugins",
          mirrorUrl: "https://mirror.example",
          enabled: true,
        }]
      }
    }), "utf-8");
    const sha = "c".repeat(40);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url === `https://mirror.example/v1/snapshots/${sha}/raw/plugins/mirrored-plugin/assets/icon.svg`) {
        return new Response("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", {
          headers: { "content-type": "image/svg+xml" },
        });
      }
      if (url === "https://mirror.example/v1/catalog") return Response.json({
        schema: "lume-plugin-market-mirror/v1",
        generation: sha,
        generatedAt: "2026-07-21T00:00:00.000Z",
        source: {
          owner: "CavinHuang",
          repo: "lume-plugins",
          ref: "main",
          commit: sha,
          url: "https://github.com/CavinHuang/lume-plugins",
        },
        archivePath: `/v1/snapshots/${sha}/archive.tar.gz`,
        rawBasePath: `/v1/snapshots/${sha}/raw/`,
        diagnostics: [],
        plugins: [{
          id: "mirrored-plugin",
          name: "mirrored-plugin",
          version: "1.0.0",
          subdir: "plugins/mirrored-plugin",
          manifest: {
            schema: "lume-plugin/v1",
            name: "mirrored-plugin",
            version: "1.0.0",
            marketplace: { icon: "./assets/icon.svg" },
          },
        }],
        skills: [],
      });
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const catalog = await makeService(root, fetchImpl).getMarketCatalog({ workspaceSlug: "default", cacheMode: "force-refresh" });

    expect(catalog.plugins.map((plugin) => plugin.pluginId)).toEqual(["mirrored-plugin"]);
    expect(catalog.plugins[0]?.marketplace?.icon?.url).toStartWith("data:image/svg+xml;base64,");
    expect(urls).toEqual([
      "https://mirror.example/v1/catalog",
      `https://mirror.example/v1/snapshots/${sha}/raw/plugins/mirrored-plugin/assets/icon.svg`,
    ]);
  });

  test("falls back to GitHub when the configured mirror is unavailable", async () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [{
          id: "official",
          name: "Lume Plugins",
          kind: "remote-index",
          url: "https://github.com/CavinHuang/lume-plugins",
          mirrorUrl: "https://mirror.example",
          enabled: true,
        }]
      }
    }), "utf-8");
    const sha = "d".repeat(40);
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url === "https://mirror.example/v1/catalog") return new Response("offline", { status: 503 });
      if (url === "https://api.github.com/repos/CavinHuang/lume-plugins") return Response.json({ default_branch: "main" });
      if (url === "https://api.github.com/repos/CavinHuang/lume-plugins/commits/main") return Response.json({ sha });
      if (url === `https://raw.githubusercontent.com/CavinHuang/lume-plugins/${sha}/.lume-plugin/marketplace.json`) {
        return Response.json({ plugins: [{ name: "fallback-plugin", source: "./plugins/fallback-plugin" }] });
      }
      if (url.includes(`/git/trees/${sha}`)) {
        return Response.json({ tree: [{ path: "plugins/fallback-plugin/lume-plugin.json", type: "blob" }] });
      }
      if (url === `https://raw.githubusercontent.com/CavinHuang/lume-plugins/${sha}/plugins/fallback-plugin/lume-plugin.json`) {
        return Response.json({ schema: "lume-plugin/v1", name: "fallback-plugin", version: "1.0.0" });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const catalog = await makeService(root, fetchImpl).getMarketCatalog({ workspaceSlug: "default", cacheMode: "force-refresh" });

    expect(catalog.plugins.map((plugin) => plugin.pluginId)).toEqual(["fallback-plugin"]);
    expect(urls[0]).toBe("https://mirror.example/v1/catalog");
    expect(urls).toContain(`https://raw.githubusercontent.com/CavinHuang/lume-plugins/${sha}/.lume-plugin/marketplace.json`);
  });

  test("reuses the persisted remote snapshot without reinspecting plugins", async () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [
          DISABLED_OFFICIAL_MARKET_SOURCE,
          { id: "cached-market", name: "Cached", kind: "remote-index", url: "https://github.com/acme/cached", enabled: true }
        ]
      }
    }), "utf-8");
    const sha = "b".repeat(40);
    let fetchCount = 0;
    const fetchImpl = (async (url: string) => {
      fetchCount++;
      if (url === "https://api.github.com/repos/acme/cached") return Response.json({ default_branch: "main" });
      if (url === "https://api.github.com/repos/acme/cached/commits/main") return Response.json({ sha });
      if (url === `https://raw.githubusercontent.com/acme/cached/${sha}/.lume-plugin/marketplace.json`) {
        return Response.json({ plugins: [{ name: "cached-plugin", source: "./plugins/cached-plugin" }] });
      }
      if (url.includes(`/git/trees/${sha}`)) {
        return Response.json({ tree: [{ path: "plugins/cached-plugin/lume-plugin.json", type: "blob" }] });
      }
      if (url === `https://raw.githubusercontent.com/acme/cached/${sha}/plugins/cached-plugin/lume-plugin.json`) {
        return Response.json({ schema: "lume-plugin/v1", name: "cached-plugin", version: "1.0.0" });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const first = await makeService(root, fetchImpl).getMarketCatalog({ workspaceSlug: "default", cacheMode: "force-refresh" });
    expect(first.plugins.map((plugin) => plugin.pluginId)).toEqual(["cached-plugin"]);
    const cacheDirectory = join(root, "cache", "market-snapshots", "v1");
    const currentPointer = readdirSync(cacheDirectory).find((name) => name.endsWith(".current"));
    expect(currentPointer).toBeTruthy();
    writeFileSync(join(cacheDirectory, currentPointer!), "interrupted-pointer-write", "utf8");
    const firstFetchCount = fetchCount;
    const failFetch = (async () => {
      fetchCount++;
      throw new Error("cache miss");
    }) as unknown as typeof fetch;
    const second = await makeService(root, failFetch).getMarketCatalog({ workspaceSlug: "default" });

    expect(second.plugins.map((plugin) => plugin.pluginId)).toEqual(["cached-plugin"]);
    expect(fetchCount).toBe(firstFetchCount);
    expect(second.status).toBe("fresh");
  });

  test("github install reports tarball download failures", async () => {
    const sha = "a".repeat(40);
    const tarballUrls: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.includes("/commits/main")) {
        return Response.json({ sha });
      }
      if (url.includes("/git/trees/")) {
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
        tarballUrls.push(url);
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
    // 安装阶段的 tarball 下载必须 pin 到 commit SHA（而非分支名），
    // 保证权限审批（permissionsHash）与落盘代码指向同一提交
    expect(tarballUrls).toEqual([`https://api.github.com/repos/acme/plugin/tarball/${sha}`]);
  });
});
