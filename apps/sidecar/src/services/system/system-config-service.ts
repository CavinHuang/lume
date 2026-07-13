import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EffectiveSystemConfig, LumeSystemConfig } from "@lume/shared";
import { getLumeJsonPath } from "../infra/config-paths";
import { getEffectiveLumeConfig } from "./lume-config-service";

const SYSTEM_CONFIG_VERSION = 1;

function createDefaultSystemConfig(): LumeSystemConfig {
  return {
    version: SYSTEM_CONFIG_VERSION,
    models: {
      chat: {},
      agent: {},
      embedding: {},
      computerUse: { visionModelRefs: [] }
    },
    memory: {},
    agent: {},
    automation: {},
    prompts: {},
    tools: {}
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonAtomic(path: string, payload: string): void {
  const tempPath = join(dirname(path), `lume.json.tmp.${Date.now()}`);
  writeFileSync(tempPath, payload, "utf-8");
  renameSync(tempPath, path);
}

function assignPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").map((item) => item.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new Error("配置路径不能为空");
  }
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment || segment === "__proto__" || segment === "prototype" || segment === "constructor") {
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
  if (!last || last === "__proto__" || last === "prototype" || last === "constructor") {
    throw new Error("配置路径非法");
  }
  cursor[last] = value;
}

function normalizeSystemConfig(input: unknown): LumeSystemConfig {
  const fallback = createDefaultSystemConfig();
  if (!isPlainObject(input)) {
    return fallback;
  }
  const models = isPlainObject(input.models) ? input.models : {};
  const chat = isPlainObject(models.chat) ? models.chat : {};
  const agent = isPlainObject(models.agent) ? models.agent : {};
  const embedding = isPlainObject(models.embedding) ? models.embedding : {};
  const computerUse = isPlainObject(models.computerUse) ? models.computerUse : {};

  return {
    version: SYSTEM_CONFIG_VERSION,
    models: {
      chat: {
        ...(typeof chat.defaultModelRef === "string"
          ? { defaultModelRef: chat.defaultModelRef }
          : {})
      },
      agent: {
        ...(typeof agent.defaultModelRef === "string"
          ? { defaultModelRef: agent.defaultModelRef }
          : {})
      },
      embedding: {
        ...(typeof embedding.defaultModelRef === "string"
          ? { defaultModelRef: embedding.defaultModelRef }
          : {})
      },
      computerUse: {
        visionModelRefs: Array.isArray(computerUse.visionModelRefs)
          ? computerUse.visionModelRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : []
      }
    },
    memory: isPlainObject(input.memory) ? input.memory : {},
    agent: isPlainObject(input.agent) ? input.agent : {},
    automation: isPlainObject(input.automation) ? input.automation : {},
    prompts: isPlainObject(input.prompts) ? input.prompts : {},
    tools: isPlainObject(input.tools) ? input.tools : {}
  };
}

function readOrCreatePrimarySystemConfig(): LumeSystemConfig {
  const path = getLumeJsonPath();
  if (!existsSync(path)) {
    const defaults = createDefaultSystemConfig();
    writeJsonAtomic(path, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    return normalizeSystemConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    console.warn("[System Config] 读取 lume.json 失败，回退默认配置:", error);
    return createDefaultSystemConfig();
  }
}

export function getPrimarySystemConfig(): LumeSystemConfig {
  return readOrCreatePrimarySystemConfig();
}

export function updatePrimarySystemConfigSection(input: {
  path: string;
  value: unknown;
}): LumeSystemConfig {
  const config = readOrCreatePrimarySystemConfig();
  assignPath(config as unknown as Record<string, unknown>, input.path, input.value);
  const normalized = normalizeSystemConfig(config);
  writeJsonAtomic(getLumeJsonPath(), JSON.stringify(normalized, null, 2));
  return normalized;
}

export function getEffectiveSystemConfig(workspaceSlug?: string): EffectiveSystemConfig {
  const primary = getPrimarySystemConfig();
  const override = getEffectiveLumeConfig(workspaceSlug);

  const overrideModels = isPlainObject(override.models) ? override.models : {};
  const overrideChat = isPlainObject(overrideModels.chat) ? overrideModels.chat : {};
  const overrideAgent = isPlainObject(overrideModels.agent) ? overrideModels.agent : {};
  const overrideEmbedding = isPlainObject(overrideModels.embedding) ? overrideModels.embedding : {};
  const overrideComputerUse = isPlainObject(overrideModels.computerUse) ? overrideModels.computerUse : {};

  return {
    version: SYSTEM_CONFIG_VERSION,
    models: {
      ...(primary.models ?? {}),
      chat: {
        ...(primary.models?.chat ?? {}),
        ...(typeof overrideChat.defaultModelRef === "string"
          ? { defaultModelRef: overrideChat.defaultModelRef }
          : {})
      },
      agent: {
        ...(primary.models?.agent ?? {}),
        ...(typeof overrideAgent.defaultModelRef === "string"
          ? { defaultModelRef: overrideAgent.defaultModelRef }
          : {})
      },
      embedding: {
        ...(primary.models?.embedding ?? {}),
        ...(typeof overrideEmbedding.defaultModelRef === "string"
          ? { defaultModelRef: overrideEmbedding.defaultModelRef }
          : {})
      },
      computerUse: {
        ...primary.models?.computerUse,
        ...(Array.isArray(overrideComputerUse.visionModelRefs)
          ? { visionModelRefs: overrideComputerUse.visionModelRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0) }
          : {})
      }
    },
    memory: {
      ...(primary.memory ?? {}),
      ...(isPlainObject(override.memory) ? override.memory : {})
    },
    agent: {
      ...(primary.agent ?? {}),
      ...(isPlainObject(override.agent) ? override.agent : {})
    },
    automation: {
      ...(primary.automation ?? {})
    },
    prompts: {
      ...(primary.prompts ?? {})
    },
    tools: {
      ...(primary.tools ?? {})
    }
  };
}
