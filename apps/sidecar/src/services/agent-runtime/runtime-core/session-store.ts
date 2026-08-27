import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
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

/**
 * #527-三审①：进程内会话数据缓存。此前每次 appendMessage 的成本是三条
 * 「全量读 transcript.json（readStoredData）+ 全量读 transcript.jsonl 数行数
 * （tryAppend）+ 全量写 transcript.json」中的前两条。缓存以双文件 mtime+size
 * 校验：外部进程改动任何一侧即失效回退冷读，行为与旧实现一致；自身写后仅
 * stat 刷新（无额外读）。json 状态源契约不变。
 */
interface SessionFileSnapshot {
  mtimeMs: number;
  size: number;
}

interface JsonlTail {
  bytes: number;
  lines: number;
  endsWithNewline: boolean;
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

/**
 * #527 三审①收官：transcript.jsonl 升级为 sessionMessages 状态源，
 * transcript.json 只保留元数据投影——每条消息追加的磁盘成本降至常量级。
 * 消息与其规范化视图在读侧由 jsonl（或旧格式 json 内嵌数组）派生。
 */
function writeTranscriptJson(sessionDir: string, data: RuntimeCoreStoredData): void {
  writeTextAtomic(
    getTranscriptJsonPath(sessionDir),
    JSON.stringify({ metadata: data.metadata })
  );
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
  private snapshot: { json: SessionFileSnapshot | undefined; jsonl: SessionFileSnapshot | undefined } | null = null;
  private cachedData: RuntimeCoreStoredData | null = null;
  private jsonlTail: JsonlTail | null = null;

  constructor(cwd: string, sessionId: string, agentDir?: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.sessionDir = getRuntimeCoreSessionDir(sessionId, agentDir);
  }

  private statOrUndefined(path: string): SessionFileSnapshot | undefined {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  }

  private snapshotsMatch(
    current: { json: SessionFileSnapshot | undefined; jsonl: SessionFileSnapshot | undefined },
  ): boolean {
    if (!this.snapshot) return false;
    const same = (a: SessionFileSnapshot | undefined, b: SessionFileSnapshot | undefined) =>
      a === b || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size);
    return same(current.json, this.snapshot.json) && same(current.jsonl, this.snapshot.jsonl);
  }

  /**
   * #527 三审①收官：jsonl 为 sessionMessages 状态源。冷读时对 jsonl 做严格
   * 解析取「完好前缀」，与旧格式 json 内嵌数组按长度裁决（平局取 jsonl）；
   * 撕裂尾行或落在旧格式一侧时置 needsJsonlRebuild，由下一次写入重建 jsonl
   * 完成自愈升级。
   */
  private loadData(): RuntimeCoreStoredData {
    const current = {
      json: this.statOrUndefined(getTranscriptJsonPath(this.sessionDir)),
      jsonl: this.statOrUndefined(getTranscriptJsonlPath(this.sessionDir))
    };
    if (!this.snapshotsMatch(current)) {
      this.snapshot = current;
      const data = readStoredData(this.sessionDir, this.sessionId, this.cwd);
      const rawJsonl = current.jsonl ? readFileSync(getTranscriptJsonlPath(this.sessionDir), "utf-8") : "";
      const goodLines: RuntimeCoreStoredSessionMessage[] = [];
      let hasCorruptTail = false;
      for (const line of rawJsonl.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          goodLines.push(JSON.parse(trimmed) as RuntimeCoreStoredSessionMessage);
        } catch {
          hasCorruptTail = true;
          break;
        }
      }
      if (goodLines.length >= data.sessionMessages.length && goodLines.length > 0) {
        data.sessionMessages = goodLines;
        data.messages = extractNormalizedMessages(goodLines);
        data.metadata.messageCount = data.messages.length;
      }
      // 落在 json 一侧（旧格式更长）或存在撕裂尾行时，磁盘 jsonl 与权威序列
      // 不一致——下次写入先全量重建
      this.needsJsonlRebuild =
        hasCorruptTail ||
        (goodLines.length !== data.sessionMessages.length && data.sessionMessages.length > 0);
      this.jsonlTail = current.jsonl
        ? {
            bytes: Buffer.byteLength(rawJsonl, "utf-8"),
            lines: goodLines.length,
            endsWithNewline: rawJsonl.endsWith("\n")
          }
        : { bytes: 0, lines: 0, endsWithNewline: false };
      this.cachedData = data;
      return data;
    }
    return this.cachedData!;
  }

  private needsJsonlRebuild = false;

  getSessionFile(): string | undefined {
    const path = getTranscriptJsonlPath(this.sessionDir);
    return existsSync(path) ? path : undefined;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      json: this.statOrUndefined(getTranscriptJsonPath(this.sessionDir)),
      jsonl: this.statOrUndefined(getTranscriptJsonlPath(this.sessionDir))
    };
  }

  /** 仅降级路径用：整读一次 jsonl 重测尾部状态 */
  private remeasureJsonl(): void {
    const path = getTranscriptJsonlPath(this.sessionDir);
    const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
    this.jsonlTail = {
      bytes: Buffer.byteLength(raw, "utf-8"),
      lines: raw.split("\n").filter((line) => line.trim().length > 0).length,
      endsWithNewline: raw.endsWith("\n")
    };
  }

  appendModelChange(provider: string, modelId: string): void {
    const data = this.loadData();
    data.metadata.model = `${provider}/${modelId}`;
    data.metadata.updatedAt = new Date().toISOString();
    // 只改元数据，jsonl 内容不变，跳过其重写；slim 投影仅元数据
    writeTranscriptJson(this.sessionDir, data);
    this.refreshSnapshot();
  }

  appendMessage(message: RuntimeCoreAppendMessageInput): string {
    return this.appendMessages([message])[0]!;
  }

  appendMessages(messages: RuntimeCoreAppendMessageInput[]): string[] {
    // #527 三审①收官：jsonl 为状态源——撕裂尾行/旧格式一侧不一致时先全量重建
    const forceRebuild = this.needsJsonlRebuild;
    const fastAppendEligible =
      !forceRebuild &&
      !!this.jsonlTail && this.snapshotsMatch({
        json: this.statOrUndefined(getTranscriptJsonPath(this.sessionDir)),
        jsonl: this.statOrUndefined(getTranscriptJsonlPath(this.sessionDir))
      });
    const data = this.loadData();
    const uuids: string[] = [];
    for (const message of messages) {
      const uuid = randomUUID();
      uuids.push(uuid);
      applyStoredMessage(data, message, uuid);
    }
    finalizeStoredData(data);
    // slim 元数据投影：追加成本降至常量级（消息权威在 jsonl）
    writeTranscriptJson(this.sessionDir, data);

    if (messages.length === 1) {
      const appended = data.sessionMessages[data.sessionMessages.length - 1]!;
      let appendedViaFastPath = false;
      if (fastAppendEligible) {
        try {
          const tail = this.jsonlTail!;
          const prefix = tail.bytes > 0 && !tail.endsWithNewline ? "\n" : "";
          const chunk = `${prefix}${JSON.stringify(appended)}\n`;
          appendFileSync(getTranscriptJsonlPath(this.sessionDir), chunk, "utf-8");
          this.jsonlTail = {
            bytes: tail.bytes + Buffer.byteLength(chunk, "utf-8"),
            lines: tail.lines + 1,
            endsWithNewline: true
          };
          appendedViaFastPath = true;
        } catch {
          appendedViaFastPath = false;
        }
      }
      if (!appendedViaFastPath || forceRebuild) {
        // 守卫路径：撕裂尾行/旧格式升级态直接重建；否则按磁盘真实行数
        // 判定是否退回全量重写（语义与旧实现一致）
        if (forceRebuild ||
          !tryAppendTranscriptJsonlLine(this.sessionDir, appended, data.sessionMessages.length - 1)) {
          rewriteTranscriptJsonl(this.sessionDir, data);
        }
        this.remeasureJsonl();
      }
      this.needsJsonlRebuild = false;
    } else {
      writeStoredData(this.sessionDir, data);
      const jsonlPayload = data.sessionMessages.map((message) => JSON.stringify(message)).join("\n");
      this.jsonlTail = {
        bytes: Buffer.byteLength(jsonlPayload, "utf-8"),
        lines: data.sessionMessages.length,
        endsWithNewline: false
      };
      this.needsJsonlRebuild = false;
    }
    this.refreshSnapshot();
    return uuids;
  }

  buildSessionContext(): RuntimeCoreSessionContext {
    const data = this.loadData();
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
