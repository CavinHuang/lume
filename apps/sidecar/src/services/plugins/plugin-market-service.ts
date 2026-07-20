import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { cp, mkdir, open, readdir as readdirAsync, rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  computePermissionsHash,
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginPermissions,
  type SensitiveApprovalRecord
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
  PluginMarketplaceAsset,
  PluginMarketplaceMetadata,
  PluginPermissionSummary,
  PluginReadmePreview,
  PluginSourceRef,
  FinalizePluginPackageInput,
  PreparePluginPackageInput,
  PreparePluginPackageResult,
  RevokePluginPackageInput,
  SetPluginEnablementInput,
  SetPluginEnablementResult,
  SkillCatalogItem,
  SkillMarketSourceRef,
  UninstallPluginInput,
  UninstallPluginResult,
  UpdatePluginInput,
  UpdatePluginResult,
} from "@lume/shared";
import { parseMcpImportPayload } from "@lume/shared";
import { getGitHubSkillReview, installGitHubSkillToWorkspace } from "../skills/github-skill-install-service";
import { getSkillMarketCatalog, getSkillMarketDetail, importLocalSkillDirectoryToWorkspace, installSkillMarketItemToWorkspace } from "../skills/skills-market-service";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig, updateLumeConfigSection } from "../system/lume-config-service";
import { FilePluginStateStore, type PluginInstallRecord } from "../agent-runtime/plugins/plugin-state-store";
import { PluginRegistry } from "../agent-runtime/plugins/plugin-registry";
import { getPluginPackageService } from "./plugin-package-service";

const execFileAsync = promisify(execFile);
const README_MAX_BYTES = 256 * 1024;
const MARKETPLACE_ASSET_MAX_BYTES = 512 * 1024;
const GITHUB_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const MARKETPLACE_IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const REMOTE_MARKET_TTL_MS = 30 * 60 * 1000;
const remoteRefreshes = new Map<string, Promise<MarketIndexEntry[]>>();
interface CatalogPluginLease {
  workspaceSlug: string;
  source: PluginSourceRef;
  fingerprint: string;
  origin:
    | { kind: "installed"; pluginId: string }
    | { kind: "market"; sourceId: string; itemId: string };
  official: boolean;
  expiresAt: number;
}
const catalogPluginLeases = new Map<string, CatalogPluginLease>();

export function clearPluginMarketInMemoryCatalogLeasesForTest(): void {
  catalogPluginLeases.clear();
}

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
  snapshotPlugin?: NormalizedPlugin;
  snapshotIconUrl?: string;
}

interface MarketIndexReadResult {
  entries: MarketIndexEntry[];
  stale: boolean;
  syncedAt: number;
  expiresAt: number;
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
    this.pruneCatalogLeases();
    const skills = getSkillMarketCatalog(input).items;
    const skillsById = new Map<string, SkillCatalogItem>(skills.map((skill) => [skill.id, skill]));
    const diagnostics: AgentPluginDiagnostic[] = [];
    const byId = new Map<string, PluginMarketItem>();
    const sourceDiagnostics: NonNullable<GetMarketCatalogResult["sourceDiagnostics"]> = [];
    let staleCount = 0;
    let freshCount = 0;
    let failedCount = 0;
    const syncTimes: number[] = [];
    const expiryTimes: number[] = [];

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
      const item = this.toMarketItem(plugin, input.workspaceSlug, "local", "installed");
      item.id = `installed:${plugin.pluginId}`;
      const source = { type: "local" as const, path: plugin.root };
      const fingerprint = pluginSnapshotFingerprint(source, plugin);
      item.catalogItemKey = catalogItemKey({
        workspaceSlug: input.workspaceSlug,
        origin: { kind: "installed", pluginId: plugin.pluginId },
        source,
        fingerprint,
      });
      await this.storeCatalogLease(item.catalogItemKey, {
        workspaceSlug: input.workspaceSlug,
        source,
        fingerprint,
        origin: { kind: "installed", pluginId: plugin.pluginId },
        official: false,
        expiresAt: Date.now() + REMOTE_MARKET_TTL_MS,
      });
      byId.set(plugin.pluginId, item);
    }

    for (const source of runtimeConfig.marketSources) {
      try {
        const indexed = await this.readMarketIndex(source.id, input.cacheMode ?? "cache-first");
        const entries = indexed.entries;
        syncTimes.push(indexed.syncedAt);
        expiryTimes.push(indexed.expiresAt);
        if (indexed.stale) staleCount++; else freshCount++;
        sourceDiagnostics.push({ sourceId: source.id, status: indexed.stale ? "stale" : "fresh" });
        for (const entry of entries) {
          if (entry.kind === "skill") {
            const skill = this.toMarketSkillItem(source.id, entry, input.workspaceSlug, skills);
            skillsById.set(skill.id, skill);
            continue;
          }
          try {
            const normalized = entry.snapshotPlugin ?? (await this.inspectPluginSource(input.workspaceSlug, entry.source)).normalized;
            const item = this.toMarketItem(
              normalized,
              input.workspaceSlug,
              entry.source.type,
              await this.resolveInstallState(normalized),
            );
            item.id = `${source.id}:${entry.id}`;
            const fingerprint = pluginSnapshotFingerprint(entry.source, normalized);
            item.catalogItemKey = catalogItemKey({
              workspaceSlug: input.workspaceSlug,
              origin: { kind: "market", sourceId: source.id, itemId: entry.id },
              source: entry.source,
              fingerprint,
            });
            if (entry.snapshotIconUrl && item.marketplace?.icon) item.marketplace.icon.url = entry.snapshotIconUrl;
            await this.storeCatalogLease(item.catalogItemKey, {
              workspaceSlug: input.workspaceSlug,
              source: entry.source,
              fingerprint,
              origin: { kind: "market", sourceId: source.id, itemId: entry.id },
              official: source.id === "official" && source.url === "https://github.com/CavinHuang/lume-plugins",
              expiresAt: Math.max(indexed.expiresAt, Date.now() + REMOTE_MARKET_TTL_MS),
            });
            byId.delete(item.pluginId);
            byId.set(`market:${source.id}:${entry.id}`, item);
          } catch (error) {
            diagnostics.push({
              severity: "warning",
              code: "invalid_manifest",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        failedCount++;
        sourceDiagnostics.push({
          sourceId: source.id,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
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
      status: failedCount > 0 && freshCount + staleCount === 0
        ? "failed"
        : failedCount > 0 && staleCount > 0 && freshCount === 0
          ? "failed-with-stale"
          : failedCount > 0 || (staleCount > 0 && freshCount > 0)
            ? "partial"
            : staleCount > 0 ? "stale" : "fresh",
      refreshRecommended: staleCount > 0 || failedCount > 0,
      fromStaleCache: staleCount > 0,
      sourceDiagnostics,
      ...(syncTimes.length > 0 ? { syncedAt: new Date(Math.min(...syncTimes)).toISOString() } : {}),
      ...(expiryTimes.length > 0 ? { expiresAt: new Date(Math.min(...expiryTimes)).toISOString() } : {}),
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

    const source = input.itemId.startsWith("installed:")
      ? await this.resolveInstalledPluginSource(input.itemId.slice("installed:".length), input.workspaceSlug)
      : await this.resolveInspectSource(parseMarketItemId(input.itemId));
    const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
    const item = this.toMarketItem(inspected.normalized, input.workspaceSlug, source.type, inspected.installState);
    const readme = await this.readPluginReadme(source);
    item.id = input.itemId;
    return {
      item: { kind: "plugin", plugin: item },
      inspect: inspected,
      diagnostics: inspected.diagnostics,
      ...(readme ? { readme } : {}),
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
        workspaceSlug: input.workspaceSlug,
        enableScope: input.enableScope,
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
    const state = await this.stateStore().read();
    const record = state.plugins[input.pluginId];
    const previousActiveVersion = record?.activeVersion;
    const activeInstalled = previousActiveVersion ? record?.versions[previousActiveVersion] : undefined;
    if (!record || !previousActiveVersion || !activeInstalled) {
      throw new PluginMarketError("not_installed", "插件未安装");
    }
    const source = input.source ?? activeInstalled.source as PluginSourceRef | undefined;
    if (!source) throw new PluginMarketError("source_not_found", "找不到插件来源");
    const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
    if (inspected.normalized.pluginId !== input.pluginId) {
      throw new PluginMarketError("invalid_manifest", "插件来源与已安装插件不匹配", inspected.diagnostics);
    }
    if (input.targetVersion && inspected.normalized.version !== input.targetVersion) {
      throw new PluginMarketError("invalid_manifest", "插件来源版本与目标版本不匹配", inspected.diagnostics);
    }
    if (!input.force && compareSemverVersions(inspected.normalized.version, previousActiveVersion) !== 1) {
      throw new PluginMarketError("already_installed", "目标版本不是更高版本", inspected.diagnostics);
    }
    if (activeInstalled.permissionsHash !== inspected.permissionsHash && input.acceptedPermissionsHash !== inspected.permissionsHash) {
      throw new PluginMarketError("permission_review_required", "插件权限已变化,需要确认后更新", inspected.diagnostics);
    }
    const installed = await this.installMarketItem({
      workspaceSlug: input.workspaceSlug,
      kind: "plugin",
      source,
      acceptedPermissionsHash: inspected.permissionsHash,
      enableScope: this.resolveUpdateEnableScope(input.pluginId, input.workspaceSlug),
      overwrite: true,
    });
    const retainedVersions = await this.prunePluginVersions(input.pluginId, previousActiveVersion);
    return {
      pluginId: input.pluginId,
      installedVersion: installed.version ?? "",
      activeVersion: installed.version ?? "",
      previousActiveVersion,
      retainedVersions,
      activated: false,
      needsReview: false,
      diagnostics: installed.diagnostics,
    };
  }

  async preparePluginPackage(input: PreparePluginPackageInput & { ownerWebContentsId: number; ownerGeneration: number }): Promise<PreparePluginPackageResult> {
    this.pruneCatalogLeases();
    const lease = await this.resolveCatalogLease(input.catalogItemKey);
    if (!lease || lease.workspaceSlug !== input.workspaceSlug || lease.expiresAt <= Date.now()) {
      throw new PluginMarketError("source_not_found", "插件目录快照已过期，请刷新市场后重试");
    }
    await this.validateCatalogLease(lease);
    const inspected = await this.inspectPluginSource(input.workspaceSlug, lease.source);
    if (pluginSnapshotFingerprint(lease.source, inspected.normalized) !== lease.fingerprint) {
      throw new PluginMarketError("source_not_found", "插件目录内容已变化，请刷新市场后重试");
    }
    const step = inspected.normalized.marketplace?.setup?.find((candidate) => candidate.id === input.setupStepId);
    if (!step) throw new PluginMarketError("source_not_found", "未找到配套包步骤");
    if (step.build?.command) {
      throw new PluginMarketError("invalid_manifest", "配套包导出不执行 build.command");
    }
    const packages = getPluginPackageService();
    if (step.download) {
      return packages.prepareDownload({
        url: step.download.url,
        filename: step.download.filename,
        expectedSha256: step.download.sha256,
        requireSha256: lease.official,
        ownerWebContentsId: input.ownerWebContentsId,
        ownerGeneration: input.ownerGeneration,
        source: lease.official ? "official-market" : "external-download",
        version: inspected.normalized.version,
      });
    }
    if (!step.artifact?.path) throw new PluginMarketError("invalid_manifest", "配套包必须声明 artifact.path 或 download");
    if (lease.source.type === "local" || lease.source.type === "legacy") {
      return packages.preparePath({
        packageRoot: lease.source.path,
        sourcePath: resolve(lease.source.path, step.artifact.path.replace(/^\.\//, "")),
        suggestedFilename: basename(step.artifact.path),
        ownerWebContentsId: input.ownerWebContentsId,
        ownerGeneration: input.ownerGeneration,
        source: lease.source.type,
        version: inspected.normalized.version,
      });
    }
    if (lease.source.type !== "github") throw new PluginMarketError("source_not_found", "不支持的插件来源");
    const stage = join(homedir(), ".lume", "cache", "plugin-package-sources", randomUUID());
    try {
      await this.stageGitHubTarball(lease.source, stage);
      return await packages.preparePath({
        packageRoot: stage,
        sourcePath: resolve(stage, step.artifact.path.replace(/^\.\//, "")),
        suggestedFilename: basename(step.artifact.path),
        ownerWebContentsId: input.ownerWebContentsId,
        ownerGeneration: input.ownerGeneration,
        source: `github:${lease.source.owner}/${lease.source.repo}@${lease.source.ref}`,
        version: inspected.normalized.version,
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async finalizePluginPackage(input: FinalizePluginPackageInput): Promise<{ savedPath: string }> {
    return getPluginPackageService().finalize(input);
  }

  async revokePluginPackage(input: RevokePluginPackageInput): Promise<void> {
    await getPluginPackageService().revoke(input);
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
    const { raw, format } = await this.fetchGitHubManifest(source);
    try {
      return normalizePluginManifests({
        pluginRoot: `github:${source.owner}/${source.repo}/${source.ref}${source.subdir ? `/${source.subdir}` : ""}`,
        lumeManifest: format === "lume" ? JSON.parse(raw) as Record<string, unknown> : undefined,
        codexManifest: format === "codex" ? JSON.parse(raw) as Record<string, unknown> : undefined,
        legacyManifest: format === "legacy" ? JSON.parse(raw) as Record<string, unknown> : undefined,
      });
    } catch (error) {
      throw new PluginMarketError("invalid_manifest", error instanceof Error ? error.message : String(error));
    }
  }

  private async fetchGitHubManifest(source: Extract<PluginSourceRef, { type: "github" }>): Promise<GitHubManifestMatch & { raw: string }> {
    try {
      const tree = await this.fetchGitHubTree(source);
      const match = resolveGitHubManifestPath(tree, source.subdir);
      return { ...match, raw: await this.fetchText(rawGitHubUrl(source, match.path)) };
    } catch {
      return this.fetchGitHubManifestFromRaw(source);
    }
  }

  private async fetchGitHubManifestFromRaw(source: Extract<PluginSourceRef, { type: "github" }>): Promise<GitHubManifestMatch & { raw: string }> {
    let lastError: unknown;
    for (const match of githubManifestCandidates(source.subdir)) {
      try {
        return { ...match, raw: await this.fetchText(rawGitHubUrl(source, match.path)) };
      } catch (error) {
        lastError = error;
      }
    }

    const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new PluginMarketError("invalid_manifest", `GitHub 仓库中没有检测到 .lume-plugin/plugin.json 或 .codex-plugin/plugin.json${suffix}`);
  }

  private async readPluginReadme(source: PluginSourceRef): Promise<PluginReadmePreview | undefined> {
    try {
      if (source.type === "subscribed-market") {
        return this.readPluginReadme(source.resolved);
      }
      if (source.type === "github") {
        return await this.readGitHubReadme(source);
      }
      return this.readLocalReadme(source.path);
    } catch {
      return undefined;
    }
  }

  private readLocalReadme(pluginRoot: string): PluginReadmePreview | undefined {
    const root = resolve(pluginRoot);
    const readmeName = readdirSync(root).find((entry) => entry.toLowerCase() === "readme.md");
    if (!readmeName) return undefined;
    const readmePath = join(root, readmeName);
    return truncateReadme(readFileSync(readmePath, "utf-8"), readmePath);
  }

  private async readGitHubReadme(source: Extract<PluginSourceRef, { type: "github" }>): Promise<PluginReadmePreview | undefined> {
    const tree = await this.fetchGitHubTree(source);
    const prefix = source.subdir ? `${source.subdir.replace(/\/$/, "")}/` : "";
    const match = tree.find((entry) =>
      entry.type === "blob"
      && entry.path.toLowerCase() === `${prefix}readme.md`.toLowerCase()
    );
    if (!match) return undefined;
    return truncateReadme(await this.fetchText(rawGitHubUrl(source, match.path)), match.path);
  }

  private async requestRemote(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new PluginMarketError("network_failed", error instanceof Error ? error.message : "远程请求失败");
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchGitHubTree(source: Extract<PluginSourceRef, { type: "github" }>): Promise<GitHubTreeEntry[]> {
    const response = await this.requestRemote(
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
    const response = await this.requestRemote(url, { headers: { Accept: "text/plain", "User-Agent": "Lume-Plugin-Market" } });
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
    const entries = (await this.readMarketIndex(source.sourceId)).entries;
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
    const entries = (await this.readMarketIndex(source.sourceId)).entries;
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
    const entries = (await this.readMarketIndex(parsed.sourceId)).entries;
    const entry = entries.find((candidate): candidate is MarketIndexSkillEntry => candidate.kind === "skill" && candidate.id === parsed.itemId);
    if (!entry) {
      throw new PluginMarketError("source_not_found", "未找到 Skill 市场条目");
    }
    return { sourceId: parsed.sourceId, entry };
  }

  private async readMarketIndex(sourceId: string, cacheMode: "cache-first" | "force-refresh" = "cache-first"): Promise<MarketIndexReadResult> {
    const source = getEffectivePluginRuntimeConfig().marketSources.find((item) => item.id === sourceId);
    if (!source) {
      throw new PluginMarketError("source_not_found", "未找到市场源");
    }
    if (source.kind === "local-index") {
      const now = Date.now();
      return { entries: this.readLocalMarketIndex(source.path ?? ""), stale: false, syncedAt: now, expiresAt: now + REMOTE_MARKET_TTL_MS };
    }
    const cachePath = this.remoteMarketCachePath(source.id, source.url ?? "");
    const cached = await this.readRemoteMarketCache(cachePath);
    if (cached && cacheMode !== "force-refresh") {
      const expiresAt = cached.syncedAt + REMOTE_MARKET_TTL_MS;
      const stale = Date.now() >= expiresAt;
      if (stale) void this.refreshRemoteMarketIndex(source.id, source.url ?? "", cachePath).catch(() => undefined);
      return { entries: cached.entries, stale, syncedAt: cached.syncedAt, expiresAt };
    }
    try {
      return await this.refreshRemoteMarketIndex(source.id, source.url ?? "", cachePath);
    } catch (error) {
      if (cached) {
        return {
          entries: cached.entries,
          stale: true,
          syncedAt: cached.syncedAt,
          expiresAt: cached.syncedAt + REMOTE_MARKET_TTL_MS,
        };
      }
      throw error;
    }
  }

  private async resolveInstalledPluginSource(pluginId: string, workspaceSlug: string): Promise<PluginSourceRef> {
    const state = await this.stateStore().read();
    const record = state.plugins[pluginId];
    const active = record?.activeVersion ? record.versions[record.activeVersion] : undefined;
    if (active?.installedRoot) return { type: "local", path: active.installedRoot };
    const runtimeConfig = getEffectivePluginRuntimeConfig(workspaceSlug);
    const listed = await new PluginRegistry({
      installedRoot: this.config.installedRoot,
      legacyGlobalRoot: this.config.legacyGlobalRoot,
      stateStore: this.stateStore(),
    }).list({
      enabled: runtimeConfig.enabled,
      disabled: runtimeConfig.disabled,
      directories: runtimeConfig.directories,
    });
    const plugin = listed.plugins.find((candidate) => candidate.pluginId === pluginId);
    if (!plugin) throw new PluginMarketError("source_not_found", "未找到已安装插件目录");
    return { type: "local", path: plugin.root };
  }

  private async refreshRemoteMarketIndex(sourceId: string, sourceUrl: string, cachePath: string): Promise<MarketIndexReadResult> {
    let refresh = remoteRefreshes.get(sourceId);
    if (!refresh) {
      refresh = this.readRemoteMarketIndex(sourceUrl);
      remoteRefreshes.set(sourceId, refresh);
      void refresh.then(
        () => { if (remoteRefreshes.get(sourceId) === refresh) remoteRefreshes.delete(sourceId); },
        () => { if (remoteRefreshes.get(sourceId) === refresh) remoteRefreshes.delete(sourceId); },
      );
    }
    const entries = await refresh;
    const current = getEffectivePluginRuntimeConfig().marketSources.find((source) => source.id === sourceId);
    if (!current || current.kind !== "remote-index" || current.url !== sourceUrl) {
      throw new PluginMarketError("source_not_found", "市场源已变更，丢弃本次刷新结果");
    }
    const syncedAt = Date.now();
    await withCacheMutationLock(cachePath, async () => {
      await mkdir(dirname(cachePath), { recursive: true });
      const content = JSON.stringify({ syncedAt, entries });
      const contentHash = createHash("sha256").update(content).digest("hex");
      const generation = `${cachePath}.${syncedAt}-${contentHash}-${randomUUID()}`;
      const tempPath = `${generation}.tmp`;
      await writeDurableFile(tempPath, content);
      await rename(tempPath, generation);
      await syncDirectory(dirname(cachePath));
      await writeDurableFile(`${generation}.complete`, JSON.stringify({ schema: 1, sourceId, sourceUrl, contentHash }));
      await syncDirectory(dirname(cachePath));
      await writeDurableFile(`${cachePath}.current`, generation);
      await pruneCacheGenerations(cachePath, generation);
    });
    return { entries, stale: false, syncedAt, expiresAt: syncedAt + REMOTE_MARKET_TTL_MS };
  }

  private remoteMarketCachePath(sourceId: string, sourceUrl: string): string {
    const key = createHash("sha256").update(`${sourceId}\0${sourceUrl}`).digest("hex");
    return join(homedir(), ".lume", "cache", "market-snapshots", "v1", `${key}.json`);
  }

  private async readRemoteMarketCache(path: string): Promise<{ syncedAt: number; entries: MarketIndexEntry[] } | undefined> {
    try {
      const pointer = await readFile(`${path}.current`, "utf8");
      const generation = pointer.trim();
      const pointed = await readValidCacheGeneration(path, generation);
      if (pointed) return pointed;
    } catch { /* recover by scanning immutable generations */ }
    try {
      const directory = dirname(path);
      const prefix = `${basename(path)}.`;
      const generations = (await readdirAsync(directory))
        .filter((name) => name.startsWith(prefix) && !name.endsWith(".complete") && !name.endsWith(".tmp") && name !== `${basename(path)}.current` && name !== `${basename(path)}.lock`)
        .sort((left, right) => right.localeCompare(left));
      for (const name of generations) {
        const recovered = await readValidCacheGeneration(path, join(directory, name));
        if (recovered) return recovered;
      }
    } catch { /* no valid generation */ }
    return undefined;
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
      const remoteJson = new URL(sourceUrl);
      const segments = remoteJson.pathname.split("/").filter(Boolean);
      if (remoteJson.protocol !== "https:" || remoteJson.hostname !== "raw.githubusercontent.com" || remoteJson.username || remoteJson.password || segments.length < 4) {
        throw new PluginMarketError("source_not_found", "远程 JSON 市场源仅支持 raw.githubusercontent.com");
      }
      const [owner, repo, ref, ...path] = segments;
      const commitResponse = await this.requestRemote(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref!)}`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" } },
      );
      if (!commitResponse.ok) throw new PluginMarketError("network_failed", `解析远程 JSON 提交失败: ${commitResponse.status}`);
      const commit = await commitResponse.json() as { sha?: string };
      if (!commit.sha || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new PluginMarketError("invalid_manifest", "远程 JSON 快照缺少有效提交 SHA");
      const pinnedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${path.join("/")}`;
      const parsed = JSON.parse(await this.fetchText(pinnedUrl)) as Record<string, unknown>;
      if (Array.isArray(parsed.items)) {
        return this.hydrateRemotePluginEntries(await this.pinRemotePluginEntries(readLegacyIndexEntries(parsed.items)));
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
    const entries = this.readMarketplaceManifest(parsed, {
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
    return this.hydrateRemotePluginEntries(entries);
  }

  private async pinRemotePluginEntries(entries: MarketIndexEntry[]): Promise<MarketIndexEntry[]> {
    return Promise.all(entries.map(async (entry) => {
      if (entry.kind !== "plugin" || entry.source.type !== "github") return entry;
      const response = await this.requestRemote(
        `https://api.github.com/repos/${entry.source.owner}/${entry.source.repo}/commits/${encodeURIComponent(entry.source.ref || "main")}`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" } },
      );
      if (!response.ok) throw new PluginMarketError("network_failed", `解析 GitHub 提交失败: ${response.status}`);
      const pinned = await response.json() as { sha?: string };
      if (!pinned.sha || !/^[a-f0-9]{40}$/i.test(pinned.sha)) throw new PluginMarketError("invalid_manifest", "GitHub 快照缺少有效提交 SHA");
      return {
        ...entry,
        source: {
          ...entry.source,
          ref: pinned.sha,
        },
      };
    }));
  }

  private async hydrateRemotePluginEntries(entries: MarketIndexEntry[]): Promise<MarketIndexEntry[]> {
    return Promise.all(entries.map(async (entry) => {
      if (entry.kind !== "plugin" || entry.source.type !== "github") return entry;
      const snapshotPlugin = await this.inspectGitHubPlugin(entry.source);
      const snapshotIconUrl = snapshotPlugin.marketplace?.icon
        ? await this.readRemoteMarketplaceAsset(entry.source, snapshotPlugin.marketplace.icon).catch(() => undefined)
        : undefined;
      return { ...entry, snapshotPlugin, ...(snapshotIconUrl ? { snapshotIconUrl } : {}) };
    }));
  }

  private async readRemoteMarketplaceAsset(
    source: Extract<PluginSourceRef, { type: "github" }>,
    packagePath: string,
  ): Promise<string | undefined> {
    const extension = extname(packagePath).toLowerCase();
    if (extension === ".svg") return undefined;
    const mime = MARKETPLACE_IMAGE_MIME_BY_EXT[extension];
    if (!mime) return undefined;
    const path = joinPosix(source.subdir, packagePath);
    const response = await this.requestRemote(rawGitHubUrl(source, path), {
      headers: { Accept: mime, "User-Agent": "Lume-Plugin-Market" },
    });
    if (!response.ok) return undefined;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MARKETPLACE_ASSET_MAX_BYTES) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MARKETPLACE_ASSET_MAX_BYTES || !matchesImageMagic(bytes, extension)) return undefined;
    return `data:${mime};base64,${bytes.toString("base64")}`;
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
    let ref = parsed.ref;
    if (!ref) {
      const response = await this.requestRemote(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" },
      });
      if (!response.ok) throw new PluginMarketError("network_failed", `读取 GitHub 仓库信息失败: ${response.status}`);
      const payload = await response.json() as { default_branch?: string };
      ref = payload.default_branch ?? "main";
    }
    const commitResponse = await this.requestRemote(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(ref)}`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" } },
    );
    if (!commitResponse.ok) throw new PluginMarketError("network_failed", `解析 GitHub 提交失败: ${commitResponse.status}`);
    const commit = await commitResponse.json() as { sha?: string };
    if (!commit.sha || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new PluginMarketError("invalid_manifest", "GitHub 快照缺少有效提交 SHA");
    return { ...parsed, ref: commit.sha };
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
    const response = await this.requestRemote(`https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(source.ref)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Lume-Plugin-Market" },
    });
    if (!response.ok) {
      throw new PluginMarketError("install_failed", `下载 GitHub tarball 失败: ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > GITHUB_ARCHIVE_MAX_BYTES) {
      throw new PluginMarketError("install_failed", "GitHub 源归档超过 512 MB 限制");
    }
    await mkdir(stage, { recursive: true });
    const archive = join(stage, "source.tar.gz");
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > GITHUB_ARCHIVE_MAX_BYTES) {
      throw new PluginMarketError("install_failed", "GitHub 源归档超过 512 MB 限制");
    }
    await writeFile(archive, new Uint8Array(arrayBuffer));
    const listed = await execFileAsync("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 });
    for (const entry of listed.stdout.split(/\r?\n/).filter(Boolean)) {
      const normalized = posix.normalize(entry.replace(/\\/g, "/"));
      if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || /^[a-zA-Z]:/.test(normalized)) {
        throw new PluginMarketError("install_failed", "GitHub 源归档包含越界路径");
      }
    }
    const verbose = await execFileAsync("tar", ["-tvzf", archive], { maxBuffer: 16 * 1024 * 1024 });
    if (verbose.stdout.split(/\r?\n/).some((line) => /^[lh]/.test(line))) {
      throw new PluginMarketError("install_failed", "GitHub 源归档包含链接条目");
    }
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
    workspaceSlug: string;
    enableScope?: InstallMarketItemInput["enableScope"];
  }): Promise<void> {
    const stateStore = this.stateStore();
    const state = await stateStore.read();
    const record = state.plugins[input.plugin.pluginId] ?? createInstallRecord(input.plugin.pluginId);
    const now = new Date().toISOString();
    const sensitiveApprovals = buildMcpServerSensitiveApprovals({
      plugin: input.plugin,
      installedRoot: input.installedRoot,
      permissionsHash: input.permissionsHash,
      workspaceSlug: input.workspaceSlug,
      enableScope: input.enableScope,
      createdAt: now,
    });
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
      sensitiveApprovals,
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
    return compareSemverVersions(plugin.version, record.activeVersion) === 1 ? "update-available" : "installed";
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

  private resolveUpdateEnableScope(pluginId: string, workspaceSlug: string): InstallMarketItemInput["enableScope"] {
    const scopes = this.findEnabledScopes(pluginId);
    if (scopes.some((scope) => scope.scope === "global")) return "global";
    if (scopes.some((scope) => scope.scope === "workspace" && scope.workspaceSlug === workspaceSlug)) return "workspace";
    return "none";
  }

  private async prunePluginVersions(pluginId: string, previousActiveVersion: string): Promise<string[]> {
    const stateStore = this.stateStore();
    const state = await stateStore.read();
    const record = state.plugins[pluginId];
    if (!record?.activeVersion) return [];
    const keep = new Set([record.activeVersion, previousActiveVersion]);
    for (const [version, installed] of Object.entries(record.versions)) {
      if (keep.has(version)) continue;
      if (installed.installedRoot) {
        rmSync(installed.installedRoot, { recursive: true, force: true });
      }
      delete record.versions[version];
    }
    await stateStore.write(state);
    return Object.values(record.versions)
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
      .map((installed) => installed.version);
  }

  private toMarketItem(
    plugin: NormalizedPlugin,
    workspaceSlug: string,
    sourceType: PluginSourceRef["type"],
    installState: PluginMarketItem["installState"] = "not-installed",
  ): PluginMarketItem {
    const installMetadata = this.readInstallMetadata(plugin.pluginId);
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
      ...installMetadata,
      capabilities: summarizeCapabilities(plugin),
      permissions: summarizePermissions(plugin.permissions),
      ...(plugin.marketplace ? { marketplace: summarizePluginMarketplace(plugin.root, plugin.marketplace) } : {}),
      diagnostics: plugin.diagnostics as AgentPluginDiagnostic[],
    };
  }

  private readInstallMetadata(pluginId: string): Pick<PluginMarketItem, "installedVersion" | "rollbackVersion" | "installedPermissionsHash"> {
    try {
      const raw = JSON.parse(readFileSync(this.config.statePath, "utf-8")) as { plugins?: Record<string, PluginInstallRecord> };
      const record = raw.plugins?.[pluginId];
      const active = record?.activeVersion;
      if (!active) return {};
      const versions = Object.values(record.versions ?? {})
        .sort((left, right) => right.installedAt.localeCompare(left.installedAt));
      const rollback = versions.find((version) => version.version !== active)?.version;
      return {
        installedVersion: active,
        ...(rollback ? { rollbackVersion: rollback } : {}),
        ...(record.versions?.[active]?.permissionsHash ? { installedPermissionsHash: record.versions[active].permissionsHash } : {}),
      };
    } catch {
      return {};
    }
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

  private pruneCatalogLeases(): void {
    const now = Date.now();
    for (const [key, lease] of catalogPluginLeases) {
      if (lease.expiresAt <= now) catalogPluginLeases.delete(key);
    }
  }

  private catalogLeasePath(key: string): string {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new PluginMarketError("source_not_found", "插件目录键非法");
    return join(homedir(), ".lume", "cache", "market-catalog-leases", "v1", `${key}.json`);
  }

  private async storeCatalogLease(key: string, lease: CatalogPluginLease): Promise<void> {
    catalogPluginLeases.set(key, lease);
    const path = this.catalogLeasePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeDurableFile(path, JSON.stringify({ schema: 2, ...lease }));
  }

  private async resolveCatalogLease(key: string): Promise<CatalogPluginLease | undefined> {
    const memory = catalogPluginLeases.get(key);
    if (memory) return memory;
    try {
      const value = JSON.parse(await readFile(this.catalogLeasePath(key), "utf8")) as CatalogPluginLease & { schema?: number };
      if (
        value.schema !== 2
        || typeof value.workspaceSlug !== "string"
        || typeof value.expiresAt !== "number"
        || typeof value.official !== "boolean"
        || typeof value.fingerprint !== "string"
        || !isCatalogLeaseOrigin(value.origin)
        || !isPluginSourceRef(value.source)
      ) return undefined;
      if (value.expiresAt <= Date.now()) {
        await rm(this.catalogLeasePath(key), { force: true });
        return undefined;
      }
      catalogPluginLeases.set(key, value);
      return value;
    } catch {
      return undefined;
    }
  }

  private async validateCatalogLease(lease: CatalogPluginLease): Promise<void> {
    const origin = lease.origin;
    if (origin.kind === "installed") {
      const current = await this.resolveInstalledPluginSource(origin.pluginId, lease.workspaceSlug);
      if (canonicalPluginSourceIdentity(current) !== canonicalPluginSourceIdentity(lease.source)) {
        throw new PluginMarketError("source_not_found", "已安装插件版本已变化，请刷新市场后重试");
      }
      return;
    }
    if (lease.source.type !== "local") return;
    const entries = (await this.readMarketIndex(origin.sourceId)).entries;
    const current = entries.find(
      (entry): entry is MarketIndexPluginEntry => entry.kind === "plugin" && entry.id === origin.itemId,
    );
    if (!current || canonicalPluginSourceIdentity(current.source) !== canonicalPluginSourceIdentity(lease.source)) {
      throw new PluginMarketError("source_not_found", "本地市场条目已变化，请刷新市场后重试");
    }
  }
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

async function withCacheMutationLock<T>(cachePath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${cachePath}.lock`;
  await mkdir(dirname(cachePath), { recursive: true });
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const age = await stat(lockPath).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
      if (age > 60_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new PluginMarketError("network_failed", "市场缓存正由另一个进程更新");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return;
  try { await handle.sync().catch(() => undefined); }
  finally { await handle.close().catch(() => undefined); }
}

async function readValidCacheGeneration(
  cachePath: string,
  generation: string,
): Promise<{ syncedAt: number; entries: MarketIndexEntry[] } | undefined> {
  if (
    dirname(generation) !== dirname(cachePath)
    || !basename(generation).startsWith(`${basename(cachePath)}.`)
  ) return undefined;
  try {
    const content = await readFile(generation, "utf8");
    const marker = JSON.parse(await readFile(`${generation}.complete`, "utf8")) as { schema?: number; contentHash?: string };
    if (marker.schema !== 1 || marker.contentHash !== createHash("sha256").update(content).digest("hex")) return undefined;
    const value = JSON.parse(content) as { syncedAt?: number; entries?: MarketIndexEntry[] };
    return typeof value.syncedAt === "number" && Array.isArray(value.entries)
      ? value as { syncedAt: number; entries: MarketIndexEntry[] }
      : undefined;
  } catch {
    return undefined;
  }
}

async function pruneCacheGenerations(cachePath: string, currentGeneration: string): Promise<void> {
  const directory = dirname(cachePath);
  const prefix = `${basename(cachePath)}.`;
  const generations = (await readdirAsync(directory))
    .filter((name) => name.startsWith(prefix) && !name.endsWith(".complete") && !name.endsWith(".tmp") && name !== `${basename(cachePath)}.current` && name !== `${basename(cachePath)}.lock`)
    .map((name) => join(directory, name))
    .sort((left, right) => right.localeCompare(left));
  const keep = new Set([currentGeneration, ...generations.slice(0, 2)]);
  for (const generation of generations) {
    if (keep.has(generation)) continue;
    await rm(generation, { force: true });
    await rm(`${generation}.complete`, { force: true });
  }
}

function truncateReadme(markdown: string, path: string): PluginReadmePreview {
  if (Buffer.byteLength(markdown, "utf-8") <= README_MAX_BYTES) {
    return { markdown, path, truncated: false };
  }
  const buffer = Buffer.from(markdown, "utf-8").subarray(0, README_MAX_BYTES);
  return {
    markdown: buffer.toString("utf-8").replace(/\uFFFD+$/g, ""),
    path,
    truncated: true,
  };
}

export function summarizePluginMarketplace(
  pluginRoot: string,
  marketplace: NonNullable<NormalizedPlugin["marketplace"]>,
): PluginMarketplaceMetadata {
  return {
    ...(marketplace.icon ? { icon: toMarketplaceAsset(pluginRoot, marketplace.icon) } : {}),
    ...(marketplace.thumbnail ? { thumbnail: toMarketplaceAsset(pluginRoot, marketplace.thumbnail) } : {}),
    ...(marketplace.hero ? { hero: toMarketplaceAsset(pluginRoot, marketplace.hero) } : {}),
    ...(marketplace.website ? { website: marketplace.website } : {}),
    ...(marketplace.docs ? { docs: marketplace.docs } : {}),
    ...(marketplace.setup && marketplace.setup.length > 0 ? { setup: marketplace.setup } : {}),
  };
}

function toMarketplaceAsset(pluginRoot: string, packagePath: string): PluginMarketplaceAsset {
  const asset: PluginMarketplaceAsset = { path: packagePath };
  const resolved = resolveLocalPackagePath(pluginRoot, packagePath);
  if (!resolved) return asset;
  const url = readMarketplaceAssetDataUrl(resolved);
  return url ? { ...asset, url } : asset;
}

function resolveLocalPackagePath(pluginRoot: string, packagePath: string): string | undefined {
  if (!packagePath.startsWith("./")) return undefined;
  const root = resolve(pluginRoot);
  if (!existsSync(root)) return undefined;
  const resolved = resolve(root, packagePath.slice(2));
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  return resolved;
}

function readMarketplaceAssetDataUrl(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  const mime = MARKETPLACE_IMAGE_MIME_BY_EXT[extension];
  if (!mime) return undefined;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MARKETPLACE_ASSET_MAX_BYTES) return undefined;
    const bytes = readFileSync(path);
    if (!matchesImageMagic(bytes, extension)) return undefined;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function matchesImageMagic(bytes: Buffer, extension: string): boolean {
  if (extension === ".svg") {
    return bytes.subarray(0, 512).toString("utf8").trimStart().startsWith("<svg");
  }
  if (extension === ".png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === ".jpg" || extension === ".jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (extension === ".webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function createInstallRecord(pluginId: string): PluginInstallRecord {
  return {
    pluginId,
    versions: {},
    approvalsByHash: {},
  };
}

function compareSemverVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (!leftParts || !rightParts) return left === right ? 0 : undefined;
  const [leftMajor, leftMinor, leftPatch] = leftParts;
  const [rightMajor, rightMinor, rightPatch] = rightParts;
  const pairs = [
    [leftMajor, rightMajor],
    [leftMinor, rightMinor],
    [leftPatch, rightPatch],
  ] as const;
  for (const [leftPart, rightPart] of pairs) {
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function buildMcpServerSensitiveApprovals(input: {
  plugin: NormalizedPlugin;
  installedRoot: string;
  permissionsHash: string;
  workspaceSlug: string;
  enableScope?: InstallMarketItemInput["enableScope"];
  createdAt: string;
}): SensitiveApprovalRecord[] {
  const configPath = input.plugin.capabilities.mcpServersConfigPath;
  if (!configPath || input.plugin.permissions.mcpServers?.register !== true) return [];

  try {
    const raw = JSON.parse(readFileSync(join(input.installedRoot, configPath), "utf-8"));
    const config = parseMcpImportPayload(raw);
    const scope: SensitiveApprovalRecord["scope"] = input.enableScope === "workspace" ? "workspace" : "global";
    return Object.keys(config.servers)
      .sort()
      .map((serverId) => ({
        key: `mcpServer:${input.plugin.pluginId}:${serverId}`,
        scope,
        ...(scope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {}),
        decision: "allow",
        createdAt: input.createdAt,
        permissionsHash: input.permissionsHash,
      }));
  } catch {
    return [];
  }
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
  const match = githubManifestCandidates(subdir)
    .find((candidate) => tree.some((entry) => entry.type === "blob" && entry.path === candidate.path));
  if (!match) {
    throw new PluginMarketError("invalid_manifest", "GitHub 仓库中没有检测到 .lume-plugin/plugin.json 或 .codex-plugin/plugin.json");
  }
  return match;
}

function githubManifestCandidates(subdir?: string): GitHubManifestMatch[] {
  const prefix = subdir ? `${subdir.replace(/\/$/, "")}/` : "";
  return [
    { path: `${prefix}.lume-plugin/plugin.json`, format: "lume" },
    { path: `${prefix}lume-plugin.json`, format: "lume" },
    { path: `${prefix}.codex-plugin/plugin.json`, format: "codex" },
    { path: `${prefix}plugin.json`, format: "legacy" },
  ];
}

function rawGitHubUrl(source: Extract<PluginSourceRef, { type: "github" }>, path: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${path}`;
}

function canonicalPluginSourceIdentity(source: PluginSourceRef): string {
  if (source.type === "local" || source.type === "legacy") {
    const path = resolve(source.path);
    return JSON.stringify({ type: source.type, path: existsSync(path) ? realpathSync(path) : path });
  }
  if (source.type === "github") {
    return JSON.stringify({
      type: source.type,
      owner: source.owner,
      repo: source.repo,
      ref: source.ref,
      subdir: source.subdir ?? "",
    });
  }
  return JSON.stringify({
    type: source.type,
    sourceId: source.sourceId,
    itemId: source.itemId,
    resolved: canonicalPluginSourceIdentity(source.resolved),
  });
}

function pluginSnapshotFingerprint(source: PluginSourceRef, plugin: NormalizedPlugin): string {
  return createHash("sha256")
    .update(canonicalPluginSourceIdentity(source))
    .update("\0")
    .update(JSON.stringify(plugin))
    .digest("hex");
}

function catalogItemKey(input: {
  workspaceSlug: string;
  origin: CatalogPluginLease["origin"];
  source: PluginSourceRef;
  fingerprint: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceSlug: input.workspaceSlug,
    origin: input.origin,
    source: canonicalPluginSourceIdentity(input.source),
    fingerprint: input.fingerprint,
  })).digest("hex");
}

function isCatalogLeaseOrigin(value: unknown): value is CatalogPluginLease["origin"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  if (origin.kind === "installed") return typeof origin.pluginId === "string";
  return origin.kind === "market" && typeof origin.sourceId === "string" && typeof origin.itemId === "string";
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
