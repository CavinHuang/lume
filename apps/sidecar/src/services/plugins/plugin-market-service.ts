import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  computePermissionsHash,
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginPermissions
} from "@lume/agent-sdk";
import type {
  AgentPluginDiagnostic,
  GetMarketCatalogInput,
  GetMarketCatalogResult,
  GetMarketDetailInput,
  GetMarketDetailResult,
  InspectMarketSourceInput,
  InspectMarketSourceRef,
  InspectPluginResult,
  InstallMarketItemInput,
  InstallMarketItemResult,
  PluginCapabilitySummary,
  PluginEnableState,
  PluginMarketItem,
  PluginPermissionSummary,
  PluginSourceRef,
  SetPluginEnablementInput,
  SetPluginEnablementResult,
  UninstallPluginInput,
  UninstallPluginResult,
  UpdatePluginInput,
  UpdatePluginResult,
} from "@lume/shared";
import { getSkillMarketCatalog, getSkillMarketDetail, installSkillMarketItemToWorkspace } from "../skills/skills-market-service";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig, updateLumeConfigSection } from "../system/lume-config-service";
import { FilePluginStateStore, type PluginInstallRecord } from "../agent-runtime/plugins/plugin-state-store";
import { PluginRegistry } from "../agent-runtime/plugins/plugin-registry";

const execFileAsync = promisify(execFile);

export class PluginMarketError extends Error {
  constructor(
    public readonly code:
      | "source_not_found"
      | "network_failed"
      | "invalid_manifest"
      | "invalid_skill"
      | "permission_review_required"
      | "permission_review_cancelled"
      | "install_failed"
      | "uninstall_blocked"
      | "not_installed"
      | "already_installed",
    message: string,
    public readonly diagnostics?: AgentPluginDiagnostic[],
  ) {
    super(message);
    this.name = "PluginMarketError";
  }
}

export interface PluginMarketServiceConfig {
  installedRoot: string;
  legacyGlobalRoot: string;
  statePath: string;
  fetchImpl?: typeof fetch;
}

export function createDefaultPluginMarketService(): PluginMarketService {
  const pluginRoot = join(homedir(), ".lume", "plugins");
  return new PluginMarketService({
    installedRoot: pluginRoot,
    legacyGlobalRoot: pluginRoot,
    statePath: join(homedir(), ".lume", "plugins-state.json"),
  });
}

interface MarketIndexPluginEntry {
  kind: "plugin";
  id: string;
  name?: string;
  source: PluginSourceRef;
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

type SidecarInspectPluginResult = Omit<InspectPluginResult, "normalized"> & {
  normalized: NormalizedPlugin;
};

export class PluginMarketService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PluginMarketServiceConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getMarketCatalog(input: GetMarketCatalogInput): Promise<GetMarketCatalogResult> {
    const skills = getSkillMarketCatalog(input).items;
    const diagnostics: AgentPluginDiagnostic[] = [];
    const byId = new Map<string, PluginMarketItem>();

    const runtimeConfig = getEffectivePluginRuntimeConfig(input.workspaceSlug);
    const registry = new PluginRegistry({
      installedRoot: this.config.installedRoot,
      legacyGlobalRoot: this.config.legacyGlobalRoot,
      stateStore: new FilePluginStateStore(this.config.statePath),
    });
    const listed = await registry.list({
      enabled: runtimeConfig.enabled,
      disabled: runtimeConfig.disabled,
      directories: runtimeConfig.directories,
    });
    diagnostics.push(...listed.diagnostics as AgentPluginDiagnostic[]);
    for (const plugin of listed.plugins) {
      byId.set(plugin.pluginId, this.toMarketItem(plugin, input.workspaceSlug, "local"));
    }

    for (const source of runtimeConfig.marketSources) {
      try {
        const entries = await this.readMarketIndex(source.id);
        for (const entry of entries) {
          try {
            const inspected = await this.inspectPluginSource(input.workspaceSlug, entry.source);
            const item = this.toMarketItem(inspected.normalized, input.workspaceSlug, entry.source.type, inspected.installState);
            item.id = `${source.id}:${entry.id}`;
            byId.set(inspected.normalized.pluginId, item);
          } catch (error) {
            diagnostics.push({
              severity: "warning",
              code: "invalid_manifest",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "invalid_manifest",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      plugins: [...byId.values()].sort((left, right) => left.name.localeCompare(right.name)),
      skills,
      diagnostics,
    };
  }

  async inspectMarketSource(input: InspectMarketSourceInput): Promise<SidecarInspectPluginResult> {
    const source = await this.resolveInspectSource(input.source);
    return this.inspectPluginSource(input.workspaceSlug, source);
  }

  async getMarketDetail(input: GetMarketDetailInput): Promise<GetMarketDetailResult> {
    if (input.kind === "skill") {
      const detail = getSkillMarketDetail({ workspaceSlug: input.workspaceSlug, skillSlug: input.itemId });
      return {
        item: { kind: "skill", skill: detail.item },
        inspect: { kind: "skill", item: detail.item, fileTree: detail.files },
        diagnostics: [],
      };
    }

    const source = await this.resolveInspectSource(parseMarketItemId(input.itemId));
    const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
    return {
      item: { kind: "plugin", plugin: this.toMarketItem(inspected.normalized, input.workspaceSlug, source.type) },
      inspect: inspected,
      diagnostics: inspected.diagnostics,
    };
  }

  async installMarketItem(input: InstallMarketItemInput): Promise<InstallMarketItemResult> {
    if (input.kind === "skill") {
      if (!input.itemId) {
        throw new PluginMarketError("source_not_found", "skill install requires itemId");
      }
      const result = installSkillMarketItemToWorkspace({
        workspaceSlug: input.workspaceSlug,
        skillId: input.itemId,
        overwrite: input.overwrite,
      });
      return { kind: "skill", id: input.itemId, installed: result.imported };
    }

    const requestedSource = input.source ?? (input.itemId ? parseMarketItemId(input.itemId) : null);
    if (!requestedSource) {
      throw new PluginMarketError("source_not_found", "plugin install requires source or itemId");
    }
    const source = await this.resolveInspectSource(requestedSource);
    const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
    if (input.acceptedPermissionsHash !== inspected.permissionsHash) {
      throw new PluginMarketError(
        "permission_review_required",
        "插件权限已变化或尚未确认",
        inspected.diagnostics,
      );
    }

    try {
      const installedRoot = await this.stageInstall(source, inspected.normalized);
      await this.recordInstalledPlugin({
        plugin: inspected.normalized,
        source,
        installedRoot,
        permissionsHash: inspected.permissionsHash,
      });
      if (input.enableScope && input.enableScope !== "none") {
        await this.setPluginEnablement({
          workspaceSlug: input.workspaceSlug,
          pluginId: inspected.normalized.pluginId,
          scope: input.enableScope,
          enabled: true,
        });
      }
      return {
        kind: "plugin",
        id: inspected.normalized.pluginId,
        version: inspected.normalized.version,
        installed: true,
        enableState: this.resolveEnableState(inspected.normalized.pluginId, input.workspaceSlug),
        diagnostics: inspected.diagnostics,
      };
    } catch (error) {
      if (error instanceof PluginMarketError) throw error;
      throw new PluginMarketError("install_failed", error instanceof Error ? error.message : String(error), inspected.diagnostics);
    }
  }

  async updatePlugin(input: UpdatePluginInput): Promise<UpdatePluginResult> {
    const record = (await this.stateStore().read()).plugins[input.pluginId];
    const active = record?.activeVersion;
    const source = input.source ?? record?.versions[active ?? ""]?.source as PluginSourceRef | undefined;
    if (!source) throw new PluginMarketError("source_not_found", "找不到插件来源");
    const installed = await this.installMarketItem({
      workspaceSlug: "default",
      kind: "plugin",
      source,
      acceptedPermissionsHash: input.acceptedPermissionsHash,
      enableScope: input.activate ? "global" : "none",
      overwrite: true,
    });
    return {
      pluginId: input.pluginId,
      installedVersion: installed.version ?? "",
      activeVersion: installed.version ?? "",
      activated: input.activate === true,
      needsReview: false,
      diagnostics: installed.diagnostics,
    };
  }

  async uninstallPlugin(input: UninstallPluginInput): Promise<UninstallPluginResult> {
    const stateStore = this.stateStore();
    const state = await stateStore.read();
    const record = state.plugins[input.pluginId];
    if (!record) {
      throw new PluginMarketError("not_installed", "插件未安装");
    }

    const blocked = this.findEnabledScopes(input.pluginId);
    if (blocked.length > 0 && !input.force) {
      throw new PluginMarketError("uninstall_blocked", "插件仍处于启用状态");
    }
    if (blocked.length > 0) {
      for (const scope of blocked) {
        await this.setPluginEnablement({
          ...(scope.workspaceSlug ? { workspaceSlug: scope.workspaceSlug } : {}),
          pluginId: input.pluginId,
          scope: scope.scope,
          enabled: false,
        });
      }
    }

    const versions = input.version ? [input.version] : Object.keys(record.versions);
    for (const version of versions) {
      const installed = record.versions[version];
      if (installed?.installedRoot) {
        rmSync(installed.installedRoot, { recursive: true, force: true });
      }
      delete record.versions[version];
      if (record.activeVersion === version) {
        record.activeVersion = Object.keys(record.versions)[0];
      }
    }
    if (Object.keys(record.versions).length === 0) {
      delete state.plugins[input.pluginId];
    }
    await stateStore.write(state);
    return {
      pluginId: input.pluginId,
      removedVersions: versions,
      disabledScopes: blocked,
    };
  }

  async setPluginEnablement(input: SetPluginEnablementInput): Promise<SetPluginEnablementResult> {
    const config = getEffectiveLumeConfig();
    const plugins = config.plugins ?? { global: { enabled: [], disabled: [] }, workspaces: {}, directories: [], marketSources: [] };
    const path = input.scope === "global" ? "plugins.global" : `plugins.workspaces.${input.workspaceSlug}`;
    const current = input.scope === "global"
      ? plugins.global ?? {}
      : plugins.workspaces?.[input.workspaceSlug ?? ""] ?? {};
    const enabled = new Set(current.enabled ?? []);
    const disabled = new Set(current.disabled ?? []);
    if (input.enabled) {
      enabled.add(input.pluginId);
      disabled.delete(input.pluginId);
    } else {
      disabled.add(input.pluginId);
      enabled.delete(input.pluginId);
    }
    updateLumeConfigSection({
      source: "system",
      path,
      value: {
        enabled: [...enabled].sort(),
        disabled: [...disabled].sort(),
      },
      summary: `${input.enabled ? "enable" : "disable"} plugin ${input.pluginId}`,
    });
    return {
      pluginId: input.pluginId,
      version: input.version,
      scope: input.scope,
      enabled: input.enabled,
      enableState: this.resolveEnableState(input.pluginId, input.workspaceSlug),
      needsReview: false,
    };
  }

  async setPluginActiveVersion(input: { pluginId: string; version: string }): Promise<{
    pluginId: string;
    previousActiveVersion?: string;
    activeVersion: string;
    needsReview: boolean;
  }> {
    const stateStore = this.stateStore();
    const state = await stateStore.read();
    const record = state.plugins[input.pluginId];
    if (!record?.versions[input.version]) {
      throw new PluginMarketError("not_installed", "插件版本未安装");
    }
    const previousActiveVersion = record.activeVersion;
    record.activeVersion = input.version;
    await stateStore.write(state);
    return { pluginId: input.pluginId, previousActiveVersion, activeVersion: input.version, needsReview: false };
  }

  private async inspectPluginSource(workspaceSlug: string, source: PluginSourceRef): Promise<SidecarInspectPluginResult> {
    if (source.type === "subscribed-market") {
      return this.inspectPluginSource(workspaceSlug, source.resolved);
    }
    const normalized = source.type === "github"
      ? await this.inspectGitHubPlugin(source)
      : this.readLocalPlugin(source.path);
    const permissionsHash = computePermissionsHash(normalized);
    return {
      kind: "plugin",
      normalized,
      permissionSummary: summarizePermissions(normalized.permissions),
      permissionsHash,
      installState: await this.resolveInstallState(normalized),
      enableState: this.resolveEnableState(normalized.pluginId, workspaceSlug),
      diagnostics: normalized.diagnostics as AgentPluginDiagnostic[],
    };
  }

  private readLocalPlugin(pluginRoot: string): NormalizedPlugin {
    const root = resolve(pluginRoot);
    if (!existsSync(root)) {
      throw new PluginMarketError("source_not_found", "插件目录不存在");
    }
    try {
      return normalizePluginManifests({
        pluginRoot: root,
        lumeManifest: readJsonIfExists(join(root, "lume-plugin.json")),
        codexManifest: readJsonIfExists(join(root, ".codex-plugin", "plugin.json")),
        legacyManifest: readJsonIfExists(join(root, "plugin.json")),
      });
    } catch (error) {
      throw new PluginMarketError("invalid_manifest", error instanceof Error ? error.message : String(error));
    }
  }

  private async inspectGitHubPlugin(source: Extract<PluginSourceRef, { type: "github" }>): Promise<NormalizedPlugin> {
    const tree = await this.fetchGitHubTree(source);
    const manifestPath = resolveGitHubManifestPath(tree, source.subdir);
    const raw = await this.fetchText(rawGitHubUrl(source, manifestPath));
    try {
      return normalizePluginManifests({
        pluginRoot: `github:${source.owner}/${source.repo}/${source.ref}${source.subdir ? `/${source.subdir}` : ""}`,
        lumeManifest: JSON.parse(raw) as Record<string, unknown>,
      });
    } catch (error) {
      throw new PluginMarketError("invalid_manifest", error instanceof Error ? error.message : String(error));
    }
  }

  private async fetchGitHubTree(source: Extract<PluginSourceRef, { type: "github" }>): Promise<GitHubTreeEntry[]> {
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" } },
    );
    if (!response.ok) {
      throw new PluginMarketError("network_failed", `读取 GitHub 仓库树失败: ${response.status}`);
    }
    const payload = await response.json() as { tree?: GitHubTreeEntry[] };
    return payload.tree ?? [];
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: { Accept: "text/plain", "User-Agent": "Lume-Plugin-Market" } });
    if (!response.ok) {
      throw new PluginMarketError("network_failed", `读取远程文件失败: ${response.status}`);
    }
    return response.text();
  }

  private async resolveInspectSource(source: InspectMarketSourceRef): Promise<PluginSourceRef> {
    if (source.type === "subscribed-market") return source.resolved;
    if (source.type !== "market-item") return source;
    const entries = await this.readMarketIndex(source.sourceId);
    const item = entries.find((entry) => entry.id === source.itemId);
    if (!item) {
      throw new PluginMarketError("source_not_found", "未找到市场条目");
    }
    return item.source;
  }

  private async readMarketIndex(sourceId: string): Promise<MarketIndexPluginEntry[]> {
    const source = getEffectivePluginRuntimeConfig().marketSources.find((item) => item.id === sourceId);
    if (!source) {
      throw new PluginMarketError("source_not_found", "未找到市场源");
    }
    const raw = source.kind === "local-index"
      ? readFileSync(source.path ?? "", "utf-8")
      : await this.fetchText(source.url ?? "");
    const parsed = JSON.parse(raw) as { items?: Array<Record<string, unknown>> };
    return (parsed.items ?? []).flatMap((item) => {
      if (item.kind !== "plugin" || typeof item.id !== "string" || !isPluginSourceRef(item.source)) {
        return [];
      }
      return [{ kind: "plugin" as const, id: item.id, name: typeof item.name === "string" ? item.name : undefined, source: item.source }];
    });
  }

  private async stageInstall(source: PluginSourceRef, plugin: NormalizedPlugin): Promise<string> {
    const target = join(this.config.installedRoot, plugin.pluginId, plugin.version);
    const stage = join(this.config.installedRoot, plugin.pluginId, `.tmp-${plugin.version}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await rm(stage, { recursive: true, force: true });
    await mkdir(dirname(stage), { recursive: true });
    try {
      if (source.type === "github") {
        await this.stageGitHubTarball(source, stage);
      } else if (source.type === "local" || source.type === "legacy") {
        await cp(source.path, stage, { recursive: true });
      }
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await rename(stage, target);
      return target;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  private async stageGitHubTarball(source: Extract<PluginSourceRef, { type: "github" }>, stage: string): Promise<void> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(source.ref)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" },
    });
    if (!response.ok) {
      throw new PluginMarketError("install_failed", `下载 GitHub tarball 失败: ${response.status}`);
    }
    await mkdir(stage, { recursive: true });
    const archive = join(stage, "source.tar.gz");
    const arrayBuffer = await response.arrayBuffer();
    await writeFile(archive, new Uint8Array(arrayBuffer));
    await execFileAsync("tar", ["-xzf", archive, "-C", stage, "--strip-components=1"]);
    await rm(archive, { force: true });
    if (source.subdir) {
      const nested = join(stage, source.subdir);
      const temp = `${stage}-subdir`;
      await rename(nested, temp);
      await rm(stage, { recursive: true, force: true });
      await rename(temp, stage);
    }
  }

  private async recordInstalledPlugin(input: {
    plugin: NormalizedPlugin;
    source: PluginSourceRef;
    installedRoot: string;
    permissionsHash: string;
  }): Promise<void> {
    const stateStore = this.stateStore();
    const state = await stateStore.read();
    const record = state.plugins[input.plugin.pluginId] ?? createInstallRecord(input.plugin.pluginId);
    const now = new Date().toISOString();
    record.activeVersion = input.plugin.version;
    record.versions[input.plugin.version] = {
      pluginId: input.plugin.pluginId,
      version: input.plugin.version,
      source: input.source,
      installedRoot: input.installedRoot,
      installedAt: now,
      trustedAt: now,
      permissionsAcceptedAt: now,
      permissionsHash: input.permissionsHash,
      sensitiveApprovals: [],
    };
    record.approvalsByHash[input.permissionsHash] ??= {
      permissionsHash: input.permissionsHash,
      permissionsAcceptedAt: now,
      sensitiveApprovals: [],
    };
    state.plugins[input.plugin.pluginId] = record;
    await stateStore.write(state);
  }

  private async resolveInstallState(plugin: NormalizedPlugin): Promise<"not-installed" | "installed" | "update-available"> {
    const state = await this.stateStore().read();
    const record = state.plugins[plugin.pluginId];
    if (!record?.activeVersion) return "not-installed";
    if (record.activeVersion === plugin.version) return "installed";
    return "update-available";
  }

  private resolveEnableState(pluginId: string, workspaceSlug?: string): PluginEnableState {
    const runtime = getEffectivePluginRuntimeConfig(workspaceSlug);
    if (!runtime.enabled.includes(pluginId)) return "disabled";
    const config = getEffectiveLumeConfig();
    if (workspaceSlug && config.plugins?.workspaces?.[workspaceSlug]?.enabled?.includes(pluginId)) {
      return "workspace-enabled";
    }
    return "global-enabled";
  }

  private findEnabledScopes(pluginId: string): Array<{ scope: "global" | "workspace"; workspaceSlug?: string }> {
    const config = getEffectiveLumeConfig();
    const result: Array<{ scope: "global" | "workspace"; workspaceSlug?: string }> = [];
    if (config.plugins?.global?.enabled?.includes(pluginId)) {
      result.push({ scope: "global" });
    }
    for (const [workspaceSlug, enablement] of Object.entries(config.plugins?.workspaces ?? {})) {
      if (enablement.enabled?.includes(pluginId)) {
        result.push({ scope: "workspace", workspaceSlug });
      }
    }
    return result;
  }

  private toMarketItem(
    plugin: NormalizedPlugin,
    workspaceSlug: string,
    sourceType: PluginSourceRef["type"],
    installState: PluginMarketItem["installState"] = "not-installed",
  ): PluginMarketItem {
    return {
      id: `${sourceType}:inline:plugin:${plugin.pluginId}`,
      pluginId: plugin.pluginId,
      name: plugin.name,
      displayName: plugin.displayName,
      description: plugin.description,
      version: plugin.version,
      sourceType,
      trustLevel: sourceType === "local" || sourceType === "legacy" ? "trusted" : "review-required",
      installState,
      enableState: this.resolveEnableState(plugin.pluginId, workspaceSlug),
      capabilities: summarizeCapabilities(plugin),
      permissions: summarizePermissions(plugin.permissions),
      diagnostics: plugin.diagnostics as AgentPluginDiagnostic[],
    };
  }

  private stateStore(): FilePluginStateStore {
    return new FilePluginStateStore(this.config.statePath);
  }
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function createInstallRecord(pluginId: string): PluginInstallRecord {
  return {
    pluginId,
    versions: {},
    approvalsByHash: {},
  };
}

function summarizeCapabilities(plugin: NormalizedPlugin): PluginCapabilitySummary {
  return {
    skillCount: plugin.capabilities.skills.length,
    hookEvents: plugin.permissions.hooks?.events ?? [],
    mcpServerNames: plugin.capabilities.mcpServersConfigPath ? [plugin.capabilities.mcpServersConfigPath] : [],
    commandToolNames: plugin.capabilities.commandTools.map((tool) => tool.name),
  };
}

function summarizePermissions(permissions: PluginPermissions): PluginPermissionSummary {
  const read = permissions.filesystem?.read ?? [];
  const write = permissions.filesystem?.write ?? [];
  const network = permissions.network?.outbound ?? [];
  const mcpRegister = permissions.mcpServers?.register === true;
  const shellAllow = permissions.shell?.allow === true;
  const toolAllow = permissions.tools?.allow ?? [];
  const toolAsk = permissions.tools?.ask ?? [];
  const toolDeny = permissions.tools?.deny ?? [];
  const hookEvents = permissions.hooks?.events ?? [];
  const riskLabels: PluginPermissionSummary["riskLabels"] = [];
  if (shellAllow) riskLabels.push("shell");
  if (network.length > 0) riskLabels.push("network");
  if (write.length > 0) riskLabels.push("write");
  if (mcpRegister) riskLabels.push("mcp");
  if ([...toolAllow, ...toolAsk].some((tool) => ["Bash", "FileWrite", "FileEdit", "NotebookEdit", "AgentTool", "SendMessage"].includes(tool))) {
    riskLabels.push("high-risk-tool");
  }
  return {
    filesystemRead: read,
    filesystemWrite: write,
    networkOutbound: network,
    mcpRegister,
    shellAllow,
    toolAllow,
    toolAsk,
    toolDeny,
    hookEvents,
    riskLabels,
  };
}

function resolveGitHubManifestPath(tree: GitHubTreeEntry[], subdir?: string): string {
  const prefix = subdir ? `${subdir.replace(/\/$/, "")}/` : "";
  const path = `${prefix}lume-plugin.json`;
  if (!tree.some((entry) => entry.type === "blob" && entry.path === path)) {
    throw new PluginMarketError("invalid_manifest", "GitHub 仓库中没有检测到 lume-plugin.json");
  }
  return path;
}

function rawGitHubUrl(source: Extract<PluginSourceRef, { type: "github" }>, path: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${path}`;
}

function isPluginSourceRef(value: unknown): value is PluginSourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.type === "local" || source.type === "legacy") return typeof source.path === "string";
  if (source.type === "github") {
    return typeof source.owner === "string" && typeof source.repo === "string" && typeof source.ref === "string" && typeof source.url === "string";
  }
  if (source.type === "subscribed-market") {
    return typeof source.sourceId === "string" && typeof source.itemId === "string" && isPluginSourceRef(source.resolved);
  }
  return false;
}

function parseMarketItemId(itemId: string): InspectMarketSourceRef {
  const [sourceId, ...rest] = itemId.split(":");
  if (sourceId && rest.length > 0) {
    return { type: "market-item", sourceId, itemId: rest.join(":") };
  }
  return { type: "market-item", sourceId: "inline", itemId };
}
