import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest, type LumePluginManifest } from "@lume/agent-sdk/plugins/manifest.js";

export interface ResolvedPlugin {
  name: string;
  version: string;
  root: string;
  manifest: LumePluginManifest;
}

export class SidecarPluginManager {
  private readonly pluginRoot: string;

  constructor(pluginRoot?: string) {
    this.pluginRoot =
      pluginRoot ?? join(process.env.HOME ?? "~", ".lume", "plugins");
  }

  async resolveEnabled(config: {
    enabled: string[];
    directories: string[];
  }): Promise<ResolvedPlugin[]> {
    const roots = [this.pluginRoot, ...config.directories.map((d) => resolve(d))];
    const seen = new Set<string>();
    const results: ResolvedPlugin[] = [];

    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (config.enabled.length > 0 && !config.enabled.includes(entry.name)) continue;
        const pluginDir = join(root, entry.name);
        if (seen.has(pluginDir)) continue;
        seen.add(pluginDir);

        const manifestPath = join(pluginDir, "lume-plugin.json");
        if (!existsSync(manifestPath)) continue;

        try {
          const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const manifest = parseManifest(raw);
          // Skip hooks-only plugins at this layer (handled by hook system)
          if (manifest.lume?.hooksOnly) continue;

          const version = resolveVersion(pluginDir);

          results.push({
            name: manifest.name,
            version,
            root: pluginDir,
            manifest,
          });
        } catch {
          // skip invalid manifests
        }
      }
    }

    return results;
  }

  buildInterceptorContexts(config: {
    enabled: string[];
    directories: string[];
  }): Array<{ pluginName: string; pluginRoot: string; permissions: Record<string, unknown> }> {
    const plugins = this.resolveEnabledSync(config);
    return plugins.map((p) => ({
      pluginName: p.name,
      pluginRoot: p.root,
      permissions: p.manifest.permissions ?? {},
    }));
  }

  private resolveEnabledSync(config: {
    enabled: string[];
    directories: string[];
  }): ResolvedPlugin[] {
    const roots = [this.pluginRoot, ...config.directories.map((d) => resolve(d))];
    const seen = new Set<string>();
    const results: ResolvedPlugin[] = [];

    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (config.enabled.length > 0 && !config.enabled.includes(entry.name)) continue;
        const pluginDir = join(root, entry.name);
        if (seen.has(pluginDir)) continue;
        seen.add(pluginDir);

        const manifestPath = join(pluginDir, "lume-plugin.json");
        if (!existsSync(manifestPath)) continue;

        try {
          const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const manifest = parseManifest(raw);
          if (manifest.lume?.hooksOnly) continue;

          const version = resolveVersion(pluginDir);
          results.push({ name: manifest.name, version, root: pluginDir, manifest });
        } catch {
          // skip
        }
      }
    }
    return results;
  }
}

function resolveVersion(pluginDir: string): string {
  try {
    const entries = readdirSync(pluginDir);
    const versions = entries.filter((e) => /^\d+\.\d+\.\d+/.test(e) || e === "local");
    if (versions.includes("local")) return "local";
    versions.sort(semverSort);
    return versions[versions.length - 1] ?? "local";
  } catch {
    return "local";
  }
}

function semverSort(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
