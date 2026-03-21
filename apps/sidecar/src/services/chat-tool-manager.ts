/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-tool-config.ts
 * Adaptation:
 * - 仅保留 Lume P0 阶段需要的内置工具开关/凭据能力（memory_search、web_search）。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ChatToolFileConfig,
  ChatToolInfo,
  ChatToolMeta,
  ChatToolState
} from "@lume/shared";
import { getChatToolsPath } from "./config-paths";

const CHAT_TOOL_CONFIG_VERSION = 1;

const BUILTIN_CHAT_TOOLS: ChatToolMeta[] = [
  {
    id: "memory_search",
    name: "记忆检索",
    description: "基于工作区记忆索引检索历史事实和偏好信息",
    icon: "Brain",
    category: "builtin"
  },
  {
    id: "web_search",
    name: "联网搜索",
    description: "使用 Web 搜索获取最新公开信息",
    icon: "Globe",
    category: "builtin"
  }
];

const BUILTIN_TOOL_ID_SET = new Set(BUILTIN_CHAT_TOOLS.map((tool) => tool.id));

function getDefaultToolStates(): Record<string, ChatToolState> {
  return Object.fromEntries(
    BUILTIN_CHAT_TOOLS.map((tool) => [tool.id, { enabled: false }])
  );
}

function getDefaultConfig(): ChatToolFileConfig {
  return {
    version: CHAT_TOOL_CONFIG_VERSION,
    toolStates: getDefaultToolStates(),
    toolCredentials: {}
  };
}

function writeConfig(config: ChatToolFileConfig): void {
  const configPath = getChatToolsPath();
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tempPath, configPath);
}

function normalizeConfig(raw: unknown): ChatToolFileConfig {
  if (!raw || typeof raw !== "object") {
    return getDefaultConfig();
  }

  const source = raw as Partial<ChatToolFileConfig>;
  const toolStates = getDefaultToolStates();
  if (source.toolStates && typeof source.toolStates === "object") {
    for (const [toolId, value] of Object.entries(source.toolStates)) {
      if (!BUILTIN_TOOL_ID_SET.has(toolId)) continue;
      if (!value || typeof value !== "object") continue;
      const enabled = (value as Partial<ChatToolState>).enabled;
      toolStates[toolId] = { enabled: enabled === true };
    }
  }

  const toolCredentials: Record<string, Record<string, string>> = {};
  if (source.toolCredentials && typeof source.toolCredentials === "object") {
    for (const [toolId, value] of Object.entries(source.toolCredentials)) {
      if (!BUILTIN_TOOL_ID_SET.has(toolId)) continue;
      if (!value || typeof value !== "object") continue;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, credential]) => [key, credential.trim()] as const)
        .filter((entry) => entry[1].length > 0);
      if (entries.length === 0) continue;
      toolCredentials[toolId] = Object.fromEntries(entries);
    }
  }

  return {
    version: CHAT_TOOL_CONFIG_VERSION,
    toolStates,
    toolCredentials
  };
}

function readConfig(): ChatToolFileConfig {
  const configPath = getChatToolsPath();
  if (!existsSync(configPath)) {
    const initial = getDefaultConfig();
    writeConfig(initial);
    return initial;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    const normalized = normalizeConfig(raw);
    writeConfig(normalized);
    return normalized;
  } catch (error) {
    console.error("[Chat 工具] 读取配置失败:", error);
    const fallback = getDefaultConfig();
    writeConfig(fallback);
    return fallback;
  }
}

function assertKnownToolId(toolId: string): void {
  if (!BUILTIN_TOOL_ID_SET.has(toolId)) {
    throw new Error(`未知工具: ${toolId}`);
  }
}

function isToolAvailable(toolId: string, _credentials: Record<string, string>): boolean {
  if (toolId === "web_search") {
    // DuckDuckGo provider 不依赖 API key，默认可用。
    return true;
  }
  return true;
}

export function getAllChatToolInfos(): ChatToolInfo[] {
  const config = readConfig();
  return BUILTIN_CHAT_TOOLS.map((meta) => {
    const credentials = config.toolCredentials[meta.id] ?? {};
    return {
      meta,
      enabled: config.toolStates[meta.id]?.enabled === true,
      available: isToolAvailable(meta.id, credentials)
    };
  });
}

export function getChatToolCredentials(toolId: string): Record<string, string> {
  assertKnownToolId(toolId);
  const config = readConfig();
  return { ...(config.toolCredentials[toolId] ?? {}) };
}

export function updateChatToolState(toolId: string, state: ChatToolState): void {
  assertKnownToolId(toolId);
  const config = readConfig();
  config.toolStates[toolId] = { enabled: state.enabled === true };
  writeConfig(config);
}

export function updateChatToolCredentials(toolId: string, credentials: Record<string, string>): void {
  assertKnownToolId(toolId);
  const config = readConfig();
  const next = Object.entries(credentials)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key, value.trim()] as const)
    .filter((entry) => entry[1].length > 0);
  config.toolCredentials[toolId] = Object.fromEntries(next);
  writeConfig(config);
}

export { BUILTIN_CHAT_TOOLS };
