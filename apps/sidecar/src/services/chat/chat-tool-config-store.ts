import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ChatToolFileConfig,
  ChatToolHttpConfig,
  ChatToolInfo,
  ChatToolMeta,
  ChatToolParam,
  ChatToolState
} from "@lume/shared";
import { getChatToolsPath } from "../infra/config-paths";

const CHAT_TOOL_CONFIG_VERSION = 1;
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const LEGACY_TOOL_ID_MAP: Record<string, string> = {
  memory: "memory_search",
  "web-search": "web_search",
  "agent-mode-recommend": "suggest_agent_mode",
  "nano-banana": "nano_banana"
};

const BUILTIN_CHAT_TOOLS: ChatToolMeta[] = [
  {
    id: "memory_search",
    name: "记忆检索",
    description: "基于工作区记忆索引检索历史事实和偏好信息",
    icon: "Brain",
    category: "builtin",
    executorType: "builtin",
    systemPromptAppend: "涉及历史偏好、已确认决策或长期上下文时，请优先参考 memory_search 工具结果。"
  },
  {
    id: "web_search",
    name: "联网搜索",
    description: "使用 Web 搜索获取最新公开信息",
    icon: "Globe",
    category: "builtin",
    executorType: "builtin",
    systemPromptAppend: "涉及时效性信息时，请优先使用 web_search 获取最新公开资料，再基于结果回答。"
  },
  {
    id: "suggest_agent_mode",
    name: "Agent 模式推荐",
    description: "识别复杂任务并提示用户切换到 Agent 模式",
    icon: "Sparkles",
    category: "builtin",
    executorType: "builtin",
    params: [
      { name: "reason", type: "string", description: "推荐原因", required: true },
      { name: "suggestedPrompt", type: "string", description: "建议的 Agent 初始提示词", required: true }
    ],
    systemPromptAppend:
      "当用户请求涉及调研、代码修改、文件操作或多步骤执行时，可优先建议切换 Agent 模式以获得更完整的执行能力。"
  },
  {
    id: "nano_banana",
    name: "Nano Banana",
    description: "AI 图片生成与编辑（基于 Gemini Image Generation）",
    icon: "ImagePlus",
    category: "builtin",
    executorType: "builtin",
    params: [
      { name: "prompt", type: "string", description: "图片生成/编辑描述", required: true },
      { name: "aspectRatio", type: "string", description: "宽高比，可选：1:1/16:9/4:3/9:16/3:4" },
      { name: "imageSize", type: "string", description: "分辨率，可选：auto/1K/2K/4K" },
      { name: "useReferenceImages", type: "boolean", description: "是否使用参考图（当前/历史图片附件）" }
    ],
    systemPromptAppend: [
      "当用户明确要求生成图片、绘图、做海报或编辑图片时，优先调用 nano_banana。",
      "prompt 建议写成具体英文描述，编辑图片时可将 useReferenceImages 设为 true。"
    ].join("\n")
  }
];

const BUILTIN_TOOL_ID_SET = new Set(BUILTIN_CHAT_TOOLS.map((tool) => tool.id));

function normalizeToolId(toolId: string): string {
  return LEGACY_TOOL_ID_MAP[toolId] ?? toolId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractCredentialKeysFromTemplate(template?: string): string[] {
  if (!template) return [];
  const regex = /\{\{\s*credential\.([a-zA-Z0-9_-]+)\s*\}\}/g;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const key = (match[1] ?? "").trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
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

  return {
    id,
    name,
    description,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    category: "custom",
    params,
    executorType,
    httpConfig,
    systemPromptAppend: typeof raw.systemPromptAppend === "string" ? raw.systemPromptAppend : undefined
  };
}

function getDefaultToolStates(customTools: ChatToolMeta[] = []): Record<string, ChatToolState> {
  return Object.fromEntries(
    [...BUILTIN_CHAT_TOOLS, ...customTools].map((tool) => [
      tool.id,
      { enabled: tool.id === "memory_search" || tool.id === "suggest_agent_mode" }
    ])
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

export function getBuiltinChatTools(): ChatToolMeta[] {
  return [...BUILTIN_CHAT_TOOLS];
}

export function normalizeToolConfig(raw: unknown): ChatToolFileConfig {
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
      const normalizedToolId = normalizeToolId(toolId);
      if (!knownToolIds.has(normalizedToolId) || !isRecord(value)) continue;
      toolStates[normalizedToolId] = { enabled: value.enabled === true };
    }
  }

  const toolCredentials: Record<string, Record<string, string>> = {};
  if (isRecord(raw.toolCredentials)) {
    for (const [toolId, value] of Object.entries(raw.toolCredentials)) {
      const normalizedToolId = normalizeToolId(toolId);
      if (!knownToolIds.has(normalizedToolId) || !isRecord(value)) continue;
      const entries = Object.entries(value)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, credential]) => [key, credential.trim()] as const)
        .filter((entry) => entry[1].length > 0);
      if (entries.length === 0) continue;
      toolCredentials[normalizedToolId] = Object.fromEntries(entries);
    }
  }

  return {
    version: CHAT_TOOL_CONFIG_VERSION,
    toolStates,
    toolCredentials,
    customTools
  };
}

export function readChatToolConfig(): ChatToolFileConfig {
  const configPath = getChatToolsPath();
  if (!existsSync(configPath)) {
    const initial = getDefaultConfig();
    writeConfig(initial);
    return initial;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    const normalized = normalizeToolConfig(raw);
    writeConfig(normalized);
    return normalized;
  } catch (error) {
    console.error("[Chat 工具] 读取配置失败:", error);
    const fallback = getDefaultConfig();
    writeConfig(fallback);
    return fallback;
  }
}

export function getAllToolMetas(config: ChatToolFileConfig): ChatToolMeta[] {
  return [...BUILTIN_CHAT_TOOLS, ...config.customTools];
}

export function assertKnownToolId(toolId: string, config?: ChatToolFileConfig): ChatToolFileConfig {
  const current = config ?? readChatToolConfig();
  const known = getAllToolMetas(current).some((meta) => meta.id === toolId);
  if (!known) {
    throw new Error(`未知工具: ${toolId}`);
  }
  return current;
}

export function getRequiredCredentialKeys(meta: ChatToolMeta): string[] {
  if (meta.executorType !== "http" || !meta.httpConfig) return [];
  const keys = new Set<string>();
  for (const key of extractCredentialKeysFromTemplate(meta.httpConfig.urlTemplate)) {
    keys.add(key);
  }
  for (const key of extractCredentialKeysFromTemplate(meta.httpConfig.bodyTemplate)) {
    keys.add(key);
  }
  for (const value of Object.values(meta.httpConfig.headers ?? {})) {
    for (const key of extractCredentialKeysFromTemplate(value)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

export function isToolAvailable(meta: ChatToolMeta, credentials: Record<string, string>): boolean {
  if (meta.id === "web_search") {
    return true;
  }
  if (meta.id === "nano_banana") {
    return (credentials.apiKey ?? "").trim().length > 0;
  }
  if (meta.category === "custom") {
    const required = getRequiredCredentialKeys(meta);
    if (required.length === 0) return true;
    return required.every((key) => (credentials[key] ?? "").trim().length > 0);
  }
  return true;
}

export function getAllChatToolInfosFromConfig(config: ChatToolFileConfig): ChatToolInfo[] {
  return getAllToolMetas(config).map((meta) => {
    const credentials = config.toolCredentials[meta.id] ?? {};
    return {
      meta,
      enabled: config.toolStates[meta.id]?.enabled === true,
      available: isToolAvailable(meta, credentials)
    };
  });
}

export function updateChatToolConfig(config: ChatToolFileConfig): void {
  writeConfig(config);
}
