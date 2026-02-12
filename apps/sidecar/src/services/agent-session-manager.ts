/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-session-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Config root and paths are resolved by sidecar `config-paths` (`~/.lume`).
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  rm,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentSessionMeta } from "@lume/shared";
import {
  getAgentSessionMessagesPath,
  getAgentSessionWorkspacePath,
  getAgentSessionsDir,
  getAgentSessionsIndexPath
} from "./config-paths";
import { getAgentWorkspace } from "./agent-workspace-manager";

interface AgentSessionsIndex {
  version: number;
  sessions: AgentSessionMeta[];
}

const INDEX_VERSION = 1;

function readIndex(): AgentSessionsIndex {
  const indexPath = getAgentSessionsIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, sessions: [] };
  }

  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as AgentSessionsIndex;
  } catch (error) {
    console.error("[Agent 会话] 读取索引文件失败:", error);
    return { version: INDEX_VERSION, sessions: [] };
  }
}

function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = getAgentSessionsIndexPath();
  try {
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  } catch (error) {
    console.error("[Agent 会话] 写入索引文件失败:", error);
    throw new Error("写入 Agent 会话索引失败");
  }
}

export function listAgentSessions(): AgentSessionMeta[] {
  return readIndex().sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  return readIndex().sessions.find((session) => session.id === id);
}

export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string
): AgentSessionMeta {
  const index = readIndex();
  const now = Date.now();

  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || "新 Agent 会话",
    channelId,
    workspaceId,
    createdAt: now,
    updatedAt: now
  };

  index.sessions.push(meta);
  writeIndex(index);

  getAgentSessionsDir();

  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      getAgentSessionWorkspacePath(workspace.slug, meta.id);
    }
  }

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`);
  return meta;
}

export function getAgentSessionMessages(id: string): AgentMessage[] {
  const filePath = getAgentSessionMessagesPath(id);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AgentMessage);
  } catch (error) {
    console.error(`[Agent 会话] 读取消息失败 (${id}):`, error);
    return [];
  }
}

export function appendAgentMessage(id: string, message: AgentMessage): void {
  const filePath = getAgentSessionMessagesPath(id);
  try {
    appendFileSync(filePath, `${JSON.stringify(message)}\n`, "utf-8");
  } catch (error) {
    console.error(`[Agent 会话] 追加消息失败 (${id}):`, error);
    throw new Error("追加 Agent 消息失败");
  }
}

export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, "title" | "channelId" | "sdkSessionId" | "workspaceId">>
): AgentSessionMeta {
  const index = readIndex();
  const idx = index.sessions.findIndex((session) => session.id === id);
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`);
  }

  const existing = index.sessions[idx] as AgentSessionMeta;
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    updatedAt: Date.now()
  };

  index.sessions[idx] = updated;
  writeIndex(index);

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`);
  return updated;
}

export function deleteAgentSession(id: string): void {
  const index = readIndex();
  const idx = index.sessions.findIndex((session) => session.id === id);
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`);
  }

  const removed = index.sessions.splice(idx, 1)[0] as AgentSessionMeta;
  writeIndex(index);

  const filePath = getAgentSessionMessagesPath(id);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch (error) {
      console.warn(`[Agent 会话] 删除消息文件失败 (${id}):`, error);
    }
  }

  if (removed.workspaceId) {
    const workspace = getAgentWorkspace(removed.workspaceId);
    if (workspace) {
      try {
        const sessionDir = getAgentSessionWorkspacePath(workspace.slug, id);
        if (existsSync(sessionDir)) {
          rm(sessionDir, { recursive: true, force: true }, (error) => {
            if (error) {
              console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error);
              return;
            }
            console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDir}`);
          });
        }
      } catch (error) {
        console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error);
      }
    }
  }

  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`);
}
