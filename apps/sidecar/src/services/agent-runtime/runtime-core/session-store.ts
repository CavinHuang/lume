import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { getAgentConfigDir } from "../../infra/config-paths";

interface RuntimeCoreStoredMetadata {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary?: string;
  tag?: string | null;
  forkedFrom?: string;
}

interface RuntimeCoreStoredSessionMessage {
  uuid: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  content: unknown;
}

interface RuntimeCoreStoredData {
  metadata: RuntimeCoreStoredMetadata;
  messages: Array<{
    role: "user" | "assistant";
    content: unknown;
  }>;
  sessionMessages: RuntimeCoreStoredSessionMessage[];
}

export interface RuntimeCoreModelChange {
  provider: string;
  modelId: string;
}

export interface RuntimeCoreSessionContextMessage {
  id?: string;
  uuid?: string;
  role: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface RuntimeCoreSessionContext {
  messages: RuntimeCoreSessionContextMessage[];
}

export type RuntimeCoreAppendMessageInput = {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  timestamp?: number;
  provider?: string;
  channelProvider?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  api?: string;
  stopReason?: string;
  usage?: unknown;
};

export interface RuntimeCoreSessionManager {
  getSessionId(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  appendModelChange(provider: string, modelId: string): void;
  appendMessage(message: RuntimeCoreAppendMessageInput): string;
  /** 批量追加（fork/导入 rebuild）：一次读改写，替代逐条 appendMessage 的 O(n²)。 */
  appendMessages(messages: RuntimeCoreAppendMessageInput[]): string[];
  buildSessionContext(): RuntimeCoreSessionContext;
}

function toSafeSessionSegment(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error("runtime-core sessionId 不能为空");
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function getTranscriptJsonPath(dir: string): string {
  return join(dir, "transcript.json");
}

function getTranscriptJsonlPath(dir: string): string {
  return join(dir, "transcript.jsonl");
}

function ensureAgentSdkHome(agentDir: string): void {
  process.env.OPEN_AGENT_SDK_HOME = agentDir;
  process.env.CODEANY_HOME = agentDir;
}

function normalizeStoredData(sessionId: string, cwd: string, raw?: Partial<RuntimeCoreStoredData>): RuntimeCoreStoredData {
  const now = new Date().toISOString();
  return {
    metadata: {
      id: sessionId,
      cwd: raw?.metadata?.cwd || cwd,
      model: raw?.metadata?.model || "unknown/unknown",
      createdAt: raw?.metadata?.createdAt || now,
      updatedAt: raw?.metadata?.updatedAt || now,
      messageCount: raw?.metadata?.messageCount ?? raw?.messages?.length ?? 0,
      summary: raw?.metadata?.summary,
      tag: raw?.metadata?.tag,
      forkedFrom: raw?.metadata?.forkedFrom
    },
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    sessionMessages: Array.isArray(raw?.sessionMessages) ? raw.sessionMessages : []
  };
}

function readStoredData(sessionDir: string, sessionId: string, cwd: string): RuntimeCoreStoredData {
  const path = getTranscriptJsonPath(sessionDir);
  if (!existsSync(path)) {
    return normalizeStoredData(sessionId, cwd);
  }
  try {
    return normalizeStoredData(
      sessionId,
      cwd,
      JSON.parse(readFileSync(path, "utf-8")) as RuntimeCoreStoredData
    );
  } catch {
    return normalizeStoredData(sessionId, cwd);
  }
}

function writeStoredData(sessionDir: string, data: RuntimeCoreStoredData): void {
  writeTranscriptJson(sessionDir, data);
  rewriteTranscriptJsonl(sessionDir, data);
}

function writeTranscriptJson(sessionDir: string, data: RuntimeCoreStoredData): void {
  writeTextAtomic(getTranscriptJsonPath(sessionDir), JSON.stringify(data, null, 2));
}

function rewriteTranscriptJsonl(sessionDir: string, data: RuntimeCoreStoredData): void {
  const jsonlPayload = data.sessionMessages.map((message) => JSON.stringify(message)).join("\n");
  writeTextAtomic(getTranscriptJsonlPath(sessionDir), jsonlPayload);
}

/**
 * jsonl 追加单行（SDK resume 输入）。写方（writeStoredData 与 SDK saveSession）历史格式均无尾换行，
 * append 前补齐分隔；行数与 json 脱节（如崩溃截断）时返回 false 由调用方退回全量重写。
 */
function tryAppendTranscriptJsonlLine(
  sessionDir: string,
  message: RuntimeCoreStoredSessionMessage,
  expectedExistingCount: number
): boolean {
  const path = getTranscriptJsonlPath(sessionDir);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const existingCount = existing.split("\n").filter((line) => line.trim().length > 0).length;
  if (existingCount !== expectedExistingCount) return false;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${prefix}${JSON.stringify(message)}\n`, "utf-8");
  return true;
}

function extractNormalizedMessages(sessionMessages: RuntimeCoreStoredSessionMessage[]): RuntimeCoreStoredData["messages"] {
  const messages: RuntimeCoreStoredData["messages"] = [];
  for (const item of sessionMessages) {
    if (item.role !== "user" && item.role !== "assistant") continue;
    messages.push({
      role: item.role,
      content: item.content
    });
  }
  return messages;
}

function applyStoredMessage(data: RuntimeCoreStoredData, message: RuntimeCoreAppendMessageInput, uuid: string): void {
  if (message.role === "assistant" && message.provider && message.model) {
    data.metadata.model = `${message.provider}/${message.model}`;
  }
  const sessionMessageContent = message.role === "toolResult"
    ? [{
        type: "tool_result",
        tool_use_id: message.toolCallId ?? uuid,
        tool_name: message.toolName,
        content: message.content,
        is_error: message.isError === true
      }]
    : message.content;
  data.sessionMessages.push({
    uuid,
    role: message.role === "toolResult" ? "user" : message.role,
    timestamp: toIsoFromTimestamp(message.timestamp),
    content: sessionMessageContent
  });
}

function finalizeStoredData(data: RuntimeCoreStoredData): void {
  data.messages = extractNormalizedMessages(data.sessionMessages);
  data.metadata.messageCount = data.messages.length;
  data.metadata.updatedAt = new Date().toISOString();
}

function toIsoFromTimestamp(timestamp?: number): string {
  return new Date(typeof timestamp === "number" ? timestamp : Date.now()).toISOString();
}

function parseModelDescriptor(value: string): RuntimeCoreModelChange | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const [provider, ...rest] = normalized.split("/");
  if (provider && rest.length > 0) {
    return {
      provider,
      modelId: rest.join("/")
    };
  }
  return {
    provider: "unknown",
    modelId: normalized
  };
}

function convertSessionMessagesToContext(
  data: RuntimeCoreStoredData
): RuntimeCoreSessionContextMessage[] {
  const contextMessages: RuntimeCoreSessionContextMessage[] = [];
  const metadataModel = parseModelDescriptor(data.metadata.model);
  for (const message of data.sessionMessages) {
    const timestamp = Date.parse(message.timestamp);
    if (message.role === "assistant") {
      contextMessages.push({
        id: message.uuid,
        uuid: message.uuid,
        role: "assistant",
        content: message.content,
        timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
        provider: metadataModel?.provider,
        model: metadataModel?.modelId
      });
      continue;
    }

    if (message.role === "user") {
      const content = message.content;
      if (Array.isArray(content)) {
        const toolResultBlocks = content.filter((item) => {
          return !!item
            && typeof item === "object"
            && (item as { type?: string }).type === "tool_result";
        }) as Array<{
          tool_use_id?: unknown;
          content?: unknown;
          is_error?: unknown;
          tool_name?: unknown;
        }>;

        if (toolResultBlocks.length > 0) {
          for (const block of toolResultBlocks) {
            contextMessages.push({
              id: message.uuid,
              uuid: message.uuid,
              role: "toolResult",
              content: block.content,
              timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
              toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
              toolName: typeof block.tool_name === "string" ? block.tool_name : undefined,
              isError: block.is_error === true
            });
          }
          continue;
        }
      }

      contextMessages.push({
        id: message.uuid,
        uuid: message.uuid,
        role: "user",
        content: message.content,
        timestamp: Number.isFinite(timestamp) ? timestamp : undefined
      });
    }
  }
  return contextMessages;
}

class FileBackedRuntimeCoreSessionManager implements RuntimeCoreSessionManager {
  private readonly sessionDir: string;
  private readonly sessionId: string;
  private readonly cwd: string;

  constructor(cwd: string, sessionId: string, agentDir?: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.sessionDir = getRuntimeCoreSessionDir(sessionId, agentDir);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionFile(): string | undefined {
    const path = getTranscriptJsonlPath(this.sessionDir);
    return existsSync(path) ? path : undefined;
  }

  appendModelChange(provider: string, modelId: string): void {
    const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
    data.metadata.model = `${provider}/${modelId}`;
    data.metadata.updatedAt = new Date().toISOString();
    // 只改元数据，jsonl 内容不变，跳过其全量重写
    writeTranscriptJson(this.sessionDir, data);
  }

  appendMessage(message: RuntimeCoreAppendMessageInput): string {
    return this.appendMessages([message])[0]!;
  }

  appendMessages(messages: RuntimeCoreAppendMessageInput[]): string[] {
    const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
    const uuids: string[] = [];
    for (const message of messages) {
      const uuid = randomUUID();
      uuids.push(uuid);
      applyStoredMessage(data, message, uuid);
    }
    finalizeStoredData(data);
    if (messages.length === 1) {
      // 单条：jsonl 只追加一行（含换行守卫），json 仍为状态源全量写
      writeTranscriptJson(this.sessionDir, data);
      if (!tryAppendTranscriptJsonlLine(this.sessionDir, data.sessionMessages[data.sessionMessages.length - 1]!, data.sessionMessages.length - 1)) {
        rewriteTranscriptJsonl(this.sessionDir, data);
      }
    } else {
      writeStoredData(this.sessionDir, data);
    }
    return uuids;
  }

  buildSessionContext(): RuntimeCoreSessionContext {
    const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
    return {
      messages: convertSessionMessagesToContext(data)
    };
  }
}

export function getRuntimeCoreAgentDir(agentDir?: string): string {
  const dir = agentDir ?? join(getAgentConfigDir(), "runtime-core");
  mkdirSync(dir, { recursive: true });
  ensureAgentSdkHome(dir);
  return dir;
}

export function getRuntimeCoreSessionDirPath(lumeSessionId: string, agentDir?: string): string {
  const baseDir = getRuntimeCoreAgentDir(agentDir);
  return join(baseDir, "sessions", toSafeSessionSegment(lumeSessionId));
}

export function getRuntimeCoreSessionDir(lumeSessionId: string, agentDir?: string): string {
  const dir = getRuntimeCoreSessionDirPath(lumeSessionId, agentDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function hasRuntimeCoreSessionTranscript(lumeSessionId: string, agentDir?: string): boolean {
  const sessionDir = getRuntimeCoreSessionDirPath(lumeSessionId, agentDir);
  if (!existsSync(sessionDir)) {
    return false;
  }
  try {
    return readdirSync(sessionDir).some((name) => name.endsWith(".json") || name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

export function createOrResumeRuntimeCoreSessionManager(
  cwd: string,
  lumeSessionId: string,
  agentDir?: string
): RuntimeCoreSessionManager {
  getRuntimeCoreAgentDir(agentDir);
  return new FileBackedRuntimeCoreSessionManager(cwd, lumeSessionId, agentDir);
}
