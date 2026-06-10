import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest, type LumePluginManifest } from "@lume/agent-sdk/plugins/manifest.js";
import { createLogger } from "../../infra/logger";

const log = createLogger("plugin-manager");

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

  resolveEnabled(config: {
    enabled: string[];
    directories: string[];
  }): ResolvedPlugin[] {
    const roots = [this.pluginRoot, ...config.directories.map((d) => resolve(d))];
    const seen = new Set<string>();
    const results: ResolvedPlugin[] = [];

    log.debug("Resolving plugins", {
      pluginRoot: this.pluginRoot,
      extraDirectories: config.directories,
      enabledFilter: config.enabled,
      roots: roots.filter((r) => existsSync(r)),
    });

    for (const root of roots) {
      if (!existsSync(root)) {
        log.debug("Plugin root does not exist, skipping", { root });
        continue;
      }
      const entries = readdirSync(root, { withFileTypes: true });
      log.debug("Scanning plugin root", { root, entryCount: entries.length });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (config.enabled.length > 0 && !config.enabled.includes(entry.name)) {
          log.debug("Plugin not in enabled list, skipping", { root, name: entry.name });
          continue;
        }
        const pluginDir = join(root, entry.name);
        if (seen.has(pluginDir)) continue;
        seen.add(pluginDir);

        const loaded = loadPluginFromDir(pluginDir);
        if (!loaded) {
          log.debug("No valid plugin manifest found, skipping", { dir: pluginDir });
          continue;
        }

        const version = resolveVersion(pluginDir);
        const manifest = loaded.manifest;
        log.info("Plugin resolved", {
          name: manifest.name,
          version,
          root: pluginDir,
          hooksOnly: manifest.lume?.hooksOnly ?? false,
          skills: manifest.skills?.length ?? 0,
          hooks: typeof manifest.hooks === 'string' ? manifest.hooks : !!manifest.hooks,
          mcpServers: typeof manifest.mcpServers === 'string' ? manifest.mcpServers : !!manifest.mcpServers,
        });
        results.push({
          name: manifest.name,
          version,
          root: pluginDir,
          manifest,
        });
      }
    }

    log.info("Plugin resolution complete", { totalResolved: results.length, names: results.map((r) => r.name) });
    return results;
  }

  buildInterceptorContexts(config: {
    enabled: string[];
    directories: string[];
  }): Array<{ pluginName: string; pluginRoot: string; permissions: Record<string, unknown> }> {
    const plugins = this.resolveEnabled(config);
    return plugins.map((p) => ({
      pluginName: p.name,
      pluginRoot: p.root,
      permissions: p.manifest.permissions ?? {},
    }));
  }
}

function loadPluginFromDir(pluginDir: string): { manifest: LumePluginManifest } | null {
  const lumePath = join(pluginDir, "lume-plugin.json");
  if (existsSync(lumePath)) {
    try {
      const raw = JSON.parse(readFileSync(lumePath, "utf-8"));
      const manifest = parseManifest(raw);
      log.debug("Loaded lume-plugin.json manifest", { dir: pluginDir, name: manifest.name });
      return { manifest };
    } catch (error) {
      log.warn("Failed to parse lume-plugin.json", { dir: pluginDir, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  // Fallback: plugin.json (legacy v1 command-only format)
  const legacyPath = join(pluginDir, "plugin.json");
  if (existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
      // Must have at least one command tool (same rule as validateCommandPluginManifest)
      const tools = Array.isArray(raw.tools) ? raw.tools : [];
      const hasCommandTool = tools.some(
        (t: Record<string, unknown>) =>
          typeof t.name === "string" && typeof t.command === "string",
      );
      if (!hasCommandTool) {
        log.debug("Legacy plugin.json has no command tools, skipping", { dir: pluginDir });
        return null;
      }

      const name = (raw.name as string) ?? pluginDir.split("/").pop() ?? "unknown";
      log.debug("Loaded legacy plugin.json manifest", { dir: pluginDir, name });
      const synthetic = {
        schema: "lume-plugin/v1" as const,
        name,
        version: "local",
        description: raw.description as string | undefined,
        skills: raw.skills ? [raw.skills] : undefined,
        hooks: raw.hooks as string | undefined,
        mcpServers: raw.mcpServers as string | undefined,
        permissions: {
          mcpServers: { register: true },
          shell: { allow: true },
          tools: {
            allow: ["FileRead", "Glob", "Grep", "WebFetch", "WebSearch", "TaskList", "TaskGet", "AskUserQuestion", "Config"],
            deny: ["Bash", "FileWrite", "FileEdit", "NotebookEdit", "EnterWorktree", "ExitWorktree", "AgentTool", "SendMessage"],
          },
        },
        lume: { hooksOnly: false },
      };
      return { manifest: synthetic as LumePluginManifest };
    } catch (error) {
      log.warn("Failed to parse legacy plugin.json", { dir: pluginDir, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  return null;
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
