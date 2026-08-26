import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
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
  type LumeConfigPluginEnablement,
  type LumeConfigPluginMarketSourceRef,
  type LumeConfigPermissionApprovalRoutes,
  type LumeConfigPermissionRule,
  type LumeConfigSectionSet,
  type LumeConfigSubagentApprovalPolicy,
  type LumeConfigWebSearchSection,
  type LumeEffectiveConfig,
  type WebSearchProvider
} from "@lume/shared";
import { getConfigDir, getLumeConfigAuditPath, getLumeConfigYamlPath } from "../infra/config-paths";
import { createLogger } from "../infra/logger";

interface UpdateLumeConfigSectionInput {
  source: LumeConfigAuditSource;
  workspaceSlug?: string;
  path: string;
  value: unknown;
  summary?: string;
}

const CONFIG_VERSION = 2;
/**
 * v2 迁移（#571 第 1 项）：v1 的规范化器把 classifier.enabled:false 无条件写进
 * 每份落盘配置，且该开关从未在设置 UI 露出——存量文件里的 false 全部是默认值
 * 写穿，不是用户选择。升级后一次性翻转为新默认（启用），并把 version 推到 2；
 * 此后用户显式改回 false 不再被触碰。workspace overlay 不参与迁移。
 * 约束：CONFIG_VERSION 必须 ≥ 所有迁移门版本（后续升代时同步本注释）。
 */
const CLASSIFIER_DEFAULT_MIGRATION_VERSION = 2;
const log = createLogger("lume-config");
const OFFICIAL_PLUGIN_MARKET_SOURCE: LumeConfigPluginMarketSourceRef = {
  id: "official",
  name: "Lume Plugins",
  kind: "remote-index",
  enabled: true,
  url: "https://github.com/CavinHuang/lume-plugins",
  mirrorUrl: "https://lume-plugin.mrhuang.site"
};
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
      global: {
        enabled: [],
        disabled: []
      },
      workspaces: {},
      directories: [],
      marketSources: [{ ...OFFICIAL_PLUGIN_MARKET_SOURCE }]
    },
    permissions: {
      toolPolicy: {
        allow: [],
        deny: []
      },
      rules: [],
      classifier: {
        enabled: true
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

function normalizeModelStrategy(value: unknown): { defaultModelRef?: string } {
  if (!isPlainObject(value)) return {};
  const defaultModelRef = normalizeOptionalString(value.defaultModelRef);
  return defaultModelRef ? { defaultModelRef } : {};
}

function normalizeAdvisorStrategy(value: unknown): { enabled?: boolean; defaultModelRef?: string } {
  if (!isPlainObject(value)) return {};
  const defaultModelRef = normalizeOptionalString(value.defaultModelRef);
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(defaultModelRef ? { defaultModelRef } : {})
  };
}

function normalizeImageGenerationStrategy(value: unknown): { priorityModelRefs?: string[] } {
  if (!isPlainObject(value)) return {};
  const priorityModelRefs = normalizeUniqueStringArray(value.priorityModelRefs);
  return {
    ...(priorityModelRefs.length > 0 ? { priorityModelRefs } : {})
  };
}

function normalizeComputerUseStrategy(value: unknown): {
  agentSurface?: "auto" | "sky" | "mcp";
  skyModelRefs?: string[];
  visionModelRefs?: string[];
} {
  if (!isPlainObject(value)) return {};
  const agentSurface = value.agentSurface === "auto" || value.agentSurface === "sky" || value.agentSurface === "mcp"
    ? value.agentSurface
    : undefined;
  const skyModelRefs = normalizeUniqueStringArray(value.skyModelRefs);
  const visionModelRefs = normalizeUniqueStringArray(value.visionModelRefs);
  return {
    ...(agentSurface ? { agentSurface } : {}),
    ...(skyModelRefs.length > 0 ? { skyModelRefs } : {}),
    ...(visionModelRefs.length > 0 ? { visionModelRefs } : {})
  };
}

function normalizeContextWindows(value: unknown): Record<string, number> | undefined {
  if (!isPlainObject(value)) return undefined;
  const next: Record<string, number> = {};
  for (const [modelRef, tokens] of Object.entries(value)) {
    const key = normalizeOptionalString(modelRef);
    if (!key || typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0) continue;
    next[key] = tokens;
  }
  return Object.keys(next).length > 0 ? next : undefined;
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

function normalizePluginEnablement(value: unknown): LumeConfigPluginEnablement {
  if (!isPlainObject(value)) {
    return { enabled: [], disabled: [] };
  }
  return {
    enabled: normalizeUniqueStringArray(value.enabled),
    disabled: normalizeUniqueStringArray(value.disabled)
  };
}

function normalizePluginMarketSources(value: unknown): LumeConfigPluginMarketSourceRef[] {
  const sources: LumeConfigPluginMarketSourceRef[] = [{ ...OFFICIAL_PLUGIN_MARKET_SOURCE }];
  if (!Array.isArray(value)) return sources;
  const seen = new Set<string>([OFFICIAL_PLUGIN_MARKET_SOURCE.id]);
  let officialConfigured = false;
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const id = normalizeOptionalString(item.id);
    if (id === OFFICIAL_PLUGIN_MARKET_SOURCE.id) {
      if (!officialConfigured) {
        const mirrorUrl = normalizeOptionalString(item.mirrorUrl);
        sources[0] = {
          ...OFFICIAL_PLUGIN_MARKET_SOURCE,
          enabled: item.enabled !== false,
          ...(mirrorUrl ? { mirrorUrl } : {})
        };
        officialConfigured = true;
      }
      continue;
    }
    const name = normalizeOptionalString(item.name);
    const kind = item.kind === "local-index" || item.kind === "remote-index" ? item.kind : undefined;
    if (!id || !name || !kind || seen.has(id)) continue;
    const url = normalizeOptionalString(item.url);
    const path = normalizeOptionalString(item.path);
    const mirrorUrl = normalizeOptionalString(item.mirrorUrl);
    if (kind === "remote-index" && !url) continue;
    if (kind === "local-index" && !path) continue;
    sources.push({
      id,
      name,
      kind,
      enabled: item.enabled !== false,
      ...(url ? { url } : {}),
      ...(path ? { path } : {}),
      ...(mirrorUrl ? { mirrorUrl } : {})
    });
    seen.add(id);
  }
  return sources;
}

function normalizePluginsSection(value: unknown): NonNullable<LumeConfigSectionSet["plugins"]> {
  if (!isPlainObject(value)) {
    return {
      global: { enabled: [], disabled: [] },
      workspaces: {},
      directories: [],
      marketSources: []
    };
  }

  const legacyEnabled = normalizeUniqueStringArray(value.enabled);
  const legacyDisabled = normalizeUniqueStringArray(value.disabled);
  const explicitGlobal = normalizePluginEnablement(value.global);
  const global = {
    enabled: explicitGlobal.enabled?.length ? explicitGlobal.enabled : legacyEnabled,
    disabled: explicitGlobal.disabled?.length ? explicitGlobal.disabled : legacyDisabled
  };
  const workspaces: Record<string, LumeConfigPluginEnablement> = {};
  if (isPlainObject(value.workspaces)) {
    for (const [slug, enablement] of Object.entries(value.workspaces)) {
      const normalizedSlug = slug.trim();
      if (!normalizedSlug) continue;
      workspaces[normalizedSlug] = normalizePluginEnablement(enablement);
    }
  }

  return {
    global,
    workspaces,
    directories: normalizeUniqueStringArray(value.directories),
    marketSources: normalizePluginMarketSources(value.marketSources)
  };
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

const WEB_SEARCH_PROVIDER_KEYS: WebSearchProvider[] = ["exa", "pipellm", "zhipu", "tavily", "brave", "duckduckgo", "bing"];

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
  const enabledProviders = WEB_SEARCH_PROVIDER_KEYS.filter((provider) => providers[provider]?.enabled === true);
  process.env.LUME_WEB_SEARCH_PROVIDERS = enabledProviders.join(",");

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

export const KNOWN_LUME_SECTION_KEYS: readonly string[] = [
  "models", "agent", "providers", "mcp", "memory", "skills", "plugins", "permissions", "hooks", "webSearch",
  // 顶层文件段(LumeConfigFile),normalizeLumeConfigFile 消费
  "version", "workspaces",
];
const KNOWN_AGENT_KEYS = new Set(["permissionMode", "thinkingLevel", "followUpQueueMode", "maxAutoTurnContinuations"]);

function normalizeSectionSet(value: unknown): LumeConfigSectionSet {
  if (!isPlainObject(value)) {
    return {};
  }
  const next: LumeConfigSectionSet = {};
  const knownSections = new Set(KNOWN_LUME_SECTION_KEYS);
  const droppedTopKeys = Object.keys(value).filter((key) => !knownSections.has(key));
  const droppedAgentKeys = isPlainObject(value.agent)
    ? Object.keys(value.agent).filter((key) => !KNOWN_AGENT_KEYS.has(key))
    : [];
  if (droppedTopKeys.length > 0 || droppedAgentKeys.length > 0) {
    log.warn("lume.yaml 含未识别配置键，规范化时已移除（升级 sidecar 或修正拼写）", {
      ...(droppedTopKeys.length > 0 ? { unknownSections: droppedTopKeys } : {}),
      ...(droppedAgentKeys.length > 0 ? { unknownAgentKeys: droppedAgentKeys } : {})
    });
  }

  if (isPlainObject(value.models)) {
    const chat = isPlainObject(value.models.chat) ? value.models.chat : {};
    const agent = isPlainObject(value.models.agent) ? value.models.agent : {};
    const subagent = isPlainObject(value.models.subagent) ? value.models.subagent : {};
    const routine = isPlainObject(value.models.routine) ? value.models.routine : {};
    const embedding = isPlainObject(value.models.embedding) ? value.models.embedding : {};
    const agentDefaultChannelId = normalizeOptionalString(agent.defaultChannelId);
    const agentDefaultModelRef = normalizeOptionalString(agent.defaultModelRef);
    const subagentDefaultModelRef = normalizeOptionalString(subagent.defaultModelRef);
    const routineDefaultModelRef = normalizeOptionalString(routine.defaultModelRef);
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
      routine: {
        ...(routineDefaultModelRef
          ? { defaultModelRef: routineDefaultModelRef }
          : {})
      },
      background: normalizeModelStrategy(value.models.background),
      contextCompression: normalizeModelStrategy(value.models.contextCompression),
      title: normalizeModelStrategy(value.models.title),
      welcomeSuggestions: normalizeModelStrategy(value.models.welcomeSuggestions),
      permissionClassifier: normalizeModelStrategy(value.models.permissionClassifier),
      memoryJudgement: normalizeModelStrategy(value.models.memoryJudgement),
      advisor: normalizeAdvisorStrategy(value.models.advisor),
      imageGeneration: normalizeImageGenerationStrategy(value.models.imageGeneration),
      computerUse: normalizeComputerUseStrategy(value.models.computerUse),
      ...(normalizeContextWindows(value.models.contextWindows)
        ? { contextWindows: normalizeContextWindows(value.models.contextWindows) }
        : {}),
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
        : {}),
      ...(typeof value.agent.projectInstructionsEnabled === "boolean"
        ? { projectInstructionsEnabled: value.agent.projectInstructionsEnabled }
        : {}),
      // followUpQueueMode 是白名单陷阱的预存同族受害者：web 设置页经 get-effective
      // 读取（AgentInput.tsx:444），白名单缺失使配置恒回落默认 'queue'（#566 review）
      ...(value.agent.followUpQueueMode === "steer"
        || value.agent.followUpQueueMode === "queue"
        || value.agent.followUpQueueMode === "interrupt"
        ? { followUpQueueMode: value.agent.followUpQueueMode }
        : {}),
      ...(typeof value.agent.maxAutoTurnContinuations === "number"
        && Number.isFinite(value.agent.maxAutoTurnContinuations)
        && value.agent.maxAutoTurnContinuations >= 0
        ? { maxAutoTurnContinuations: Math.min(Math.floor(value.agent.maxAutoTurnContinuations), 10) }
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
    next.plugins = normalizePluginsSection(value.plugins);
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

/**
 * v2 一次性迁移：仅当磁盘文件版本早于 CLASSIFIER_DEFAULT_MIGRATION_VERSION 且
 * 顶层 classifier.enabled 落着 false（v1 规范化器写穿的默认值）时翻转为 true。
 * 只作用于顶层文件段；workspace overlay 是显式配置，不参与。
 */
function migrateClassifierDefault(
  permissions: NonNullable<LumeConfigSectionSet["permissions"]>,
  rawFile: unknown
): NonNullable<LumeConfigSectionSet["permissions"]> {
  const rawVersion = isPlainObject(rawFile) && typeof rawFile.version === "number" ? rawFile.version : 0;
  if (rawVersion >= CLASSIFIER_DEFAULT_MIGRATION_VERSION) return permissions;
  if (permissions.classifier?.enabled !== false) return permissions;
  log.info("migrating legacy classifier.enabled=false to new default (enabled)");
  // 审计条目由 readOrCreateLumeConfig 在写盘成功后经 appendMigrationAuditAfterWrite
  // 追加（#706）：此处追加会在写失败时记录未发生的翻转、写持续失败时逐读重复。
  return { ...permissions, classifier: { ...permissions.classifier, enabled: true } };
}

function normalizeLumeConfigFile(input: unknown): LumeConfigFile {
  const fallback = createDefaultLumeConfig();
  const fallbackToolPolicy = fallback.permissions?.toolPolicy ?? { allow: [], deny: [] };
  if (!isPlainObject(input)) {
    return fallback;
  }

  const base = normalizeSectionSet(input);
  const workspaces: Record<string, LumeConfigSectionSet> = {};
  const migratedPluginWorkspaces: Record<string, LumeConfigPluginEnablement> = {};
  if (isPlainObject(input.workspaces)) {
    for (const [slug, sectionSet] of Object.entries(input.workspaces)) {
      if (!slug.trim()) {
        continue;
      }
      const normalizedWorkspace = normalizeSectionSet(sectionSet);
      if (isPlainObject(sectionSet) && isPlainObject(sectionSet.plugins)) {
        const legacyWorkspacePlugins = sectionSet.plugins;
        if (Array.isArray(legacyWorkspacePlugins.enabled) || Array.isArray(legacyWorkspacePlugins.disabled)) {
          migratedPluginWorkspaces[slug] = normalizePluginEnablement(legacyWorkspacePlugins);
          delete normalizedWorkspace.plugins;
        }
      }
      workspaces[slug] = normalizedWorkspace;
    }
  }
  const plugins = {
    ...(fallback.plugins ?? {}),
    ...(base.plugins ?? {}),
    global: {
      ...(fallback.plugins?.global ?? {}),
      ...(base.plugins?.global ?? {})
    },
    workspaces: {
      ...(base.plugins?.workspaces ?? {}),
      ...migratedPluginWorkspaces
    },
    directories: base.plugins?.directories ?? fallback.plugins?.directories ?? [],
    marketSources: base.plugins?.marketSources ?? fallback.plugins?.marketSources ?? []
  };

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
      routine: {
        ...(fallback.models?.routine ?? {}),
        ...(base.models?.routine ?? {})
      },
      background: {
        ...(fallback.models?.background ?? {}),
        ...(base.models?.background ?? {})
      },
      contextCompression: {
        ...(fallback.models?.contextCompression ?? {}),
        ...(base.models?.contextCompression ?? {})
      },
      title: {
        ...(fallback.models?.title ?? {}),
        ...(base.models?.title ?? {})
      },
      welcomeSuggestions: {
        ...(fallback.models?.welcomeSuggestions ?? {}),
        ...(base.models?.welcomeSuggestions ?? {})
      },
      permissionClassifier: {
        ...(fallback.models?.permissionClassifier ?? {}),
        ...(base.models?.permissionClassifier ?? {})
      },
      memoryJudgement: {
        ...(fallback.models?.memoryJudgement ?? {}),
        ...(base.models?.memoryJudgement ?? {})
      },
      advisor: {
        ...(fallback.models?.advisor ?? {}),
        ...(base.models?.advisor ?? {})
      },
      imageGeneration: {
        ...(fallback.models?.imageGeneration ?? {}),
        ...(base.models?.imageGeneration ?? {})
      },
      computerUse: {
        ...(fallback.models?.computerUse ?? {}),
        ...(base.models?.computerUse ?? {})
      },
      contextWindows: {
        ...(fallback.models?.contextWindows ?? {}),
        ...(base.models?.contextWindows ?? {})
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
    plugins,
    permissions: migrateClassifierDefault({
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
    }, input),
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

function writeYamlAtomic(path: string, payload: string): { mtimeMs: number; size: number; ino: number } {
  const dir = dirname(path);
  // tmp 名带 pid+随机串（#706）：裸 Date.now() 双进程同毫秒写互相碰撞，输家
  // 的 rename 撞 ENOENT 后被外层吞掉、调用方静默拿到出厂默认配置。
  const tempPath = join(dir, `lume.yaml.tmp.${process.pid}.${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(tempPath, payload, "utf-8");
    // 不做 .bak 备份（#727 review 实证）：全仓零读取消费方，纯仪式开销；
    // 崩溃恢复语义由「读失败回退默认 + 下次惰性规范化重写」承接。
    // 单次原子 rename 使 path 全程存在，无并发缺失窗口。
    // 指纹在 rename 前对 tmp 自身采样（#727 review）：rename 后再 stat 可能采到
    // 并发后继写者的 inode/mtime，造成「值=本次、指纹=他人」的缓存遮蔽窗口。
    const stats = statSync(tempPath);
    const fingerprint = { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
    renameSync(tempPath, path);
    // 防呆钉（#729 review 并发方向）：此处已过 rename 成功点，try 尾段任何
    // 抛错都会把磁盘新值报成失败（幽灵失败）——sweep 自身双层 catch 永不抛，
    // 未来改动必须维持该性质或移出 try。
    sweepStaleConfigTemps(dir);
    return fingerprint;
  } catch (error) {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    throw error;
  }
}

/** 清理崩溃写者遗留的孤儿 tmp：唯一命名后不再有同名自愈，需显式清扫（#706）。 */
const CONFIG_TMP_PREFIX = "lume.yaml.tmp.";
const CONFIG_TMP_MAX_AGE_MS = 60 * 60 * 1000;

function sweepStaleConfigTemps(dir: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(CONFIG_TMP_PREFIX)) continue;
      const fullPath = join(dir, entry);
      try {
        if (Date.now() - statSync(fullPath).mtimeMs > CONFIG_TMP_MAX_AGE_MS) {
          rmSync(fullPath, { force: true });
        }
      } catch {
        // 单个条目清扫失败不阻塞主流程
      }
    }
  } catch {
    // 目录不可读时跳过清扫
  }
}

// lume.yaml 读取缓存：getEffectiveLumeConfig 调用面 48 处且多数在 run 热路径，
// 每次全量读盘 + YAML.parse/stringify。以 path 为键（getLumeConfigYamlPath 实时读
// LUME_CONFIG_DIR，测试同进程切目录时仅指纹可能跨目录同值串缓存）；键在写盘之后
// 采样（normalize 写盘会改 mtime，读前采样则永久 miss）。指纹为 mtime+size+ino
// 三要素：跨进程写盘走 tmp+rename（每次新 inode），仅靠 mtime+size 兜底时，粗粒度
// 时间戳文件系统（Linux jiffy 粒度）上同 tick 的两连写可被误判未变——被遮蔽的若是
// 最后一次写，stale 配置将伴随进程存活期（#622 配方）。
// 返回对象是缓存共享引用：调用方不得原地修改——唯一 mutate 方 updateLumeConfigSection
// 写盘后 refresh 覆盖，最终一致。
const lumeConfigCache = new Map<string, { mtimeMs: number; size: number; ino: number; value: LumeConfigFile }>();

function refreshLumeConfigCache(
  path: string,
  value: LumeConfigFile,
  /** 写盘方在 rename 前采样的指纹：传入则免二次 stat，消除「值与指纹错位」遮蔽窗口 */
  fingerprint?: { mtimeMs: number; size: number; ino: number },
): void {
  try {
    const stats = fingerprint ?? statSync(path);
    lumeConfigCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, value });
  } catch {
    lumeConfigCache.delete(path);
  }
}

function readOrCreateLumeConfig(retried?: boolean): LumeConfigFile {
  const path = getLumeConfigYamlPath();
  if (!existsSync(path)) {
    const defaultConfig = createDefaultLumeConfig();
    const fingerprint = writeYamlAtomic(path, YAML.stringify(defaultConfig));
    refreshLumeConfigCache(path, defaultConfig, fingerprint);
    return defaultConfig;
  }

  try {
    const cached = lumeConfigCache.get(path);
    if (cached) {
      const stats = statSync(path);
      if (cached.mtimeMs === stats.mtimeMs && cached.size === stats.size && cached.ino === stats.ino) {
        return cached.value;
      }
    }
    const raw = readConfigFileContent(path);
    const rawParsed = YAML.parse(raw) as unknown;
    const normalized = normalizeLumeConfigFile(rawParsed);
    const normalizedYaml = YAML.stringify(normalized);
    // 仅当规范化结果与磁盘内容不一致时才落盘，避免重复读取触发 workspace-watcher
    // 的 lume-config:changed 事件，进而造成 get-effective ↔ 文件监听的无限回环
    if (normalizedYaml !== raw) {
      const fingerprint = writeYamlAtomic(path, normalizedYaml);
      appendMigrationAuditAfterWrite(rawParsed);
      refreshLumeConfigCache(path, normalized, fingerprint);
      return normalized;
    }
    refreshLumeConfigCache(path, normalized);
    return normalized;
  } catch (error) {
    // fs 瞬态与解析损坏区分（#706）：ENOENT 多为并发窗口/刚被并发写者换名，
    // 重试一次读最新；重试仍失败或其余错误按解析损坏回退默认并如实记日志。
    if (!retried && (error as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.warn("transient fs error reading lume.yaml; retrying once", { error });
      try {
        if (existsSync(path)) return readOrCreateLumeConfig(true);
      } catch (retryError) {
        log.warn("lume.yaml retry failed; using default config", { error: retryError });
        return createDefaultLumeConfig();
      }
    }
    log.warn("failed to parse lume.yaml; using default config", { error });
    return createDefaultLumeConfig();
  }
}

/**
 * v1→v2 迁移审计移到写盘成功之后（#706 同单顺修）：原先在 normalize 内追加，
 * 写失败则记录了未发生的翻转、写持续失败时每次读取重复追加。此处以 raw 文件
 * 的触发条件复判——仅当本次读取真正完成磁盘翻转才记一条；成功后下次读取
 * raw 已是 v2，天然防重。
 */
function appendMigrationAuditAfterWrite(rawFile: unknown): void {
  if (!isPlainObject(rawFile)) return;
  const rawVersion = typeof rawFile.version === "number" ? rawFile.version : 0;
  if (rawVersion >= CLASSIFIER_DEFAULT_MIGRATION_VERSION) return;
  // 肯定式守卫与 migrateClassifierDefault 翻转条件严格同形：classifier 段缺失/
  // 非对象时 normalize 走的是兜底合并而非「false→true」翻转，记迁移审计即虚记
  // （#727 review 并发方向 P2）。
  if (!isPlainObject(rawFile.permissions)) return;
  const classifier = rawFile.permissions.classifier;
  if (!isPlainObject(classifier) || classifier.enabled !== false) return;
  appendAuditEntry({
    at: new Date().toISOString(),
    source: "system",
    path: "permissions.classifier.enabled",
    summary: "v2 迁移：存量默认值 false 翻转为新默认 true（#571）"
  });
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
      routine: {
        ...(file.models?.routine ?? {}),
        ...(overlay?.models?.routine ?? {})
      },
      background: {
        ...(file.models?.background ?? {}),
        ...(overlay?.models?.background ?? {})
      },
      contextCompression: {
        ...(file.models?.contextCompression ?? {}),
        ...(overlay?.models?.contextCompression ?? {})
      },
      title: {
        ...(file.models?.title ?? {}),
        ...(overlay?.models?.title ?? {})
      },
      welcomeSuggestions: {
        ...(file.models?.welcomeSuggestions ?? {}),
        ...(overlay?.models?.welcomeSuggestions ?? {})
      },
      permissionClassifier: {
        ...(file.models?.permissionClassifier ?? {}),
        ...(overlay?.models?.permissionClassifier ?? {})
      },
      memoryJudgement: {
        ...(file.models?.memoryJudgement ?? {}),
        ...(overlay?.models?.memoryJudgement ?? {})
      },
      advisor: {
        ...(file.models?.advisor ?? {}),
        ...(overlay?.models?.advisor ?? {})
      },
      imageGeneration: {
        ...(file.models?.imageGeneration ?? {}),
        ...(overlay?.models?.imageGeneration ?? {})
      },
      computerUse: {
        ...(file.models?.computerUse ?? {}),
        ...(overlay?.models?.computerUse ?? {})
      },
      contextWindows: {
        ...(file.models?.contextWindows ?? {}),
        ...(overlay?.models?.contextWindows ?? {})
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
    plugins: {
      ...(file.plugins ?? {}),
      global: {
        ...(file.plugins?.global ?? {})
      },
      workspaces: {
        ...(file.plugins?.workspaces ?? {})
      },
      directories: file.plugins?.directories ?? [],
      marketSources: file.plugins?.marketSources ?? []
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

export interface EffectivePluginRuntimeConfig {
  enabled: string[];
  disabled: string[];
  directories: string[];
  marketSources: LumeConfigPluginMarketSourceRef[];
}

function mergeUnique(left?: string[], right?: string[]): string[] {
  return normalizeUniqueStringArray([...(left ?? []), ...(right ?? [])]);
}

export function getEffectivePluginRuntimeConfig(workspaceSlug?: string): EffectivePluginRuntimeConfig {
  const config = getEffectiveLumeConfig(workspaceSlug);
  const global = config.plugins?.global ?? {};
  const workspace = workspaceSlug ? config.plugins?.workspaces?.[workspaceSlug] : undefined;
  const disabled = mergeUnique(global.disabled, workspace?.disabled);
  const disabledSet = new Set(disabled);
  const enabled = mergeUnique(global.enabled, workspace?.enabled).filter((pluginId) => !disabledSet.has(pluginId));
  return {
    enabled,
    disabled,
    directories: normalizeUniqueStringArray(config.plugins?.directories),
    marketSources: (config.plugins?.marketSources ?? [])
      .filter((source) => source.enabled !== false)
      .map((source) => source.id === "official" && process.env.LUME_PLUGIN_MARKET_MIRROR_URL?.trim()
        ? { ...source, mirrorUrl: process.env.LUME_PLUGIN_MARKET_MIRROR_URL.trim() }
        : source)
  };
}

export function updateLumeConfigSection(input: UpdateLumeConfigSectionInput): LumeEffectiveConfig {
  const file = readOrCreateLumeConfig();
  // 深拷贝后再 mutate：直接改缓存共享引用时，一旦写盘失败（EACCES/磁盘满），
  // 缓存将持有从未落盘的幻影配置且按 mtime+size 判定"有效"（#406）
  const working = structuredClone(file);
  const target = input.workspaceSlug
    ? ensureWorkspaceSection(working, input.workspaceSlug)
    : working;
  assignPath(target as Record<string, unknown>, input.path, input.value);
  const normalized = normalizeLumeConfigFile(working);
  const fingerprint = writeYamlAtomic(getLumeConfigYamlPath(), YAML.stringify(normalized));
  // 以落盘内容+rename 前指纹刷新缓存（值与指纹保证同源，#727 review）
  refreshLumeConfigCache(getLumeConfigYamlPath(), normalized, fingerprint);

  appendAuditEntry({
    at: new Date().toISOString(),
    source: input.source,
    workspaceSlug: input.workspaceSlug,
    path: input.path,
    summary: input.summary?.trim() || `set ${input.path}`
  });

  return getEffectiveLumeConfig(input.workspaceSlug);
}
