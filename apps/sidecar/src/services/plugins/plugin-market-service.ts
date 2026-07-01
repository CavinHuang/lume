import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
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
  MarketplaceManifest,
  PluginCapabilitySummary,
  PluginEnableState,
  PluginMarketItem,
  PluginPermissionSummary,
  PluginSourceRef,
  SetPluginEnablementInput,
  SetPluginEnablementResult,
  SkillCatalogItem,
  SkillMarketSourceRef,
  UninstallPluginInput,
  UninstallPluginResult,
  UpdatePluginInput,
  UpdatePluginResult,
} from "@lume/shared";
import { getGitHubSkillReview, installGitHubSkillToWorkspace } from "../skills/github-skill-install-service";
import { getSkillMarketCatalog, getSkillMarketDetail, importLocalSkillDirectoryToWorkspace, installSkillMarketItemToWorkspace } from "../skills/skills-market-service";
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
  description?: string;
  version?: string;
  source: PluginSourceRef;
}

interface MarketIndexSkillEntry {
  kind: "skill";
  id: string;
  name: string;
  description?: string;
  version?: string;
  source: SkillMarketSourceRef;
}

type MarketIndexEntry = MarketIndexPluginEntry | MarketIndexSkillEntry;

interface GitHubTreeEntry {
  path: string;
  type: string;
}

interface GitHubRepoRoot {
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
  url: string;
}

interface GitHubManifestMatch {
  path: string;
  format: "lume" | "codex" | "legacy";
}

const MARKETPLACE_MANIFEST_PATH = ".lume-plugin/marketplace.json";

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
    const skillsById = new Map<string, SkillCatalogItem>(skills.map((skill) => [skill.id, skill]));
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
      byId.set(plugin.pluginId, this.toMarketItem(plugin, input.workspaceSlug, "local", "installed"));
    }

    for (const source of runtimeConfig.marketSources) {
      try {
        const entries = await this.readMarketIndex(source.id);
        for (const entry of entries) {
          if (entry.kind === "skill") {
            const skill = this.toMarketSkillItem(source.id, entry, input.workspaceSlug, skills);
            skillsById.set(skill.id, skill);
            continue;
          }
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
      skills: [...skillsById.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
      diagnostics,
    };
  }

  async inspectMarketSource(input: InspectMarketSourceInput): Promise<SidecarInspectPluginResult> {
    const source = await this.resolveInspectSource(input.source);
    return this.inspectPluginSource(input.workspaceSlug, source);
  }

  async getMarketDetail(input: GetMarketDetailInput): Promise<GetMarketDetailResult> {
    if (input.kind === "skill") {
      const marketSkill = await this.resolveMarketSkill(input.itemId).catch(() => null);
      if (marketSkill) {
        const catalog = getSkillMarketCatalog({ workspaceSlug: input.workspaceSlug, includeBlockedSources: true }).items;
        const item = this.toMarketSkillItem(marketSkill.sourceId, marketSkill.entry, input.workspaceSlug, catalog);
        return {
          item: { kind: "skill", skill: item },
          inspect: { kind: "skill", item },
          diagnostics: [],
        };
      }
      const detail = getSkillMarketDetail({ workspaceSlug: input.workspaceSlug, skillSlug: input.itemId });
      return {
        item: { kind: "skill", skill: detail.item },
        inspect: { kind: "skill", item: detail.item, fileTree: detail.files },
        diagnostics: [],
      };
    }

    const source = await this.resolveInspectSource(parseMarketItemId(input.itemId));
    const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
    const item = this.toMarketItem(inspected.normalized, input.workspaceSlug, source.type);
    item.id = input.itemId;
    return {
      item: { kind: "plugin", plugin: item },
      inspect: inspected,
      diagnostics: inspected.diagnostics,
    };
  }

  async installMarketItem(input: InstallMarketItemInput): Promise<InstallMarketItemResult> {
    if (input.kind === "skill") {
      const source = input.source
        ? await this.resolveSkillSource(input.source)
        : input.itemId
          ? await this.resolveSkillSource(parseMarketItemId(input.itemId)).catch(() => null)
          : null;

      if (source) {
        const result = await this.installSkillSource(input.workspaceSlug, source, input.overwrite);
        return { kind: "skill", id: input.itemId ?? source.type, installed: result.imported };
      }

      if (!input.itemId) {
        throw new PluginMarketError("source_not_found", "skill install requires itemId or source");
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
        lumeManifest: readJsonIfExists(join(root, ".lume-plugin", "plugin.json")) ?? readJsonIfExists(join(root, "lume-plugin.json")),
        codexManifest: readJsonIfExists(join(root, ".codex-plugin", "plugin.json")),
        legacyManifest: readJsonIfExists(join(root, "plugin.json")),
      });
    } catch (error) {
      throw new PluginMarketError("invalid_manifest", error instanceof Error ? error.message : String(error));
    }
  }

  private async inspectGitHubPlugin(source: Extract<PluginSourceRef, { type: "github" }>): Promise<NormalizedPlugin> {
    const tree = await this.fetchGitHubTree(source);
    const manifest = resolveGitHubManifestPath(tree, source.subdir);
    const raw = await this.fetchText(rawGitHubUrl(source, manifest.path));
    try {
      return normalizePluginManifests({
        pluginRoot: `github:${source.owner}/${source.repo}/${source.ref}${source.subdir ? `/${source.subdir}` : ""}`,
        lumeManifest: manifest.format === "lume" ? JSON.parse(raw) as Record<string, unknown> : undefined,
        codexManifest: manifest.format === "codex" ? JSON.parse(raw) as Record<string, unknown> : undefined,
        legacyManifest: manifest.format === "legacy" ? JSON.parse(raw) as Record<string, unknown> : undefined,
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
    if (isPluginSourceRef(source)) return source;
    if (source.type !== "market-item") {
      throw new PluginMarketError("source_not_found", "该来源是 Skill，不是插件");
    }
    const entries = await this.readMarketIndex(source.sourceId);
    const item = entries.find((entry): entry is MarketIndexPluginEntry => entry.kind === "plugin" && entry.id === source.itemId);
    if (!item) {
      throw new PluginMarketError("source_not_found", "未找到市场条目");
    }
    return item.source;
  }

  private async resolveSkillSource(source: InspectMarketSourceRef): Promise<SkillMarketSourceRef> {
    if (isSkillMarketSourceRef(source)) return source;
    if (source.type !== "market-item") {
      throw new PluginMarketError("source_not_found", "该来源不是 Skill");
    }
    const entries = await this.readMarketIndex(source.sourceId);
    const item = entries.find((entry): entry is MarketIndexSkillEntry => entry.kind === "skill" && entry.id === source.itemId);
    if (!item) {
      throw new PluginMarketError("source_not_found", "未找到 Skill 市场条目");
    }
    return item.source;
  }

  private async resolveMarketSkill(itemId: string): Promise<{ sourceId: string; entry: MarketIndexSkillEntry }> {
    const parsed = parseMarketItemId(itemId);
    if (parsed.type !== "market-item") {
      throw new PluginMarketError("source_not_found", "无效市场条目");
    }
    const entries = await this.readMarketIndex(parsed.sourceId);
    const entry = entries.find((candidate): candidate is MarketIndexSkillEntry => candidate.kind === "skill" && candidate.id === parsed.itemId);
    if (!entry) {
      throw new PluginMarketError("source_not_found", "未找到 Skill 市场条目");
    }
    return { sourceId: parsed.sourceId, entry };
  }

  private async readMarketIndex(sourceId: string): Promise<MarketIndexEntry[]> {
    const source = getEffectivePluginRuntimeConfig().marketSources.find((item) => item.id === sourceId);
    if (!source) {
      throw new PluginMarketError("source_not_found", "未找到市场源");
    }
    if (source.kind === "local-index") {
      return this.readLocalMarketIndex(source.path ?? "");
    }
    return this.readRemoteMarketIndex(source.url ?? "");
  }

  private readLocalMarketIndex(sourcePath: string): MarketIndexEntry[] {
    if (!sourcePath) {
      throw new PluginMarketError("source_not_found", "市场源路径为空");
    }
    const resolvedPath = resolve(sourcePath);
    const manifestPath = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()
      ? join(resolvedPath, MARKETPLACE_MANIFEST_PATH)
      : resolvedPath;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    if (Array.isArray(parsed.items)) {
      return readLegacyIndexEntries(parsed.items);
    }
    const root = dirname(dirname(manifestPath));
    return this.readMarketplaceManifest(parsed as unknown as MarketplaceManifest, {
      pluginSource: (entrySource) => ({ type: "local", path: resolve(root, assertRelativeMarketplaceSource(entrySource)) }),
      skillSource: (entrySource) => ({ type: "skill-local", path: resolve(root, assertRelativeMarketplaceSource(entrySource)) }),
    });
  }

  private async readRemoteMarketIndex(sourceUrl: string): Promise<MarketIndexEntry[]> {
    if (!sourceUrl) {
      throw new PluginMarketError("source_not_found", "市场源 URL 为空");
    }
    if (/\.json(?:$|[?#])/i.test(sourceUrl)) {
      const parsed = JSON.parse(await this.fetchText(sourceUrl)) as Record<string, unknown>;
      if (Array.isArray(parsed.items)) {
        return readLegacyIndexEntries(parsed.items);
      }
    }

    const root = await this.resolveGitHubRoot(sourceUrl);
    const raw = await this.fetchText(rawGitHubUrl({
      type: "github",
      owner: root.owner,
      repo: root.repo,
      ref: root.ref,
      url: root.url,
      subdir: root.rootPath,
    }, joinPosix(root.rootPath, MARKETPLACE_MANIFEST_PATH)));
    const parsed = JSON.parse(raw) as MarketplaceManifest;
    return this.readMarketplaceManifest(parsed, {
      pluginSource: (entrySource) => ({
        type: "github",
        owner: root.owner,
        repo: root.repo,
        ref: root.ref,
        url: root.url,
        subdir: joinPosix(root.rootPath, assertRelativeMarketplaceSource(entrySource)),
      }),
      skillSource: (entrySource) => ({
        type: "skill-github",
        url: githubTreeUrl(root, assertRelativeMarketplaceSource(entrySource)),
      }),
    });
  }

  private readMarketplaceManifest(
    manifest: MarketplaceManifest,
    resolveSource: {
      pluginSource: (entrySource: string) => PluginSourceRef;
      skillSource: (entrySource: string) => SkillMarketSourceRef;
    },
  ): MarketIndexEntry[] {
    const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
    const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
    if (plugins.length === 0 && skills.length === 0) {
      throw new PluginMarketError("invalid_manifest", "marketplace.json 必须包含 plugins[] 或 skills[]");
    }

    return [
      ...plugins.flatMap((entry) => {
        if (!isMarketplaceEntry(entry)) return [];
        const id = marketplaceEntryId(entry);
        return [{
          kind: "plugin" as const,
          id,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          source: resolveSource.pluginSource(entry.source),
        }];
      }),
      ...skills.flatMap((entry) => {
        if (!isMarketplaceEntry(entry)) return [];
        const id = marketplaceEntryId(entry);
        return [{
          kind: "skill" as const,
          id,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          source: resolveSource.skillSource(entry.source),
        }];
      }),
    ];
  }

  private async resolveGitHubRoot(url: string): Promise<GitHubRepoRoot> {
    const parsed = parseGitHubRootUrl(url);
    if (parsed.ref) return parsed;

    const response = await this.fetchImpl(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" },
    });
    if (!response.ok) {
      throw new PluginMarketError("network_failed", `读取 GitHub 仓库信息失败: ${response.status}`);
    }
    const payload = await response.json() as { default_branch?: string };
    return { ...parsed, ref: payload.default_branch ?? "main" };
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

  private async installSkillSource(
    workspaceSlug: string,
    source: SkillMarketSourceRef,
    overwrite?: boolean,
  ): Promise<{ imported: boolean }> {
    if (source.type === "skill-local") {
      return importLocalSkillDirectoryToWorkspace({
        workspaceSlug,
        localPath: source.path,
        overwrite,
      });
    }

    const review = await getGitHubSkillReview({ url: source.url }, { fetchImpl: this.fetchImpl });
    const result = await installGitHubSkillToWorkspace({
      workspaceSlug,
      url: review.url,
      reviewToken: review.reviewToken,
      overwrite,
    }, { fetchImpl: this.fetchImpl });
    return { imported: result.imported };
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

  private toMarketSkillItem(
    sourceId: string,
    entry: MarketIndexSkillEntry,
    workspaceSlug: string,
    existingSkills: SkillCatalogItem[],
  ): SkillCatalogItem {
    const installed = existingSkills.find((skill) => skill.slug === entry.id && skill.installState === "installed");
    return {
      id: `${sourceId}:${entry.id}`,
      sourceId: `${sourceId}:${entry.id}`,
      slug: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      sourceType: "subscribed-market",
      trustLevel: entry.source.type === "skill-local" ? "trusted" : "review-required",
      installState: installed ? "installed" : "not-installed",
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

function readLegacyIndexEntries(items: Array<Record<string, unknown>>): MarketIndexEntry[] {
  return items.flatMap((item) => {
    if (item.kind !== "plugin" || typeof item.id !== "string" || !isPluginSourceRef(item.source)) {
      return [];
    }
    return [{
      kind: "plugin" as const,
      id: item.id,
      name: typeof item.name === "string" ? item.name : undefined,
      source: item.source,
    }];
  });
}

function isMarketplaceEntry(value: unknown): value is { name: string; description?: string; version?: string; source: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" && entry.name.trim().length > 0
    && typeof entry.source === "string" && entry.source.trim().length > 0;
}

function marketplaceEntryId(entry: { name: string; source: string }): string {
  return slugifyMarketplaceId(entry.name) || slugifyMarketplaceId(basename(entry.source)) || "item";
}

function slugifyMarketplaceId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function assertRelativeMarketplaceSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed || trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed)) {
    throw new PluginMarketError("invalid_manifest", "marketplace source 必须是相对目录路径");
  }
  return trimmed;
}

function joinPosix(...segments: Array<string | undefined>): string {
  const filtered = segments
    .filter((segment): segment is string => !!segment && segment !== ".")
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""));
  return posix.normalize(filtered.join("/") || "").replace(/^\.$/, "");
}

function parseGitHubRootUrl(input: string): GitHubRepoRoot {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PluginMarketError("source_not_found", "GitHub URL 非法");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new PluginMarketError("source_not_found", "远程市场源仅支持 github.com");
  }
  const segments = url.pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!owner || !repo) {
    throw new PluginMarketError("source_not_found", "GitHub URL 缺少 owner/repo");
  }
  if (segments[2] === "tree") {
    const ref = segments[3];
    if (!ref) {
      throw new PluginMarketError("source_not_found", "GitHub tree URL 缺少 ref");
    }
    return {
      owner,
      repo,
      ref,
      rootPath: segments.slice(4).join("/"),
      url: input,
    };
  }
  return { owner, repo, ref: "", rootPath: "", url: input };
}

function githubTreeUrl(root: GitHubRepoRoot, source: string): string {
  const subdir = joinPosix(root.rootPath, source);
  return `https://github.com/${root.owner}/${root.repo}/tree/${root.ref}${subdir ? `/${subdir}` : ""}`;
}

function resolveGitHubManifestPath(tree: GitHubTreeEntry[], subdir?: string): GitHubManifestMatch {
  const prefix = subdir ? `${subdir.replace(/\/$/, "")}/` : "";
  const candidates: GitHubManifestMatch[] = [
    { path: `${prefix}.lume-plugin/plugin.json`, format: "lume" },
    { path: `${prefix}lume-plugin.json`, format: "lume" },
    { path: `${prefix}.codex-plugin/plugin.json`, format: "codex" },
    { path: `${prefix}plugin.json`, format: "legacy" },
  ];
  const match = candidates.find((candidate) => tree.some((entry) => entry.type === "blob" && entry.path === candidate.path));
  if (!match) {
    throw new PluginMarketError("invalid_manifest", "GitHub 仓库中没有检测到 .lume-plugin/plugin.json 或 .codex-plugin/plugin.json");
  }
  return match;
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

function isSkillMarketSourceRef(value: unknown): value is SkillMarketSourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (source.type === "skill-local") return typeof source.path === "string";
  if (source.type === "skill-github") return typeof source.url === "string";
  return false;
}

function parseMarketItemId(itemId: string): InspectMarketSourceRef {
  const [sourceId, ...rest] = itemId.split(":");
  if (sourceId && rest.length > 0) {
    return { type: "market-item", sourceId, itemId: rest.join(":") };
  }
  return { type: "market-item", sourceId: "inline", itemId };
}
