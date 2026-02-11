/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\config-paths.ts
 * Adaptation:
 * - Switched config root from `~/.proma` to `~/.lume`.
 * - Removed Electron-specific default-skills seeding logic from path utility.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

const CONFIG_DIR_NAME = ".lume";

function ensureDir(path: string, logLabel?: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    if (logLabel) {
      console.log(`[配置] 已创建${logLabel}: ${path}`);
    }
  }
  return path;
}

function assertSafeSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} 不能为空`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`${label} 不能包含路径分隔符`);
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`${label} 非法`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error(`${label} 包含非法字符`);
  }
  return trimmed;
}

function assertSafeRelativePath(value: string, label: string): string {
  const normalized = normalize(value).replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`${label} 非法`);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${label} 非法`);
  }
  return normalized.split("/").join(sep);
}

export function getConfigDir(): string {
  return ensureDir(join(homedir(), CONFIG_DIR_NAME), "配置目录");
}

export function getChannelsPath(): string {
  return join(getConfigDir(), "channels.json");
}

export function getConversationsIndexPath(): string {
  return join(getConfigDir(), "conversations.json");
}

export function getConversationsDir(): string {
  return ensureDir(join(getConfigDir(), "conversations"), "对话目录");
}

export function getConversationMessagesPath(id: string): string {
  const safeId = assertSafeSegment(id, "conversation id");
  return join(getConversationsDir(), `${safeId}.jsonl`);
}

export function getAttachmentsDir(): string {
  return ensureDir(join(getConfigDir(), "attachments"), "附件目录");
}

export function getConversationAttachmentsDir(conversationId: string): string {
  const safeConversationId = assertSafeSegment(conversationId, "conversation id");
  return ensureDir(join(getAttachmentsDir(), safeConversationId));
}

export function resolveAttachmentPath(localPath: string): string {
  const safeLocalPath = assertSafeRelativePath(localPath, "attachment path");
  return join(getAttachmentsDir(), safeLocalPath);
}

export function getSettingsPath(): string {
  return join(getConfigDir(), "settings.json");
}

export function getUserProfilePath(): string {
  return join(getConfigDir(), "user-profile.json");
}

export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), "agent-sessions.json");
}

export function getAgentSessionsDir(): string {
  return ensureDir(join(getConfigDir(), "agent-sessions"), "Agent 会话目录");
}

export function getAgentSessionMessagesPath(id: string): string {
  const safeId = assertSafeSegment(id, "agent session id");
  return join(getAgentSessionsDir(), `${safeId}.jsonl`);
}

export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), "agent-workspaces.json");
}

export function getAgentWorkspacesDir(): string {
  return ensureDir(join(getConfigDir(), "agent-workspaces"), "Agent 工作区目录");
}

export function getAgentWorkspacePath(slug: string): string {
  const safeSlug = assertSafeSegment(slug, "workspace slug");
  return ensureDir(join(getAgentWorkspacesDir(), safeSlug), "Agent 工作区");
}

export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), "mcp.json");
}

export function getWorkspaceSkillsDir(slug: string): string {
  return ensureDir(join(getAgentWorkspacePath(slug), "skills"));
}

export function getDefaultSkillsDir(): string {
  return ensureDir(join(getConfigDir(), "default-skills"));
}

export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  const safeSessionId = assertSafeSegment(sessionId, "agent session id");
  return ensureDir(
    join(getAgentWorkspacePath(workspaceSlug), safeSessionId),
    "Agent 会话工作目录"
  );
}
