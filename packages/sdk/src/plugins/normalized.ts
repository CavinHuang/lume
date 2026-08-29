import { adaptCodexPlugin } from "./codex-adapter.js";
import {
  validateManifest,
  validatePluginPath,
  type PluginMarketplaceManifest,
  type PluginPermissions,
} from "./manifest.js";

export type PluginManifestFormat = "lume" | "codex" | "legacy";
export type PluginDiagnosticSeverity = "info" | "warning" | "error";

export interface PluginDiagnostic {
  pluginId?: string;
  version?: string;
  severity: PluginDiagnosticSeverity;
  code:
    | "ignored_manifest"
    | "legacy_manifest"
    | "invalid_manifest"
    | "unsafe_path"
    | "unsupported_field"
    | "duplicate_plugin_ignored"
    | "permission_review_required"
    | "capability_filtered"
    | "mcp_start_failed"
    | "orphaned_install"
    | "command_tool_invalid";
  message: string;
  path?: string;
}

export interface PluginSkillContribution {
  pluginId: string;
  version: string;
  root: string;
}

export interface CommandToolContribution {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  inputSchema?: Record<string, unknown>;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface PluginManifestCapabilities {
  skills: PluginSkillContribution[];
  hooksConfigPath?: string;
  mcpServersConfigPath?: string;
  commandTools: CommandToolContribution[];
}

export interface NormalizedPlugin {
  pluginId: string;
  name: string;
  version: string;
  root: string;
  manifestFormat: PluginManifestFormat;
  displayName?: string;
  description?: string;
  author?: string;
  /** 市场分类（manifest 声明，如 生产力/开发者工具） */
  category?: string;
  capabilities: PluginManifestCapabilities;
  permissions: PluginPermissions;
  marketplace?: PluginMarketplaceManifest;
  diagnostics: PluginDiagnostic[];
  /** Carries Lume-specific flags consumed by the capability resolver (spec §16.3). */
  lume?: { hooksOnly?: boolean };
}

export interface NormalizePluginManifestsInput {
  pluginRoot: string;
  lumeManifest?: Record<string, unknown>;
  codexManifest?: Record<string, unknown>;
  legacyManifest?: Record<string, unknown>;
}

// Real built-in tool names: checkToolPermission is exact-match, so legacy
// aliases like FileWrite/FileEdit/AgentTool never matched anything (#316).
const LEGACY_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
  "Config",
];

const LEGACY_DENIED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "EnterWorktree",
  "ExitWorktree",
  "Agent",
  "SendMessage",
];

export function normalizePluginManifests(input: NormalizePluginManifestsInput): NormalizedPlugin {
  if (input.lumeManifest) {
    const plugin = normalizeLumeManifest(input.pluginRoot, input.lumeManifest, "lume");
    if (input.codexManifest) {
      plugin.diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: "info",
        code: "ignored_manifest",
        message: "Ignored .codex-plugin/plugin.json because lume-plugin.json is present.",
      });
    }
    return plugin;
  }
  if (input.codexManifest) {
    const adapted = adaptCodexPlugin(input.codexManifest, input.pluginRoot);
    return normalizeLumeManifest(input.pluginRoot, adapted, "codex");
  }
  if (input.legacyManifest) {
    return normalizeLegacyCommandManifest(input.pluginRoot, input.legacyManifest);
  }
  throw new Error("No supported plugin manifest found");
}

function normalizeLumeManifest(
  pluginRoot: string,
  raw: Record<string, unknown>,
  format: "lume" | "codex",
): NormalizedPlugin {
  const manifest = validateManifest(raw);
  const diagnostics: PluginDiagnostic[] = [];
  collectUnsupportedFields(raw, diagnostics, manifest.name, manifest.version);
  const commandTools = normalizeCommandTools(raw.commandTools ?? [], diagnostics, manifest.name, manifest.version);

  return {
    pluginId: manifest.name,
    name: manifest.name,
    version: manifest.version,
    root: pluginRoot,
    manifestFormat: format,
    displayName: manifest.displayName,
    description: manifest.description,
    ...(manifest.author ? { author: manifest.author } : {}),
    capabilities: {
      skills: (manifest.skills ?? []).map((root) => ({
        pluginId: manifest.name,
        version: manifest.version,
        root,
      })),
      ...(manifest.hooks ? { hooksConfigPath: manifest.hooks } : {}),
      ...(manifest.mcpServers ? { mcpServersConfigPath: manifest.mcpServers } : {}),
      commandTools,
    },
    permissions: manifest.permissions ?? {},
    ...(manifest.marketplace ? { marketplace: manifest.marketplace } : {}),
    diagnostics,
    ...(manifest.lume?.hooksOnly ? { lume: { hooksOnly: true } } : {}),
  };
}

function normalizeCommandTools(
  value: unknown,
  diagnostics: PluginDiagnostic[],
  pluginId: string,
  version: string,
): CommandToolContribution[] {
  if (!Array.isArray(value)) return [];

  const result: CommandToolContribution[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push({
        pluginId,
        version,
        severity: "warning",
        code: "command_tool_invalid",
        message: "Command tool must be an object.",
      });
      continue;
    }

    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string" || typeof tool.command !== "string") {
      diagnostics.push({
        pluginId,
        version,
        severity: "warning",
        code: "command_tool_invalid",
        message: "Command tool requires name and command.",
      });
      continue;
    }

    if (tool.cwd !== undefined) {
      if (typeof tool.cwd !== "string") {
        diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid cwd for command tool ${tool.name}.`));
        continue;
      }
      try {
        validatePluginPath(tool.cwd, "commandTools.cwd");
      } catch {
        diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid cwd for command tool ${tool.name}.`));
        continue;
      }
    }
    if (tool.args !== undefined && (!Array.isArray(tool.args) || !tool.args.every((arg) => typeof arg === "string"))) {
      diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid args for command tool ${tool.name}.`));
      continue;
    }
    if (tool.timeoutMs !== undefined && typeof tool.timeoutMs !== "number") {
      diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid timeoutMs for command tool ${tool.name}.`));
      continue;
    }
    if (tool.inputSchema !== undefined && (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema))) {
      diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid inputSchema for command tool ${tool.name}.`));
      continue;
    }
    if (tool.env !== undefined && !isStringRecord(tool.env)) {
      diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid env for command tool ${tool.name}.`));
      continue;
    }
    if (tool.metadata !== undefined && (!tool.metadata || typeof tool.metadata !== "object" || Array.isArray(tool.metadata))) {
      diagnostics.push(invalidCommandToolDiagnostic(pluginId, version, `Invalid metadata for command tool ${tool.name}.`));
      continue;
    }

    result.push({
      name: tool.name,
      command: tool.command,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(Array.isArray(tool.args) ? { args: tool.args } : {}),
      ...(typeof tool.cwd === "string" ? { cwd: tool.cwd } : {}),
      ...(typeof tool.timeoutMs === "number" ? { timeoutMs: tool.timeoutMs } : {}),
      ...(tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? { inputSchema: tool.inputSchema as Record<string, unknown> }
        : {}),
      ...(isStringRecord(tool.env) ? { env: tool.env } : {}),
      ...(tool.metadata && typeof tool.metadata === "object" && !Array.isArray(tool.metadata)
        ? { metadata: tool.metadata as Record<string, unknown> }
        : {}),
    });
  }
  return result;
}

function normalizeLegacyCommandManifest(pluginRoot: string, raw: Record<string, unknown>): NormalizedPlugin {
  const name = typeof raw.name === "string" ? raw.name : pluginRoot.split("/").pop() ?? "legacy-plugin";
  const version = typeof raw.version === "string" ? raw.version : "local";
  const diagnostics: PluginDiagnostic[] = [
    {
      pluginId: name,
      version,
      severity: "info",
      code: "legacy_manifest",
      message: "Loaded legacy plugin.json command-only plugin.",
    },
  ];
  const commandTools = normalizeCommandTools(raw.tools, diagnostics, name, version);
  if (commandTools.length === 0) {
    throw new Error("Legacy plugin.json requires at least one command tool.");
  }
  return {
    pluginId: name,
    name,
    version,
    root: pluginRoot,
    manifestFormat: "legacy",
    description: typeof raw.description === "string" ? raw.description : undefined,
    capabilities: { skills: [], commandTools },
    permissions: {
      mcpServers: { register: true },
      shell: { allow: true },
      tools: {
        allow: [...LEGACY_ALLOWED_TOOLS],
        deny: [...LEGACY_DENIED_TOOLS],
      },
    },
    diagnostics,
  };
}

function collectUnsupportedFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
  pluginId: string,
  version: string,
) {
  for (const field of ["entry", "main", "module"]) {
    if (raw[field] !== undefined) {
      diagnostics.push({
        pluginId,
        version,
        severity: "warning",
        code: "unsupported_field",
        message: `Ignored unsupported executable field ${field}.`,
        path: field,
      });
    }
  }
}

function invalidCommandToolDiagnostic(pluginId: string, version: string, message: string): PluginDiagnostic {
  return {
    pluginId,
    version,
    severity: "warning",
    code: "command_tool_invalid",
    message,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}
