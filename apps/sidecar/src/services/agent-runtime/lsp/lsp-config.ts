import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LumeConfigLspSection, LumeLspServerConfig } from "@lume/shared";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import { getConfigDir } from "../../infra/config-paths.js";

export interface ResolvedRuntimeLspConfig extends LumeConfigLspSection {
  servers?: Record<string, LumeLspServerConfig>;
}

export async function resolveRuntimeLspConfig(input: {
  cwd: string;
  user?: LumeConfigLspSection;
  plugins: RegisteredPlugin[];
}): Promise<ResolvedRuntimeLspConfig> {
  const userFile = await readFirstConfig(getConfigDir(), [
    "lsp.json",
    ".lsp.json",
    "lsp.yaml",
    ".lsp.yaml",
    "lsp.yml",
    ".lsp.yml",
  ]);
  const plugin = await loadPluginLspConfig(input.plugins);
  const project = await loadProjectLspConfig(input.cwd);
  return mergeLspSections(input.user, userFile, plugin, project);
}

async function loadProjectLspConfig(cwd: string): Promise<LumeConfigLspSection | undefined> {
  // Config lookup is bounded by the containing git repository; with no .git
  // anywhere up the chain only cwd itself is consulted. Temp/shared ancestor
  // directories must not be able to spawn servers (#203).
  let boundary = resolve(cwd);
  for (let dir = boundary; ; ) {
    if (existsSync(join(dir, ".git"))) {
      boundary = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  let directory = resolve(cwd);
  while (true) {
    const direct = await readFirstConfig(directory, ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"]);
    const lume = await readFirstConfig(join(directory, ".lume"), ["lsp.json", "lsp.yaml", "lsp.yml"]);
    if (direct || lume) return mergeLspSections(lume, direct);
    if (directory === boundary) return undefined;
    directory = dirname(directory);
  }
}

async function loadPluginLspConfig(plugins: RegisteredPlugin[]): Promise<LumeConfigLspSection | undefined> {
  let merged: LumeConfigLspSection | undefined;
  for (const plugin of plugins) {
    const path = plugin.capabilities.lspServersConfigPath;
    if (
      !path
      || plugin.permissionState?.state !== "loaded"
      || plugin.permissions.shell?.allow !== true
    ) continue;
    const absolute = resolve(plugin.root, path);
    if (
      isAbsolute(path)
      || relative(plugin.root, absolute).startsWith("..")
    ) {
      addPluginDiagnostic(plugin, "unsafe_path", `LSP config path escapes the plugin root: ${path}`, absolute);
      continue;
    }
    const parsed = await readPluginConfig(plugin, absolute);
    if (parsed) merged = mergeLspSections(merged, parsed);
  }
  return merged;
}

async function readFirstConfig(directory: string, names: string[]): Promise<LumeConfigLspSection | undefined> {
  for (const name of names) {
    const parsed = await readConfig(join(directory, name));
    if (parsed) return parsed;
  }
  return undefined;
}

async function readConfig(path: string): Promise<LumeConfigLspSection | undefined> {
  try {
    const body = await readFile(path, "utf8");
    return parseLspConfig(path, body);
  } catch {
    return undefined;
  }
}

async function readPluginConfig(
  plugin: RegisteredPlugin,
  path: string,
): Promise<LumeConfigLspSection | undefined> {
  try {
    const [rootPath, configPath] = await Promise.all([realpath(plugin.root), realpath(path)]);
    if (relative(rootPath, configPath).startsWith("..")) {
      addPluginDiagnostic(plugin, "unsafe_path", "LSP config symlink escapes the plugin root.", path);
      return undefined;
    }
    const body = await readFile(configPath, "utf8");
    const parsed = parseLspConfig(configPath, body);
    if (!parsed) throw new Error("LSP config must contain an object of server definitions.");
    return parsed;
  } catch (error) {
    addPluginDiagnostic(
      plugin,
      "lsp_config_invalid",
      error instanceof Error ? error.message : String(error),
      path,
    );
    return undefined;
  }
}

function parseLspConfig(path: string, body: string): LumeConfigLspSection | undefined {
  const parsed = /\.(yaml|yml)$/i.test(path) ? parseYaml(body) : JSON.parse(body);
  return normalizeLspSection(parsed);
}

function addPluginDiagnostic(
  plugin: RegisteredPlugin,
  code: "unsafe_path" | "lsp_config_invalid",
  message: string,
  path: string,
): void {
  plugin.diagnostics.push({
    pluginId: plugin.pluginId,
    version: plugin.version,
    severity: "warning",
    code,
    message,
    path,
  });
}

function normalizeLspSection(value: unknown): LumeConfigLspSection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const source = record.lsp && typeof record.lsp === "object" && !Array.isArray(record.lsp)
    ? record.lsp as Record<string, unknown>
    : record;
  const serversValue = source.servers && typeof source.servers === "object" && !Array.isArray(source.servers)
    ? source.servers as Record<string, unknown>
    : looksLikeServerMap(source) ? source : undefined;
  const servers = serversValue
    ? Object.fromEntries(Object.entries(serversValue).filter(([, server]) =>
      Boolean(server) && typeof server === "object" && !Array.isArray(server)
    )) as Record<string, LumeLspServerConfig>
    : undefined;
  return {
    ...(typeof source.enabled === "boolean" ? { enabled: source.enabled } : {}),
    ...(typeof source.lazy === "boolean" ? { lazy: source.lazy } : {}),
    ...(typeof source.diagnosticsOnWrite === "boolean" ? { diagnosticsOnWrite: source.diagnosticsOnWrite } : {}),
    ...(typeof source.diagnosticsDeduplicate === "boolean" ? { diagnosticsDeduplicate: source.diagnosticsDeduplicate } : {}),
    ...(typeof source.formatOnWrite === "boolean" ? { formatOnWrite: source.formatOnWrite } : {}),
    ...(typeof source.idleTimeoutMs === "number" ? { idleTimeoutMs: source.idleTimeoutMs } : {}),
    ...(source.useLspmux === "auto" || source.useLspmux === "off" ? { useLspmux: source.useLspmux } : {}),
    ...(servers ? { servers } : {}),
  };
}

function looksLikeServerMap(value: Record<string, unknown>): boolean {
  const optionKeys = new Set([
    "enabled",
    "lazy",
    "diagnosticsOnWrite",
    "diagnosticsDeduplicate",
    "formatOnWrite",
    "idleTimeoutMs",
    "useLspmux",
  ]);
  return Object.keys(value).some((key) => !optionKeys.has(key));
}

function mergeLspSections(...sections: Array<LumeConfigLspSection | undefined>): ResolvedRuntimeLspConfig {
  const output: ResolvedRuntimeLspConfig = {};
  for (const section of sections) {
    if (!section) continue;
    Object.assign(output, section, {
      servers: {
        ...(output.servers ?? {}),
        ...(section.servers ?? {}),
      },
    });
  }
  if (Object.keys(output.servers ?? {}).length === 0) delete output.servers;
  return output;
}
