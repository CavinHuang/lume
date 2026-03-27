import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@lume/shared";
import { getAgentSessionDataDir } from "../infra/config-paths";

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
  events?: AgentEvent[];
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

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
    console.warn(`[Agent 消息版本] 检测到损坏文件，已备份: ${backupPath}`);
  } catch (error) {
    console.warn("[Agent 消息版本] 备份损坏文件失败:", error);
  }
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
    console.error(`[Agent 消息版本] 读取版本文件失败 (${sessionId}):`, error);
    backupCorruptFile(path);
    return null;
  }
}

export function writeAgentMessageVersionStore(sessionId: string, store: AgentMessageVersionStore): void {
  const path = getAgentMessageVersionStorePath(sessionId);
  const payload: AgentMessageVersionStore = {
    ...normalizeStore(sessionId, store),
    version: STORE_VERSION,
    sessionId,
    updatedAt: Date.now()
  };
  writeTextAtomic(path, JSON.stringify(payload, null, 2));
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
