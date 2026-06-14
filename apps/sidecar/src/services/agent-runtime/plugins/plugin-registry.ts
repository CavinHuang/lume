import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  computePermissionsHash,
  normalizePluginManifests,
  type NormalizedPlugin,
  type PluginDiagnostic,
  type SensitiveApprovalRecord,
} from "@lume/agent-sdk";
import type { FilePluginStateStore, PluginStateFile } from "./plugin-state-store.js";
import { PluginPermissionRuntime } from "./permission-runtime.js";

export interface PluginRegistryConfig {
  installedRoot: string;
  legacyGlobalRoot: string;
  workspaceRoot?: string;
  stateStore: FilePluginStateStore;
}

export interface PluginRegistryListInput {
  enabled: string[];
  disabled: string[];
  directories: string[];
}

export interface PluginRegistryState {
  permissionsHash?: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: SensitiveApprovalRecord[];
}

export interface RegisteredPlugin extends NormalizedPlugin {
  state?: PluginRegistryState;
  permissionState?: { state: "loaded" | "needs-review" | "not-loaded"; reason: string };
}

export interface PluginRegistryListResult {
  plugins: RegisteredPlugin[];
  diagnostics: PluginDiagnostic[];
}

interface Candidate {
  plugin: RegisteredPlugin;
  bucket: number;
  scanOrder: number;
}

interface ScanSource {
  root: string;
  bucket: number;
  kind: "directory" | "pluginRoot";
}

export class PluginRegistry {
  constructor(private readonly config: PluginRegistryConfig) {}

  async list(input: PluginRegistryListInput): Promise<PluginRegistryListResult> {
    const state = await this.config.stateStore.read();
    const sources: ScanSource[] = [
      ...(this.config.workspaceRoot
        ? [{ root: this.config.workspaceRoot, bucket: 0, kind: "directory" as const }]
        : []),
      ...input.directories.map((dir, index) => ({
        root: resolve(dir),
        bucket: 10 + index,
        kind: "directory" as const,
      })),
      ...installedCandidateRoots(state, this.config.installedRoot).map((root) => ({
        root,
        bucket: 50,
        kind: "pluginRoot" as const,
      })),
      { root: this.config.legacyGlobalRoot, bucket: 100, kind: "directory" as const },
    ];

    const candidates: Candidate[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    let scanOrder = 0;
    for (const source of sources) {
      for (const plugin of scanSource(source, diagnostics)) {
        candidates.push({
          plugin: attachState(plugin, state),
          bucket: source.bucket,
          scanOrder: scanOrder++,
        });
      }
    }

    const selected = selectEffectiveCandidates(candidates, diagnostics);
    const enabled = new Set(input.enabled);
    const disabled = new Set(input.disabled);
    const filtered = selected.filter((plugin) => {
      if (disabled.has(plugin.pluginId)) return false;
      if (enabled.size === 0) return true;
      return enabled.has(plugin.pluginId);
    });
    await attachPermissionState(filtered, this.config.stateStore, diagnostics);
    return { plugins: filtered, diagnostics };
  }
}

function scanSource(source: ScanSource, diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  if (!existsSync(source.root)) return [];
  if (source.kind === "pluginRoot") {
    const plugin = readPlugin(source.root, diagnostics);
    return plugin ? [plugin] : [];
  }
  return scanRoot(source.root, diagnostics);
}

function scanRoot(root: string, diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  const plugins: NormalizedPlugin[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = join(root, entry.name);
    const plugin = hasPluginManifest(pluginRoot) ? readPlugin(pluginRoot, diagnostics) : null;
    if (plugin) {
      plugins.push(plugin);
      continue;
    }
    if (!hasPluginManifest(pluginRoot)) {
      plugins.push(...scanVersionedPluginDirectory(pluginRoot, diagnostics));
    }
  }
  return plugins;
}

function scanVersionedPluginDirectory(pluginRoot: string, diagnostics: PluginDiagnostic[]): NormalizedPlugin[] {
  const plugins: NormalizedPlugin[] = [];
  for (const versionEntry of readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!versionEntry.isDirectory()) continue;
    const plugin = readPlugin(join(pluginRoot, versionEntry.name), diagnostics);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}

function hasPluginManifest(pluginRoot: string): boolean {
  return existsSync(join(pluginRoot, "lume-plugin.json")) ||
    existsSync(join(pluginRoot, ".codex-plugin", "plugin.json")) ||
    existsSync(join(pluginRoot, "plugin.json"));
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function readPlugin(pluginRoot: string, diagnostics: PluginDiagnostic[]): NormalizedPlugin | null {
  try {
    const plugin = normalizePluginManifests({
      pluginRoot,
      lumeManifest: readJsonIfExists(join(pluginRoot, "lume-plugin.json")),
      codexManifest: readJsonIfExists(join(pluginRoot, ".codex-plugin", "plugin.json")),
      legacyManifest: readJsonIfExists(join(pluginRoot, "plugin.json")),
    });
    diagnostics.push(...plugin.diagnostics);
    return plugin;
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      code: "invalid_manifest",
      message: error instanceof Error ? error.message : String(error),
      path: pluginRoot,
    });
    return null;
  }
}

function installedCandidateRoots(state: PluginStateFile, installedRoot: string): string[] {
  const roots: string[] = [];
  for (const record of Object.values(state.plugins)) {
    if (!record.activeVersion) continue;
    const version = record.versions[record.activeVersion];
    roots.push(version?.installedRoot ?? join(installedRoot, record.pluginId, record.activeVersion));
  }
  return roots;
}

function attachState(plugin: NormalizedPlugin, state: PluginStateFile): RegisteredPlugin {
  const record = state.plugins[plugin.pluginId];
  if (!record) return plugin;

  const versionState = record.activeVersion === plugin.version ? record.versions[plugin.version] : undefined;
  const externalState = record.external?.[sourceKey("directory", plugin.root)];
  const permissionsHash = versionState?.permissionsHash ?? externalState?.permissionsHash;
  const permissionsAcceptedAt = versionState?.permissionsAcceptedAt ?? externalState?.permissionsAcceptedAt;
  const sensitiveApprovals = versionState?.sensitiveApprovals ?? externalState?.sensitiveApprovals ?? [];

  return {
    ...plugin,
    state: {
      permissionsHash,
      permissionsAcceptedAt,
      sensitiveApprovals,
    },
  };
}

function selectEffectiveCandidates(candidates: Candidate[], diagnostics: PluginDiagnostic[]): RegisteredPlugin[] {
  const byId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byId.get(candidate.plugin.pluginId) ?? [];
    group.push(candidate);
    byId.set(candidate.plugin.pluginId, group);
  }

  const selected: RegisteredPlugin[] = [];
  for (const [pluginId, group] of byId) {
    group.sort((left, right) =>
      left.bucket - right.bucket ||
      compareVersionForSelection(right.plugin.version, left.plugin.version) ||
      left.scanOrder - right.scanOrder
    );
    const [winner, ...ignored] = group;
    if (!winner) continue;

    selected.push(winner.plugin);
    for (const item of ignored) {
      diagnostics.push({
        pluginId,
        version: item.plugin.version,
        severity: "info",
        code: "duplicate_plugin_ignored",
        message: `Ignored duplicate plugin ${pluginId} at ${item.plugin.root}; selected ${winner.plugin.root}.`,
        path: item.plugin.root,
      });
    }
  }
  return selected.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function compareVersionForSelection(a: string, b: string): number {
  if (a === "local" && b !== "local") return 1;
  if (b === "local" && a !== "local") return -1;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sourceKey(sourceType: "directory", pluginRoot: string): string {
  return `${sourceType}:${realpathSync.native(pluginRoot)}`;
}

async function attachPermissionState(
  plugins: RegisteredPlugin[],
  stateStore: FilePluginStateStore,
  diagnostics: PluginDiagnostic[],
): Promise<void> {
  const runtime = new PluginPermissionRuntime({ stateStore });
  for (const plugin of plugins) {
    const currentHash = computePermissionsHash(plugin);
    const result = await runtime.computeRuntimeState({
      pluginId: plugin.pluginId,
      enabled: true, // filtered plugins are enabled under the effective config
      currentHash,
    });
    plugin.permissionState = result;
    if (result.state !== "loaded") {
      diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: result.state === "needs-review" ? "warning" : "info",
        code: result.state === "needs-review" ? "permission_review_required" : "capability_filtered",
        message: `Plugin ${plugin.pluginId} is ${result.state} (${result.reason}); capabilities will not load until reviewed.`,
        path: plugin.root,
      });
    }
  }
}
