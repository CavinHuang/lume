import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type {
  LumeConfigAuditEntry,
  LumeConfigAuditSource,
  LumeConfigFile,
  LumeConfigSectionSet,
  LumeEffectiveConfig
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

function createDefaultLumeConfig(): LumeConfigFile {
  return {
    version: CONFIG_VERSION,
    agent: {},
    providers: {},
    mcp: {},
    skills: {
      enabled: [],
      disabled: []
    },
    permissions: {
      toolPolicy: {
        allow: [],
        deny: []
      }
    },
    workspaces: {}
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

  if (isPlainObject(value.permissions)) {
    const normalizedPermissions: NonNullable<LumeConfigSectionSet["permissions"]> = {};
    if (isPlainObject(value.permissions.toolPolicy)) {
      normalizedPermissions.toolPolicy = {
        allow: normalizeStringArray(value.permissions.toolPolicy.allow),
        deny: normalizeStringArray(value.permissions.toolPolicy.deny)
      };
    }
    next.permissions = normalizedPermissions;
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
      }
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
  return {
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
      }
    }
  };
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
