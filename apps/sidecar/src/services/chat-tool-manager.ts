/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\chat-tool-config.ts
 * Adaptation:
 * - 首期保留内置工具最小闭环（memory_search、web_search）。
 * - 补齐自定义工具元数据持久化（create/delete/list），执行链路后续对齐。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ChatToolFileConfig,
  ChatToolHttpConfig,
  ChatToolInfo,
  ChatToolMeta,
  ChatToolParam,
  ChatToolState,
  ChatToolTestResult
} from "@lume/shared";
import { getChatToolsPath } from "./config-paths";

const CHAT_TOOL_CONFIG_VERSION = 1;
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const BUILTIN_CHAT_TOOLS: ChatToolMeta[] = [
  {
    id: "memory_search",
    name: "记忆检索",
    description: "基于工作区记忆索引检索历史事实和偏好信息",
    icon: "Brain",
    category: "builtin",
    executorType: "builtin"
  },
  {
    id: "web_search",
    name: "联网搜索",
    description: "使用 Web 搜索获取最新公开信息",
    icon: "Globe",
    category: "builtin",
    executorType: "builtin"
  }
];

const BUILTIN_TOOL_ID_SET = new Set(BUILTIN_CHAT_TOOLS.map((tool) => tool.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHttpConfig(raw: unknown): ChatToolHttpConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const urlTemplate = typeof raw.urlTemplate === "string" ? raw.urlTemplate.trim() : "";
  const method = raw.method === "POST" ? "POST" : raw.method === "GET" ? "GET" : undefined;
  if (!urlTemplate || !method) return undefined;

  const headers = isRecord(raw.headers)
    ? Object.fromEntries(
      Object.entries(raw.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => [key, value.trim()] as const)
        .filter((entry) => entry[0].trim().length > 0)
    )
    : undefined;

  const bodyTemplate = typeof raw.bodyTemplate === "string" ? raw.bodyTemplate : undefined;
  const resultPath = typeof raw.resultPath === "string" ? raw.resultPath : undefined;

  return {
    urlTemplate,
    method,
    headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
    bodyTemplate,
    resultPath
  };
}

function normalizeParams(raw: unknown): ChatToolParam[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatToolParam[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const type = item.type;
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!name || (type !== "string" && type !== "number" && type !== "boolean") || !description) {
      continue;
    }
    const normalized: ChatToolParam = {
      name,
      type,
      description,
      required: item.required === true
    };
    if (Array.isArray(item.enum)) {
      const values = item.enum.filter((entry): entry is string => typeof entry === "string");
      if (values.length > 0) {
        normalized.enum = values;
      }
    }
    result.push(normalized);
  }
  return result;
}

function normalizeCustomToolMeta(raw: unknown): ChatToolMeta | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";

  if (!id || !TOOL_ID_PATTERN.test(id) || !name || !description) {
    return null;
  }
  if (BUILTIN_TOOL_ID_SET.has(id)) {
    return null;
  }

  const executorType = raw.executorType === "http" ? "http" : "builtin";
  const httpConfig = normalizeHttpConfig(raw.httpConfig);
  const params = normalizeParams(raw.params);

  if (executorType === "http" && !httpConfig) {
    return null;
  }

  const icon = typeof raw.icon === "string" ? raw.icon : undefined;
  const systemPromptAppend = typeof raw.systemPromptAppend === "string"
    ? raw.systemPromptAppend
    : undefined;

  return {
    id,
    name,
    description,
    icon,
    category: "custom",
    params,
    executorType,
    httpConfig,
    systemPromptAppend
  };
}

function getDefaultToolStates(customTools: ChatToolMeta[] = []): Record<string, ChatToolState> {
  return Object.fromEntries(
    [...BUILTIN_CHAT_TOOLS, ...customTools].map((tool) => [tool.id, { enabled: false }])
  );
}

function getDefaultConfig(): ChatToolFileConfig {
  return {
    version: CHAT_TOOL_CONFIG_VERSION,
    toolStates: getDefaultToolStates(),
    toolCredentials: {},
    customTools: []
  };
}

function writeConfig(config: ChatToolFileConfig): void {
  const configPath = getChatToolsPath();
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tempPath, configPath);
}

function normalizeConfig(raw: unknown): ChatToolFileConfig {
  if (!isRecord(raw)) {
    return getDefaultConfig();
  }

  const customTools = Array.isArray(raw.customTools)
    ? raw.customTools
      .map((item) => normalizeCustomToolMeta(item))
      .filter((item): item is ChatToolMeta => item !== null)
    : [];

  const knownToolIds = new Set<string>([
    ...BUILTIN_CHAT_TOOLS.map((tool) => tool.id),
    ...customTools.map((tool) => tool.id)
  ]);

  const toolStates = getDefaultToolStates(customTools);
  if (isRecord(raw.toolStates)) {
    for (const [toolId, value] of Object.entries(raw.toolStates)) {
      if (!knownToolIds.has(toolId) || !isRecord(value)) continue;
      toolStates[toolId] = { enabled: value.enabled === true };
    }
  }

  const toolCredentials: Record<string, Record<string, string>> = {};
  if (isRecord(raw.toolCredentials)) {
    for (const [toolId, value] of Object.entries(raw.toolCredentials)) {
      if (!knownToolIds.has(toolId) || !isRecord(value)) continue;
      const entries = Object.entries(value)
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
    toolCredentials,
    customTools
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

function getAllToolMetas(config: ChatToolFileConfig): ChatToolMeta[] {
  return [...BUILTIN_CHAT_TOOLS, ...config.customTools];
}

function assertKnownToolId(toolId: string, config?: ChatToolFileConfig): ChatToolFileConfig {
  const current = config ?? readConfig();
  const known = getAllToolMetas(current).some((meta) => meta.id === toolId);
  if (!known) {
    throw new Error(`未知工具: ${toolId}`);
  }
  return current;
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
  return getAllToolMetas(config).map((meta) => {
    const credentials = config.toolCredentials[meta.id] ?? {};
    return {
      meta,
      enabled: config.toolStates[meta.id]?.enabled === true,
      available: isToolAvailable(meta.id, credentials)
    };
  });
}

export function getChatToolCredentials(toolId: string): Record<string, string> {
  const config = assertKnownToolId(toolId);
  return { ...(config.toolCredentials[toolId] ?? {}) };
}

export function updateChatToolState(toolId: string, state: ChatToolState): void {
  const config = assertKnownToolId(toolId);
  config.toolStates[toolId] = { enabled: state.enabled === true };
  writeConfig(config);
}

export function updateChatToolCredentials(toolId: string, credentials: Record<string, string>): void {
  const config = assertKnownToolId(toolId);
  const next = Object.entries(credentials)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key, value.trim()] as const)
    .filter((entry) => entry[1].length > 0);
  config.toolCredentials[toolId] = Object.fromEntries(next);
  writeConfig(config);
}

export function createCustomChatTool(meta: ChatToolMeta): void {
  const normalized = normalizeCustomToolMeta(meta);
  if (!normalized) {
    throw new Error("自定义工具定义无效");
  }

  const config = readConfig();
  config.customTools = [
    ...config.customTools.filter((item) => item.id !== normalized.id),
    normalized
  ];
  if (!config.toolStates[normalized.id]) {
    config.toolStates[normalized.id] = { enabled: false };
  }
  writeConfig(config);
}

export function deleteCustomChatTool(toolId: string): void {
  if (BUILTIN_TOOL_ID_SET.has(toolId)) {
    throw new Error(`内置工具不支持删除: ${toolId}`);
  }

  const config = readConfig();
  const exists = config.customTools.some((item) => item.id === toolId);
  if (!exists) {
    throw new Error(`自定义工具不存在: ${toolId}`);
  }

  config.customTools = config.customTools.filter((item) => item.id !== toolId);
  delete config.toolStates[toolId];
  delete config.toolCredentials[toolId];
  writeConfig(config);
}

async function testWebSearchByDuckDuckGo(): Promise<ChatToolTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://duckduckgo.com/html/?q=test%20connection", {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "Lume-Chat/1.0 (+chat-tool-test)"
      }
    });
    if (!response.ok) {
      return { success: false, message: `DuckDuckGo 请求失败: ${response.status}` };
    }
    return { success: true, message: "连接成功，DuckDuckGo 可用" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `DuckDuckGo 连接失败: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function testWebSearchByBrave(apiKey: string): Promise<ChatToolTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://api.search.brave.com/res/v1/web/search?q=test%20connection&count=1", {
      method: "GET",
      signal: controller.signal,
      headers: {
        "x-subscription-token": apiKey,
        accept: "application/json",
        "user-agent": "Lume-Chat/1.0 (+chat-tool-test)"
      }
    });
    if (!response.ok) {
      return { success: false, message: `Brave 请求失败: ${response.status}` };
    }
    return { success: true, message: "连接成功，Brave Search API 可用" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Brave 连接失败: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function testWebSearchByTavily(apiKey: string): Promise<ChatToolTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "Lume-Chat/1.0 (+chat-tool-test)"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: "test connection",
        search_depth: "basic",
        max_results: 1
      })
    });
    if (!response.ok) {
      return { success: false, message: `Tavily 请求失败: ${response.status}` };
    }
    return { success: true, message: "连接成功，Tavily Search API 可用" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Tavily 连接失败: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function testChatTool(toolId: string): Promise<ChatToolTestResult> {
  const config = assertKnownToolId(toolId);

  if (toolId === "memory_search") {
    return { success: true, message: "连接成功，本地记忆检索工具可用" };
  }
  if (toolId === "web_search") {
    const credentials = config.toolCredentials.web_search ?? {};
    const braveApiKey = credentials.braveApiKey?.trim();
    const tavilyApiKey = credentials.tavilyApiKey?.trim();

    if (braveApiKey) {
      const braveResult = await testWebSearchByBrave(braveApiKey);
      if (braveResult.success) return braveResult;
    }
    if (tavilyApiKey) {
      const tavilyResult = await testWebSearchByTavily(tavilyApiKey);
      if (tavilyResult.success) return tavilyResult;
    }

    return testWebSearchByDuckDuckGo();
  }

  const customMeta = config.customTools.find((item) => item.id === toolId);
  if (!customMeta) {
    return { success: false, message: `工具 ${toolId} 不支持测试` };
  }

  if (customMeta.executorType !== "http" || !customMeta.httpConfig) {
    return { success: false, message: `工具 ${toolId} 暂不支持测试` };
  }

  return { success: false, message: `工具 ${toolId} 暂不支持自动测试，请在对话中实际调用验证` };
}

export { BUILTIN_CHAT_TOOLS };
