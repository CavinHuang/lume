import { homedir } from "node:os";
import { join } from "node:path";
import type { LumePluginManifest } from "@lume/agent-sdk";
import { DEFAULT_PLUGIN_STATE_PATH, FilePluginStateStore } from "./plugin-state-store.js";
import { PluginRegistry, type RegisteredPlugin } from "./plugin-registry.js";

export interface ResolvedPlugin {
  name: string;
  version: string;
  root: string;
  manifestFormat: "lume" | "codex" | "legacy";
  manifest: LumePluginManifest;
  diagnostics?: unknown[];
}

export class SidecarPluginManager {
  constructor(
    private readonly pluginRoot = join(homedir(), ".lume", "plugins"),
    private readonly statePath = DEFAULT_PLUGIN_STATE_PATH,
    private readonly bundledRoots = bundledPluginRoots(),
  ) {}

  async resolveEnabled(config: {
    enabled: string[];
    directories: string[];
  }): Promise<ResolvedPlugin[]> {
    const registry = new PluginRegistry({
      installedRoot: this.pluginRoot,
      legacyGlobalRoot: this.pluginRoot,
      bundledRoots: this.bundledRoots,
      stateStore: new FilePluginStateStore(this.statePath),
    });
    const result = await registry.list({
      enabled: config.enabled,
      disabled: [],
      directories: config.directories,
    });
    return result.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      root: plugin.root,
      manifestFormat: plugin.manifestFormat,
      manifest: {
        schema: "lume-plugin/v1",
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        displayName: plugin.displayName,
        skills: plugin.capabilities.skills.map((skill) => skill.root),
        hooks: plugin.capabilities.hooksConfigPath,
        mcpServers: plugin.capabilities.mcpServersConfigPath,
        // SDK exposes command tools as a typed CommandToolContribution[]; the legacy
        // LumePluginManifest shape declares them as Array<Record<string, unknown>>.
        commandTools: plugin.capabilities.commandTools as unknown as Array<Record<string, unknown>>,
        permissions: plugin.permissions,
      },
      diagnostics: plugin.diagnostics,
    }));
  }

  /**
   * Return the full RegisteredPlugin[] (with Phase 2 permissionState + capabilities),
   * WITHOUT the downgrade mapping that resolveEnabled applies. Used by the Phase 3b
   * PluginRuntimeBridge → PluginCapabilityResolver pipeline.
   */
  async listRegistered(config: {
    enabled: string[];
    directories: string[];
  }): Promise<RegisteredPlugin[]> {
    const registry = new PluginRegistry({
      installedRoot: this.pluginRoot,
      legacyGlobalRoot: this.pluginRoot,
      bundledRoots: this.bundledRoots,
      stateStore: new FilePluginStateStore(this.statePath),
    });
    const result = await registry.list({
      enabled: config.enabled,
      disabled: [],
      directories: config.directories,
    });
    return result.plugins;
  }

  async buildInterceptorContexts(config: {
    enabled: string[];
    directories: string[];
  }): Promise<Array<{ pluginName: string; pluginRoot: string; permissions: Record<string, unknown> }>> {
    const plugins = await this.resolveEnabled(config);
    return plugins.map((plugin) => ({
      pluginName: plugin.name,
      pluginRoot: plugin.root,
      permissions: (plugin.manifest.permissions ?? {}) as unknown as Record<string, unknown>,
    }));
  }
}

function bundledPluginRoots(): string[] {
  const root = process.env.LUME_BUNDLED_PLUGINS_DIR?.trim();
  return root ? [root] : [];
}
