import { access, mkdir, readdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { parseManifest, inferDefaults, type LumePluginManifest } from "./manifest.js";

export interface PluginInstallInput {
  source: string;
  pluginName: string;
  version?: string;
}

export interface PluginInstallResult {
  installedPath: string;
  version: string;
}

export interface PluginInfo {
  name: string;
  version: string;
  path: string;
}

export class PluginManager {
  private cacheRoot: string;
  private dataRoot: string;

  constructor(cacheRoot?: string, dataRoot?: string) {
    this.cacheRoot =
      cacheRoot ??
      join(process.env.HOME ?? "~", ".lume", "plugins", "cache");
    this.dataRoot =
      dataRoot ?? join(process.env.HOME ?? "~", ".lume", "plugins", "data");
  }

  async install(input: PluginInstallInput): Promise<PluginInstallResult> {
    const version = input.version ?? "local";
    const targetRoot = join(this.cacheRoot, input.pluginName, version);
    await mkdir(targetRoot, { recursive: true });

    // Copy source → target (simple recursive copy)
    await copyDir(input.source, targetRoot);

    // Validate the manifest
    const manifestPath = join(targetRoot, "lume-plugin.json");
    await access(manifestPath);
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    parseManifest(raw);

    // Ensure data dir exists
    await mkdir(join(this.dataRoot, input.pluginName), { recursive: true });

    return { installedPath: targetRoot, version };
  }

  async uninstall(pluginName: string, version?: string): Promise<void> {
    const pluginDir = join(this.cacheRoot, pluginName);
    const entries = await readdir(pluginDir).catch(() => []);
    if (version) {
      await rm(join(pluginDir, version), { recursive: true, force: true });
    } else {
      await rm(pluginDir, { recursive: true, force: true });
    }
  }

  async list(): Promise<PluginInfo[]> {
    const result: PluginInfo[] = [];
    try {
      const entries = await readdir(this.cacheRoot);
      for (const entry of entries) {
        const pluginDir = join(this.cacheRoot, entry);
        try {
          const versions = await readdir(pluginDir);
          for (const ver of versions) {
            const manifestPath = join(pluginDir, ver, "lume-plugin.json");
            try {
              await access(manifestPath);
              result.push({
                name: entry,
                version: ver,
                path: join(pluginDir, ver),
              });
            } catch {
              // skip entries without manifest
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // cache dir doesn't exist
    }
    return result;
  }

  resolveActiveVersion(pluginName: string): string {
    const pluginDir = join(this.cacheRoot, pluginName);
    try {
      const entries = readdirSync(pluginDir);
      const versions = entries.filter((e: string) => e !== "local");
      if (versions.includes("local")) return "local";
      versions.sort(semverSort);
      return versions[versions.length - 1] ?? "local";
    } catch {
      return "local";
    }
  }

  async load(pluginName: string, version?: string): Promise<LumePluginManifest> {
    const ver = version ?? this.resolveActiveVersion(pluginName);
    const manifestPath = join(this.cacheRoot, pluginName, ver, "lume-plugin.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    return inferDefaults(parseManifest(raw));
  }
}

/** Simple semver-aware sort: "1.0.0" < "1.2.0" < "2.0.0" */
function semverSort(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readdirSync(path: string): string[] {
  const { readdirSync: _readdirSync } = require("fs");
  return _readdirSync(path);
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const { readdir } = await import("fs/promises");
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      const { copyFile } = await import("fs/promises");
      await copyFile(srcPath, destPath);
    }
  }
}
