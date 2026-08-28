import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { isCompactionSdkMessage, type FileReferenceBinding, type FileReferenceProtocolVersion, type SDKMessage } from "@lume/shared";
import { getAgentSessionDataDir } from "../infra/config-paths";
import { backupCorruptFile } from "../infra/corrupt-file-backup";
import { createLogger } from "../infra/logger";

export interface AgentMessageVersionGroupRecord {
  groupId: string;
  turnId: string;
  role: "user" | "assistant";
  latestMessageId: string;
  messageIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessageVersionRecord {
  messageId: string;
  groupId: string;
  role: "user" | "assistant";
  versionIndex: number;
  supersedesMessageId?: string;
  supersededByMessageId?: string;
  isLatestVersion: boolean;
  createdAt: number;
  content: string;
  reasoning?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  sdkMessages?: SDKMessage[];
  fileReferenceBinding?: FileReferenceBinding;
  fileReferenceProtocolVersion?: FileReferenceProtocolVersion;
}

export interface AgentMessageVersionStore {
  version: 1;
  sessionId: string;
  groups: AgentMessageVersionGroupRecord[];
  messages: AgentMessageVersionRecord[];
  visibleGroupIds: string[];
  updatedAt: number;
}

const STORE_VERSION = 1;
const STORE_FILENAME = "message-versions.json";
// #527-1：版本组回收上限。此前组只增不减——重发截断后的不可见旧分支会随会话
// 无限累积，写放大随之线性恶化。策略保守：仅裁剪「不在 visibleGroupIds」的组
// （被编辑链取代的历史分支），按 updatedAt 最旧优先；可见链与其最新版本记录
// 永不触碰。若不可见组不足以回落到上限（全可见超限），保持原样不裁。
const MAX_STORED_GROUPS = 300;
const log = createLogger("agent-message-version-store");

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

export function getAgentMessageVersionStorePath(sessionId: string): string {
  return join(getAgentSessionDataDir(sessionId), STORE_FILENAME);
}

export function createEmptyAgentMessageVersionStore(sessionId: string): AgentMessageVersionStore {
  return {
    version: STORE_VERSION,
    sessionId,
    groups: [],
    messages: [],
    visibleGroupIds: [],
    updatedAt: Date.now()
  };
}

function normalizeStore(sessionId: string, store: AgentMessageVersionStore): AgentMessageVersionStore {
  const normalizedGroups = store.groups.map((group) => ({
    ...group,
    turnId: typeof group.turnId === "string" && group.turnId.trim().length > 0
      ? group.turnId
      : `legacy-turn:${group.groupId}`
  }));
  const knownGroupIds = new Set(normalizedGroups.map((group) => group.groupId));
  const visibleGroupIds = Array.isArray(store.visibleGroupIds) && store.visibleGroupIds.length > 0
    ? store.visibleGroupIds.filter((groupId) => knownGroupIds.has(groupId))
    : normalizedGroups.map((group) => group.groupId);
  return {
    ...store,
    sessionId,
    groups: normalizedGroups,
    visibleGroupIds
  };
}

export function readAgentMessageVersionStore(sessionId: string): AgentMessageVersionStore | null {
  const path = getAgentMessageVersionStorePath(sessionId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as AgentMessageVersionStore;
    return normalizeStore(sessionId, parsed);
  } catch (error) {
    log.error("failed to read message version file", { error, sessionId });
    const backupPath = backupCorruptFile(path);
    if (backupPath) log.warn("backed up corrupt message version file", { backupPath });
    return null;
  }
}

/**
 * #527 遗留(sdkMessages 双留存去重):全局 sdkMessages.jsonl 是原始流唯一正典,
 * 版本 store 落盘时不再冗余持久化全量 SDK 片段——与传输裁剪(message-payload-trim)
 * 同口径,仅保留 compaction system 消息(前端会话恢复唯一所需)。仅裁磁盘字节,
 * 内存对象不动(内部链路语义不变);flatten 回退(jsonl 缺失时)仅服务旧数据,
 * 新写入消息所在 run 必然已补全 jsonl,回退面不扩大。
 */
function sdkMessagesForRecord(sdkMessages: SDKMessage[] | undefined): SDKMessage[] | undefined {
  if (!sdkMessages || sdkMessages.length === 0) return undefined;
  const compactionOnly = sdkMessages.filter(isCompactionSdkMessage);
  return compactionOnly.length > 0 ? compactionOnly : undefined;
}

export function writeAgentMessageVersionStore(sessionId: string, store: AgentMessageVersionStore): void {
  const path = getAgentMessageVersionStorePath(sessionId);
  const normalized = normalizeStore(sessionId, store);
  const prunedGroups = pruneInvisibleGroups(normalized.groups, normalized.visibleGroupIds);
  const messages = prunedGroups.droppedGroupIds.size > 0
    ? normalized.messages.filter((record) => !prunedGroups.droppedGroupIds.has(record.groupId))
    : normalized.messages;
  const payload: AgentMessageVersionStore = {
    ...normalized,
    groups: prunedGroups.groups,
    messages: messages.map((record) => ({ ...record, sdkMessages: sdkMessagesForRecord(record.sdkMessages) })),
    version: STORE_VERSION,
    sessionId,
    updatedAt: Date.now()
  };
  // #527-1：紧凑序列化降写放大——每次创建版本都会全量重写本文件，
  // pretty print 在长会话下让磁盘字节与耗时同步翻倍
  writeTextAtomic(path, JSON.stringify(payload));
}

/**
 * 超限时按 updatedAt 最旧优先裁剪不可见组；返回被裁组 id 集合供消息级联过滤。
 * 不可见组不足 excess 时能裁多少裁多少（随编辑链增长渐进收敛到上限）；
 * 可见组永不触碰——即使可见数量本身已超上限。
 */
function pruneInvisibleGroups(
  groups: AgentMessageVersionGroupRecord[],
  visibleGroupIds: string[]
): { groups: typeof groups; droppedGroupIds: Set<string> } {
  if (groups.length <= MAX_STORED_GROUPS) {
    return { groups, droppedGroupIds: new Set() };
  }
  const visible = new Set(visibleGroupIds);
  const excess = groups.length - MAX_STORED_GROUPS;
  const dropped = groups
    .filter((group) => !visible.has(group.groupId))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, excess);
  if (dropped.length === 0) {
    return { groups, droppedGroupIds: new Set() };
  }
  const droppedIds = new Set(dropped.map((group) => group.groupId));
  return {
    groups: groups.filter((group) => !droppedIds.has(group.groupId)),
    droppedGroupIds: droppedIds
  };
}

export function ensureAgentMessageVersionStore(sessionId: string): AgentMessageVersionStore {
  const existing = readAgentMessageVersionStore(sessionId);
  if (existing) {
    return existing;
  }
  const created = createEmptyAgentMessageVersionStore(sessionId);
  writeAgentMessageVersionStore(sessionId, created);
  return created;
}

export function resetAgentMessageVersionStore(sessionId: string): void {
  const path = getAgentMessageVersionStorePath(sessionId);
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}
