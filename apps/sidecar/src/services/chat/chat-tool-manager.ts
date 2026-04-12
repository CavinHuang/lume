import type {
  ChatToolInfo,
  ChatToolMeta,
  ChatToolState,
  ChatToolTestResult
} from "@lume/shared";
import {
  assertKnownToolId,
  getAllChatToolInfosFromConfig,
  getAllToolMetas,
  getBuiltinChatTools,
  isToolAvailable,
  readChatToolConfig,
  updateChatToolConfig
} from "./chat-tool-config-store";
import { testChatTool } from "./chat-tool-test-service";

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value && value.trim()) {
    process.env[key] = value.trim();
  } else {
    delete process.env[key];
  }
}

export function syncSharedSearchToolCredentials(): void {
  const credentials = getChatToolCredentials("web_search");
  setOptionalEnv("LUME_BRAVE_API_KEY", credentials.braveApiKey);
  setOptionalEnv("BRAVE_API_KEY", credentials.braveApiKey);
  setOptionalEnv("LUME_TAVILY_API_KEY", credentials.tavilyApiKey);
  setOptionalEnv("TAVILY_API_KEY", credentials.tavilyApiKey);
}

export function getAllChatToolInfos(): ChatToolInfo[] {
  const config = readChatToolConfig();
  return getAllChatToolInfosFromConfig(config);
}

export function getEnabledChatToolMetas(enabledToolIds?: string[]): ChatToolMeta[] {
  const config = readChatToolConfig();
  const allMetas = getAllToolMetas(config);
  const explicitIds = enabledToolIds?.filter((item) => typeof item === "string");
  const explicitSet = new Set(explicitIds ?? []);

  return allMetas.filter((meta) => {
    const enabledByUser = explicitIds === undefined
      ? config.toolStates[meta.id]?.enabled === true
      : explicitSet.has(meta.id);
    if (!enabledByUser) return false;
    const credentials = config.toolCredentials[meta.id] ?? {};
    return isToolAvailable(meta, credentials);
  });
}

export function getEnabledChatToolSystemPromptAppend(enabledToolIds?: string[]): string | undefined {
  const parts = getEnabledChatToolMetas(enabledToolIds)
    .map((meta) => meta.systemPromptAppend?.trim())
    .filter((item): item is string => !!item && item.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function getChatToolCredentials(toolId: string): Record<string, string> {
  const config = assertKnownToolId(toolId);
  return { ...(config.toolCredentials[toolId] ?? {}) };
}

export function updateChatToolState(toolId: string, state: ChatToolState): void {
  const config = assertKnownToolId(toolId);
  config.toolStates[toolId] = { enabled: state.enabled === true };
  updateChatToolConfig(config);
}

export function updateChatToolCredentials(toolId: string, credentials: Record<string, string>): void {
  const config = assertKnownToolId(toolId);
  const next = Object.entries(credentials)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key, value.trim()] as const)
    .filter((entry) => entry[1].length > 0);
  config.toolCredentials[toolId] = Object.fromEntries(next);
  updateChatToolConfig(config);
  if (toolId === "web_search") {
    syncSharedSearchToolCredentials();
  }
}

export function createCustomChatTool(meta: ChatToolMeta): void {
  const config = readChatToolConfig();
  const currentIds = new Set(getBuiltinChatTools().map((item) => item.id));
  const normalized = meta.category === "custom" && !currentIds.has(meta.id) ? meta : null;
  if (!normalized) {
    throw new Error("自定义工具定义无效");
  }

  config.customTools = [
    ...config.customTools.filter((item) => item.id !== normalized.id),
    normalized
  ];
  if (!config.toolStates[normalized.id]) {
    config.toolStates[normalized.id] = { enabled: false };
  }
  updateChatToolConfig(config);
}

export function deleteCustomChatTool(toolId: string): void {
  const builtinIds = new Set(getBuiltinChatTools().map((item) => item.id));
  if (builtinIds.has(toolId)) {
    throw new Error(`内置工具不支持删除: ${toolId}`);
  }

  const config = readChatToolConfig();
  const exists = config.customTools.some((item) => item.id === toolId);
  if (!exists) {
    throw new Error(`自定义工具不存在: ${toolId}`);
  }

  config.customTools = config.customTools.filter((item) => item.id !== toolId);
  delete config.toolStates[toolId];
  delete config.toolCredentials[toolId];
  updateChatToolConfig(config);
}

export { getBuiltinChatTools as BUILTIN_CHAT_TOOLS, testChatTool };
