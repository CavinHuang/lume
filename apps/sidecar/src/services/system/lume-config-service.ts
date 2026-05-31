import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import {
  DEFAULT_LUME_PERMISSION_APPROVALS,
  DEFAULT_LUME_WEB_SEARCH,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
  type LumeConfigAuditEntry,
  type LumeConfigAuditSource,
  type LumeConfigFile,
  type LumeConfigImAccountApprovalPolicy,
  type LumeConfigImApprovalPolicy,
  type LumeConfigPermissionApprovalRoutes,
  type LumeConfigPermissionRule,
  type LumeConfigSectionSet,
  type LumeConfigSubagentApprovalPolicy,
  type LumeConfigWebSearchSection,
  type LumeEffectiveConfig,
  type WebSearchProvider
} from "@lume/shared";
import { getLumeConfigAuditPath, getLumeConfigYamlPath } from "../infra/config-paths";

interface UpdateLumeConfigSectionInput {
  source: LumeConfigAuditSource;
  workspaceSlug?: string;
  path: string;
  value: unknown;
  summary?: string;
}

const CONFIG_VERSION = 1;
const DEFAULT_INTERNAL_HOOKS = {
  enabled: true,
  memory: true,
  security: true,
  observability: true
} as const;

function createDefaultLumeConfig(): LumeConfigFile {
  return {
    version: CONFIG_VERSION,
    agent: {},
    providers: {},
    models: {
      embedding: {
        defaultModelRef: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF
      }
    },
    mcp: {},
    skills: {
      enabled: [],
      disabled: []
    },
    plugins: {
      enabled: [],
      directories: []
    },
    permissions: {
      toolPolicy: {
        allow: [],
        deny: []
      },
      rules: [],
      classifier: {
        enabled: false
      },
      privateWriteRoots: [],
      approvals: createDefaultPermissionApprovals()
    },
    hooks: {
      internal: { ...DEFAULT_INTERNAL_HOOKS }
    },
    webSearch: { ...DEFAULT_LUME_WEB_SEARCH },
    workspaces: {}
  };
}

function createDefaultPermissionApprovals(): LumeConfigPermissionApprovalRoutes {
  return {
    desktop: { ...(DEFAULT_LUME_PERMISSION_APPROVALS.desktop ?? {}) },
    subagent: { ...(DEFAULT_LUME_PERMISSION_APPROVALS.subagent ?? {}) },
    im: {
      ...(DEFAULT_LUME_PERMISSION_APPROVALS.im ?? {}),
      accounts: { ...(DEFAULT_LUME_PERMISSION_APPROVALS.im?.accounts ?? {}) }
    }
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUniqueStringArray(value: unknown): string[] {
  const normalized: string[] = [];
  for (const item of normalizeStringArray(value)) {
    const trimmed = item.trim();
    if (!trimmed || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeFallbackModelRefs(
  value: unknown,
  defaultModelRef?: string
): string[] {
  const blocked = defaultModelRef?.trim();
  return normalizeUniqueStringArray(value).filter((item) => item !== blocked);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePermissionRules(value: unknown): LumeConfigPermissionRule[] {
  if (!Array.isArray(value)) return [];
  const rules: LumeConfigPermissionRule[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const tool = normalizeOptionalString(item.tool);
    if (!tool) continue;
    const action = item.action === "allow" || item.action === "ask" || item.action === "deny"
      ? item.action
      : undefined;
    if (!action) continue;
    rules.push({
      ...(typeof item.id === "string" && item.id.trim() ? { id: item.id.trim() } : {}),
      tool,
      ...(typeof item.commandPattern === "string" && item.commandPattern.trim()
        ? { commandPattern: item.commandPattern.trim() }
        : {}),
      ...(typeof item.pathPattern === "string" && item.pathPattern.trim()
        ? { pathPattern: item.pathPattern.trim() }
        : {}),
      action,
      ...(item.scope === "session" || item.scope === "workspace" || item.scope === "global"
        ? { scope: item.scope }
        : {})
    });
  }
  return rules;
}

function normalizeSubagentApprovalPolicy(value: unknown): LumeConfigSubagentApprovalPolicy {
  if (!isPlainObject(value)) return {};
  return {
    ...(value.mode === "inherit" || value.mode === "ask-parent" || value.mode === "deny-high-risk"
      ? { mode: value.mode }
      : {}),
    ...(value.allowAlways === "disabled" || value.allowAlways === "desktop-only" || value.allowAlways === "parent-only"
      ? { allowAlways: value.allowAlways }
      : {})
  };
}

function normalizeApprovalAllowAlwaysPolicy(value: unknown): LumeConfigImAccountApprovalPolicy["allowAlways"] {
  if (value === "disabled" || value === "desktop-only" || value === "dm-only") {
    return value;
  }
  return undefined;
}

function normalizeImAccountApprovalPolicy(value: unknown): LumeConfigImAccountApprovalPolicy {
  if (!isPlainObject(value)) return {};
  const allowAlways = normalizeApprovalAllowAlwaysPolicy(value.allowAlways);
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.allowTextApprove === "boolean" ? { allowTextApprove: value.allowTextApprove } : {}),
    ...(allowAlways ? { allowAlways } : {}),
    ...(value.groupApproval === "disabled" || value.groupApproval === "desktop-only"
      ? { groupApproval: value.groupApproval }
      : {}),
    ...(Array.isArray(value.approverPeerIds)
      ? { approverPeerIds: normalizeUniqueStringArray(value.approverPeerIds) }
      : {})
  };
}

function normalizeImApprovalPolicy(value: unknown): LumeConfigImApprovalPolicy {
  if (!isPlainObject(value)) return {};
  const allowAlways = normalizeApprovalAllowAlwaysPolicy(value.allowAlways);
  const accounts: Record<string, LumeConfigImAccountApprovalPolicy> = {};
  if (isPlainObject(value.accounts)) {
    for (const [accountId, policyValue] of Object.entries(value.accounts)) {
      const normalizedAccountId = accountId.trim();
      if (!normalizedAccountId) continue;
      const normalizedPolicy = normalizeImAccountApprovalPolicy(policyValue);
      if (Object.keys(normalizedPolicy).length > 0) {
        accounts[normalizedAccountId] = normalizedPolicy;
      }
    }
  }
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.allowTextApprove === "boolean" ? { allowTextApprove: value.allowTextApprove } : {}),
    ...(allowAlways ? { allowAlways } : {}),
    ...(value.groupApproval === "disabled" || value.groupApproval === "desktop-only"
      ? { groupApproval: value.groupApproval }
      : {}),
    ...(Object.keys(accounts).length > 0 ? { accounts } : {})
  };
}

function normalizePermissionApprovals(value: unknown): LumeConfigPermissionApprovalRoutes {
  if (!isPlainObject(value)) return {};
  const desktop = isPlainObject(value.desktop) && typeof value.desktop.enabled === "boolean"
    ? { enabled: value.desktop.enabled }
    : {};
  const subagent = normalizeSubagentApprovalPolicy(value.subagent);
  const im = normalizeImApprovalPolicy(value.im);
  return {
    ...(Object.keys(desktop).length > 0 ? { desktop } : {}),
    ...(Object.keys(subagent).length > 0 ? { subagent } : {}),
    ...(Object.keys(im).length > 0 ? { im } : {})
  };
}

function mergeImAccountApprovalPolicies(
  base?: Record<string, LumeConfigImAccountApprovalPolicy>,
  overlay?: Record<string, LumeConfigImAccountApprovalPolicy>
): Record<string, LumeConfigImAccountApprovalPolicy> {
  const merged: Record<string, LumeConfigImAccountApprovalPolicy> = {};
  for (const accountId of new Set([...Object.keys(base ?? {}), ...Object.keys(overlay ?? {})])) {
    merged[accountId] = {
      ...(base?.[accountId] ?? {}),
      ...(overlay?.[accountId] ?? {})
    };
  }
  return merged;
}

function mergeImApprovalPolicy(
  base?: LumeConfigImApprovalPolicy,
  overlay?: LumeConfigImApprovalPolicy
): LumeConfigImApprovalPolicy | undefined {
  if (!base && !overlay) return undefined;
  return {
    ...(base ?? {}),
    ...(overlay ?? {}),
    accounts: mergeImAccountApprovalPolicies(base?.accounts, overlay?.accounts)
  };
}

function mergePermissionApprovals(
  base?: LumeConfigPermissionApprovalRoutes,
  overlay?: LumeConfigPermissionApprovalRoutes
): LumeConfigPermissionApprovalRoutes {
  const im = mergeImApprovalPolicy(base?.im, overlay?.im);
  return {
    desktop: {
      ...(base?.desktop ?? {}),
      ...(overlay?.desktop ?? {})
    },
    subagent: {
      ...(base?.subagent ?? {}),
      ...(overlay?.subagent ?? {})
    },
    ...(im ? { im } : {})
  };
}

function normalizeHooksSection(value: unknown): NonNullable<LumeConfigSectionSet["hooks"]> {
  if (!isPlainObject(value)) return {};
  const internal = isPlainObject(value.internal) ? value.internal : {};
  return {
    internal: {
      ...(typeof internal.enabled === "boolean" ? { enabled: internal.enabled } : {}),
      ...(typeof internal.memory === "boolean" ? { memory: internal.memory } : {}),
      ...(typeof internal.security === "boolean" ? { security: internal.security } : {}),
      ...(typeof internal.observability === "boolean" ? { observability: internal.observability } : {})
    }
  };
}

const WEB_SEARCH_PROVIDER_KEYS: WebSearchProvider[] = ["exa", "tavily", "brave", "duckduckgo", "pipellm", "zhipu", "bing"];

function normalizeWebSearchSection(value: unknown): LumeConfigWebSearchSection {
  if (!isPlainObject(value)) return { ...DEFAULT_LUME_WEB_SEARCH };
  const strategy = value.strategy === "priority" || value.strategy === "joint" ? value.strategy : DEFAULT_LUME_WEB_SEARCH.strategy;
  const providers: LumeConfigWebSearchSection["providers"] = {};
  if (isPlainObject(value.providers)) {
    for (const key of WEB_SEARCH_PROVIDER_KEYS) {
      const entry = value.providers[key];
      if (!isPlainObject(entry)) continue;
      providers[key] = {
        ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
        ...(typeof entry.apiKey === "string" && entry.apiKey.trim() ? { apiKey: entry.apiKey.trim() } : {})
      };
    }
  }
  return { strategy, ...(Object.keys(providers).length > 0 ? { providers } : {}) };
}

export function syncWebSearchEnvVars(config: LumeConfigWebSearchSection): void {
  const providers = config.providers ?? {};
  const envMap: Partial<Record<WebSearchProvider, string[]>> = {
    brave: ["BRAVE_API_KEY", "LUME_BRAVE_API_KEY"],
    tavily: ["TAVILY_API_KEY", "LUME_TAVILY_API_KEY"],
    exa: ["EXA_API_KEY", "LUME_EXA_API_KEY"],
    pipellm: ["PIPELLM_API_KEY", "LUME_PIPELLM_API_KEY"],
    zhipu: ["ZHIPU_API_KEY", "LUME_ZHIPU_API_KEY"]
  };
  for (const [provider, keys] of Object.entries(envMap)) {
    if (!keys) continue;
    const apiKey = providers[provider as WebSearchProvider]?.apiKey;
    for (const key of keys) {
      if (apiKey) {
        process.env[key] = apiKey;
      }
    }
  }
}

function normalizeSectionSet(value: unknown): LumeConfigSectionSet {
  if (!isPlainObject(value)) {
    return {};
  }
  const next: LumeConfigSectionSet = {};

  if (isPlainObject(value.models)) {
    const chat = isPlainObject(value.models.chat) ? value.models.chat : {};
    const agent = isPlainObject(value.models.agent) ? value.models.agent : {};
    const subagent = isPlainObject(value.models.subagent) ? value.models.subagent : {};
    const embedding = isPlainObject(value.models.embedding) ? value.models.embedding : {};
    const agentDefaultChannelId = normalizeOptionalString(agent.defaultChannelId);
    const agentDefaultModelRef = normalizeOptionalString(agent.defaultModelRef);
    const subagentDefaultModelRef = normalizeOptionalString(subagent.defaultModelRef);
    next.models = {
      chat: {
        ...(typeof chat.defaultModelRef === "string"
          ? { defaultModelRef: chat.defaultModelRef }
          : {})
      },
      agent: {
        ...(agentDefaultChannelId
          ? { defaultChannelId: agentDefaultChannelId }
          : {}),
        ...(agentDefaultModelRef
          ? { defaultModelRef: agentDefaultModelRef }
          : {}),
        ...(Array.isArray(agent.fallbackModelRefs)
          ? { fallbackModelRefs: normalizeFallbackModelRefs(agent.fallbackModelRefs, agentDefaultModelRef) }
          : {})
      },
      subagent: {
        ...(subagentDefaultModelRef
          ? { defaultModelRef: subagentDefaultModelRef }
          : {})
      },
      embedding: {
        ...(typeof embedding.defaultModelRef === "string"
          ? { defaultModelRef: embedding.defaultModelRef }
          : {})
      }
    };
  }

  if (isPlainObject(value.agent)) {
    next.agent = {
      ...(value.agent.permissionMode === "default"
        || value.agent.permissionMode === "acceptEdits"
        || value.agent.permissionMode === "bypassPermissions"
        || value.agent.permissionMode === "plan"
        || value.agent.permissionMode === "dontAsk"
        ? { permissionMode: value.agent.permissionMode }
        : {}),
      ...(value.agent.thinkingLevel === "off"
        || value.agent.thinkingLevel === "low"
        || value.agent.thinkingLevel === "medium"
        || value.agent.thinkingLevel === "high"
        || value.agent.thinkingLevel === "max"
        ? { thinkingLevel: value.agent.thinkingLevel }
        : {})
    };
  }

  if (isPlainObject(value.providers)) {
    next.providers = value.providers;
  }

  if (isPlainObject(value.mcp)) {
    next.mcp = value.mcp;
  }

  if (isPlainObject(value.memory)) {
    next.memory = value.memory;
  }

  if (isPlainObject(value.skills)) {
    next.skills = {
      enabled: normalizeStringArray(value.skills.enabled),
      disabled: normalizeStringArray(value.skills.disabled)
    };
  }

  if (isPlainObject(value.plugins)) {
    next.plugins = {
      enabled: normalizeUniqueStringArray(value.plugins.enabled),
      directories: normalizeUniqueStringArray(value.plugins.directories)
    };
  }

  if (isPlainObject(value.permissions)) {
    const normalizedPermissions: NonNullable<LumeConfigSectionSet["permissions"]> = {};
    if (isPlainObject(value.permissions.toolPolicy)) {
      normalizedPermissions.toolPolicy = {
        allow: normalizeStringArray(value.permissions.toolPolicy.allow),
        deny: normalizeStringArray(value.permissions.toolPolicy.deny)
      };
    }
    normalizedPermissions.rules = normalizePermissionRules(value.permissions.rules);
    if (isPlainObject(value.permissions.classifier)) {
      normalizedPermissions.classifier = {
        ...(typeof value.permissions.classifier.enabled === "boolean"
          ? { enabled: value.permissions.classifier.enabled }
          : {})
      };
    }
    normalizedPermissions.privateWriteRoots = normalizeUniqueStringArray(value.permissions.privateWriteRoots);
    if (isPlainObject(value.permissions.approvals)) {
      normalizedPermissions.approvals = normalizePermissionApprovals(value.permissions.approvals);
    }
    next.permissions = normalizedPermissions;
  }

  if (isPlainObject(value.hooks)) {
    next.hooks = normalizeHooksSection(value.hooks);
  }

  if (isPlainObject(value.webSearch)) {
    next.webSearch = normalizeWebSearchSection(value.webSearch);
  }

  return next;
}

function normalizeLumeConfigFile(input: unknown): LumeConfigFile {
  const fallback = createDefaultLumeConfig();
  const fallbackToolPolicy = fallback.permissions?.toolPolicy ?? { allow: [], deny: [] };
  if (!isPlainObject(input)) {
    return fallback;
  }

  const base = normalizeSectionSet(input);
  const workspaces: Record<string, LumeConfigSectionSet> = {};
  if (isPlainObject(input.workspaces)) {
    for (const [slug, sectionSet] of Object.entries(input.workspaces)) {
      if (!slug.trim()) {
        continue;
      }
      workspaces[slug] = normalizeSectionSet(sectionSet);
    }
  }

  return {
    version: CONFIG_VERSION,
    models: {
      chat: {
        ...(fallback.models?.chat ?? {}),
        ...(base.models?.chat ?? {})
      },
      agent: {
        ...(fallback.models?.agent ?? {}),
        ...(base.models?.agent ?? {}),
        ...(base.models?.agent?.fallbackModelRefs !== undefined
          ? { fallbackModelRefs: base.models?.agent?.fallbackModelRefs }
          : {})
      },
      subagent: {
        ...(fallback.models?.subagent ?? {}),
        ...(base.models?.subagent ?? {})
      },
      embedding: {
        ...(fallback.models?.embedding ?? {}),
        ...(base.models?.embedding ?? {})
      }
    },
    agent: { ...fallback.agent, ...base.agent },
    providers: { ...fallback.providers, ...base.providers },
    mcp: { ...fallback.mcp, ...base.mcp },
    memory: { ...fallback.memory, ...base.memory },
    skills: { ...fallback.skills, ...base.skills },
    permissions: {
      ...fallback.permissions,
      ...base.permissions,
      toolPolicy: {
        ...fallbackToolPolicy,
        ...base.permissions?.toolPolicy
      },
      rules: base.permissions?.rules ?? fallback.permissions?.rules ?? [],
      classifier: {
        ...(fallback.permissions?.classifier ?? {}),
        ...(base.permissions?.classifier ?? {})
      },
      privateWriteRoots: base.permissions?.privateWriteRoots ?? fallback.permissions?.privateWriteRoots ?? [],
      approvals: mergePermissionApprovals(fallback.permissions?.approvals, base.permissions?.approvals)
    },
    hooks: {
      internal: {
        ...DEFAULT_INTERNAL_HOOKS,
        ...(base.hooks?.internal ?? {})
      }
    },
    webSearch: {
      ...(DEFAULT_LUME_WEB_SEARCH),
      ...(base.webSearch ?? {})
    },
    workspaces
  };
}

function readConfigFileContent(path: string): string {
  return readFileSync(path, "utf-8");
}

function writeYamlAtomic(path: string, payload: string): void {
  const tempPath = join(dirname(path), `lume.yaml.tmp.${Date.now()}`);
  const backupPath = join(dirname(path), "lume.yaml.bak");
  writeFileSync(tempPath, payload, "utf-8");
  if (existsSync(path)) {
    rmSync(backupPath, { force: true });
    renameSync(path, backupPath);
  }
  try {
    renameSync(tempPath, path);
    rmSync(backupPath, { force: true });
  } catch (error) {
    if (existsSync(backupPath)) {
      renameSync(backupPath, path);
    }
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
    throw error;
  }
}

function readOrCreateLumeConfig(): LumeConfigFile {
  const path = getLumeConfigYamlPath();
  if (!existsSync(path)) {
    const defaultConfig = createDefaultLumeConfig();
    writeYamlAtomic(path, YAML.stringify(defaultConfig));
    return defaultConfig;
  }

  try {
    const parsed = YAML.parse(readConfigFileContent(path)) as unknown;
    return normalizeLumeConfigFile(parsed);
  } catch (error) {
    console.warn("[Lume Config] 解析 lume.yaml 失败，回退默认配置:", error);
    return createDefaultLumeConfig();
  }
}

function ensureWorkspaceSection(
  file: LumeConfigFile,
  workspaceSlug: string
): LumeConfigSectionSet {
  if (!file.workspaces) {
    file.workspaces = {};
  }
  if (!file.workspaces[workspaceSlug]) {
    file.workspaces[workspaceSlug] = {};
  }
  return file.workspaces[workspaceSlug];
}

function assignPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path
    .split(".")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (segments.length === 0) {
    throw new Error("配置路径不能为空");
  }

  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) {
      throw new Error("配置路径非法");
    }
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new Error("配置路径非法");
    }
    const next = cursor[segment];
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error("配置路径非法");
  }
  if (last === "__proto__" || last === "prototype" || last === "constructor") {
    throw new Error("配置路径非法");
  }
  cursor[last] = value;
}

function appendAuditEntry(entry: LumeConfigAuditEntry): void {
  appendFileSync(getLumeConfigAuditPath(), `${JSON.stringify(entry)}\n`, "utf-8");
}

export function getEffectiveLumeConfig(workspaceSlug?: string): LumeEffectiveConfig {
  const file = readOrCreateLumeConfig();
  const overlay = workspaceSlug ? file.workspaces?.[workspaceSlug] : undefined;
  const effective: LumeEffectiveConfig = {
    version: CONFIG_VERSION,
    sourcePath: getLumeConfigYamlPath(),
    workspaceSlug,
    models: {
      chat: {
        ...(file.models?.chat ?? {}),
        ...(overlay?.models?.chat ?? {})
      },
      agent: {
        ...(file.models?.agent ?? {}),
        ...(overlay?.models?.agent ?? {}),
        ...(overlay?.models?.agent?.fallbackModelRefs !== undefined
          ? { fallbackModelRefs: overlay?.models?.agent?.fallbackModelRefs }
          : file.models?.agent?.fallbackModelRefs !== undefined
            ? { fallbackModelRefs: file.models?.agent?.fallbackModelRefs }
            : {})
      },
      subagent: {
        ...(file.models?.subagent ?? {}),
        ...(overlay?.models?.subagent ?? {})
      },
      embedding: {
        ...(file.models?.embedding ?? {}),
        ...(overlay?.models?.embedding ?? {})
      }
    },
    agent: {
      ...(file.agent ?? {}),
      ...(overlay?.agent ?? {})
    },
    providers: {
      ...(file.providers ?? {}),
      ...(overlay?.providers ?? {})
    },
    mcp: {
      ...(file.mcp ?? {}),
      ...(overlay?.mcp ?? {})
    },
    memory: {
      ...(file.memory ?? {}),
      ...(overlay?.memory ?? {})
    },
    skills: {
      ...(file.skills ?? {}),
      ...(overlay?.skills ?? {})
    },
    permissions: {
      ...(file.permissions ?? {}),
      toolPolicy: {
        ...(file.permissions?.toolPolicy ?? {}),
        ...(overlay?.permissions?.toolPolicy ?? {})
      },
      rules: [
        ...(file.permissions?.rules ?? []),
        ...(overlay?.permissions?.rules ?? [])
      ],
      classifier: {
        ...(file.permissions?.classifier ?? {}),
        ...(overlay?.permissions?.classifier ?? {})
      },
      privateWriteRoots: [
        ...(file.permissions?.privateWriteRoots ?? []),
        ...(overlay?.permissions?.privateWriteRoots ?? [])
      ],
      approvals: mergePermissionApprovals(file.permissions?.approvals, overlay?.permissions?.approvals)
    },
    hooks: {
      internal: {
        ...DEFAULT_INTERNAL_HOOKS,
        ...(file.hooks?.internal ?? {}),
        ...(overlay?.hooks?.internal ?? {})
      }
    },
    webSearch: {
      ...(file.webSearch ?? {}),
      ...(overlay?.webSearch ?? {}),
      providers: {
        ...(file.webSearch?.providers ?? {}),
        ...(overlay?.webSearch?.providers ?? {})
      }
    }
  };
  syncWebSearchEnvVars(effective.webSearch ?? {});
  return effective;
}

export function updateLumeConfigSection(input: UpdateLumeConfigSectionInput): LumeEffectiveConfig {
  const file = readOrCreateLumeConfig();
  const target = input.workspaceSlug
    ? ensureWorkspaceSection(file, input.workspaceSlug)
    : file;
  assignPath(target as Record<string, unknown>, input.path, input.value);
  const normalized = normalizeLumeConfigFile(file);
  writeYamlAtomic(getLumeConfigYamlPath(), YAML.stringify(normalized));

  appendAuditEntry({
    at: new Date().toISOString(),
    source: input.source,
    workspaceSlug: input.workspaceSlug,
    path: input.path,
    summary: input.summary?.trim() || `set ${input.path}`
  });

  return getEffectiveLumeConfig(input.workspaceSlug);
}
