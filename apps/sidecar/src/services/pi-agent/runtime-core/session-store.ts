import { randomUUID } from "node:crypto";
import {
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
  checkpoints?: Record<string, unknown>;
}

type RuntimeCoreEntry =
  | { type: "model_change"; provider: string; modelId: string; timestamp: number }
  | { type: "thinking_level_change"; level: string; timestamp: number }
  | { type: "compaction"; summary: string; leafId?: string; tokenCount?: number; metadata?: Record<string, unknown>; timestamp: number };

export interface RuntimeCoreModelChange {
  provider: string;
  modelId: string;
}

export interface RuntimeCoreSessionContextMessage {
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
  model?: RuntimeCoreModelChange;
  thinkingLevel?: string;
}

interface RuntimeCoreSessionManagerState {
  entries: RuntimeCoreEntry[];
}

export interface RuntimeCoreSessionManager {
  getSessionId(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  getEntries(): RuntimeCoreEntry[];
  appendModelChange(provider: string, modelId: string): void;
  appendThinkingLevelChange(level: string): void;
  appendMessage(message: {
    role: "user" | "assistant" | "toolResult";
    content: unknown;
    timestamp?: number;
    provider?: string;
    model?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    api?: string;
    stopReason?: string;
    usage?: unknown;
  }): string;
  appendCompaction(
    summary: string,
    leafId?: string,
    tokenCount?: number,
    metadata?: Record<string, unknown>
  ): void;
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

function getStatePath(dir: string): string {
  return join(dir, "runtime-state.json");
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
    sessionMessages: Array.isArray(raw?.sessionMessages) ? raw.sessionMessages : [],
    checkpoints: raw?.checkpoints ?? {}
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
  writeTextAtomic(getTranscriptJsonPath(sessionDir), JSON.stringify(data, null, 2));
  const jsonlPayload = data.sessionMessages.map((message) => JSON.stringify(message)).join("\n");
  writeTextAtomic(getTranscriptJsonlPath(sessionDir), jsonlPayload);
}

function readState(sessionDir: string): RuntimeCoreSessionManagerState {
  const path = getStatePath(sessionDir);
  if (!existsSync(path)) {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RuntimeCoreSessionManagerState;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch {
    return { entries: [] };
  }
}

function writeState(sessionDir: string, state: RuntimeCoreSessionManagerState): void {
  writeTextAtomic(getStatePath(sessionDir), JSON.stringify(state, null, 2));
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

  getEntries(): RuntimeCoreEntry[] {
    return readState(this.sessionDir).entries;
  }

  appendModelChange(provider: string, modelId: string): void {
    const state = readState(this.sessionDir);
    state.entries.push({
      type: "model_change",
      provider,
      modelId,
      timestamp: Date.now()
    });
    writeState(this.sessionDir, state);

    const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
    data.metadata.model = `${provider}/${modelId}`;
    data.metadata.updatedAt = new Date().toISOString();
    writeStoredData(this.sessionDir, data);
  }

  appendThinkingLevelChange(level: string): void {
    const state = readState(this.sessionDir);
    state.entries.push({
      type: "thinking_level_change",
      level,
      timestamp: Date.now()
    });
    writeState(this.sessionDir, state);
  }

  appendMessage(message: {
    role: "user" | "assistant" | "toolResult";
    content: unknown;
    timestamp?: number;
    provider?: string;
    model?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    api?: string;
    stopReason?: string;
    usage?: unknown;
  }): string {
    const uuid = randomUUID();
    const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
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
    data.messages = extractNormalizedMessages(data.sessionMessages);
    data.metadata.messageCount = data.messages.length;
    data.metadata.updatedAt = new Date().toISOString();
    writeStoredData(this.sessionDir, data);
    return uuid;
  }

  appendCompaction(
    summary: string,
    leafId?: string,
    tokenCount?: number,
    metadata?: Record<string, unknown>
  ): void {
    const state = readState(this.sessionDir);
    state.entries.push({
      type: "compaction",
      summary,
      leafId,
      tokenCount,
      metadata,
      timestamp: Date.now()
    });
    writeState(this.sessionDir, state);
  }

  buildSessionContext(): RuntimeCoreSessionContext {
    const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
    const state = readState(this.sessionDir);
    const lastModelChange = [...state.entries].reverse().find((entry) => entry.type === "model_change");
    const lastThinkingChange = [...state.entries].reverse().find((entry) => entry.type === "thinking_level_change");
    return {
      messages: convertSessionMessagesToContext(data),
      ...(lastModelChange && lastModelChange.type === "model_change"
        ? {
            model: {
              provider: lastModelChange.provider,
              modelId: lastModelChange.modelId
            }
          }
        : {}),
      ...(lastThinkingChange && lastThinkingChange.type === "thinking_level_change"
        ? { thinkingLevel: lastThinkingChange.level }
        : {})
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
