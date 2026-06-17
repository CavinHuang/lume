
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CONFIG_DIR_NAME = ".lume";
const ALICE_CONFIG_DIR_NAME = ".alice";

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

export function getConfigDir(): string {
  const fromEnv = process.env.LUME_CONFIG_DIR?.trim();
  if (fromEnv) {
    const resolved = isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
    return ensureDir(resolved, "配置目录");
  }
  return ensureDir(join(homedir(), CONFIG_DIR_NAME), "配置目录");
}

export function getAliceConfigDir(): string {
  const fromEnv = process.env.ALICE_CONFIG_DIR?.trim();
  if (fromEnv) {
    const resolved = isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
    return ensureDir(resolved, "Alice 兼容配置目录");
  }
  if (process.env.LUME_CONFIG_DIR?.trim()) {
    return ensureDir(join(getConfigDir(), ALICE_CONFIG_DIR_NAME), "Alice 兼容配置目录");
  }
  return ensureDir(join(homedir(), ALICE_CONFIG_DIR_NAME), "Alice 兼容配置目录");
}

export function getChannelsPath(): string {
  return join(getConfigDir(), "channels.json");
}

export function getImConfigPath(): string {
  return join(getConfigDir(), "im.json");
}

export function getImThreadBindingsPath(): string {
  return join(getConfigDir(), "im-thread-bindings.json");
}

export function getSettingsPath(): string {
  return join(getConfigDir(), "settings.json");
}

export function getGlobalMetaPath(): string {
  return ensureDir(join(getConfigDir(), ".meta"), "全局元数据目录");
}

export function getGlobalMemoryPath(): string {
  return join(getConfigDir(), "MEMORY.md");
}

export function getGlobalMemoryDbPath(): string {
  return join(getGlobalMetaPath(), "memory.sqlite");
}

export function getStructuredMemoryDir(): string {
  return ensureDir(join(getConfigDir(), "memory"), "记忆目录");
}

export function getGlobalStructuredMemoryPath(): string {
  return join(getStructuredMemoryDir(), "GLOBAL.md");
}

export function getGlobalStructuredMemoryDbPath(): string {
  return join(getStructuredMemoryDir(), "global.sqlite");
}

export function getGlobalMemoryAuditDbPath(): string {
  return join(getStructuredMemoryDir(), "audit.sqlite");
}

export function getLumeConfigYamlPath(): string {
  return join(getConfigDir(), "lume.yaml");
}

export function getLumeConfigAuditPath(): string {
  return join(getConfigDir(), "lume.audit.jsonl");
}

/**
 * 插件审计日志 jsonl 路径（Phase 4B）。与 lume.yaml 的 config audit 分离：
 * 独立 schema（PluginAuditEvent）+ 独立文件，便于按 pluginId 单独查询。
 */
export function getPluginAuditPath(): string {
  return join(getConfigDir(), "plugins-audit.jsonl");
}

export function getLumeJsonPath(): string {
  return join(getConfigDir(), "lume.json");
}

export function getUserProfilePath(): string {
  return join(getConfigDir(), "user-profile.json");
}

export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), "agent-sessions.json");
}

export function getAgentSessionsDir(): string {
  return ensureDir(join(getAgentConfigDir(), "sessions"), "Agent 会话数据目录");
}

export function getAgentThreadMessagesPath(threadId: string): string {
  const safeThreadId = assertSafeSegment(threadId, "agent thread id");
  return join(getAgentSessionsDir(), `${safeThreadId}.jsonl`);
}

export function getAgentSessionDataDir(sessionId: string): string {
  const safeSessionId = assertSafeSegment(sessionId, "agent session id");
  return ensureDir(join(getAgentSessionsDir(), safeSessionId), "Agent 会话数据目录");
}

export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), "agent-workspaces.json");
}

export function getSessionStatesPath(): string {
  return join(getConfigDir(), "session-states.json");
}

export function getAgentWorkspacesDir(): string {
  return ensureDir(join(getConfigDir(), "agent-workspaces"), "Agent 工作区目录");
}

export function getAgentWorkspacePath(slug: string): string {
  const safeSlug = assertSafeSegment(slug, "workspace slug");
  return ensureDir(join(getAgentWorkspacesDir(), safeSlug), "Agent 工作区");
}

export function getWorkspaceResourcesPath(workspaceSlug: string): string {
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), "resources"), "工作区共享文件目录");
}

export function getWorkspaceMetaPath(workspaceSlug: string): string {
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), ".meta"), "工作区元数据目录");
}

export function getWorkspaceMcpPath(slug: string): string {
  return join(getWorkspaceMetaPath(slug), "mcp.json");
}

export function getWorkspaceSkillsDir(slug: string): string {
  return ensureDir(join(getAgentWorkspacePath(slug), "skills"));
}

export function getDefaultSkillsDir(): string {
  return ensureDir(join(getConfigDir(), "default-skills"));
}

export function getUserSkillsDir(): string {
  return ensureDir(join(getConfigDir(), "skills"));
}

export function getAliceUserSkillsDir(): string {
  return ensureDir(join(getAliceConfigDir(), "skills"));
}

export function getAgentThreadRootPath(workspaceSlug: string, threadId: string): string {
  const safeThreadId = assertSafeSegment(threadId, "agent thread id");
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), "threads", safeThreadId), "Agent 线程根目录");
}

export function getAgentThreadFilesPath(workspaceSlug: string, threadId: string): string {
  return ensureDir(join(getAgentThreadRootPath(workspaceSlug, threadId), "files"), "Agent 线程文件目录");
}

export function getAgentThreadPlansPath(workspaceSlug: string, threadId: string): string {
  return ensureDir(join(getAgentThreadRootPath(workspaceSlug, threadId), "plans"), "Agent 线程计划目录");
}

export function getAgentThreadArtifactsPath(workspaceSlug: string, threadId: string): string {
  return ensureDir(join(getAgentThreadRootPath(workspaceSlug, threadId), "artifacts"), "Agent 线程产物目录");
}

export function getAgentThreadSystemContextPath(workspaceSlug: string, threadId: string): string {
  return ensureDir(join(getAgentThreadRootPath(workspaceSlug, threadId), ".context"), "Agent 线程上下文目录");
}

export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  return getAgentThreadRootPath(workspaceSlug, sessionId);
}

export function getWorkspaceMemoryDir(workspaceSlug: string): string {
  return ensureDir(join(getAgentWorkspacePath(workspaceSlug), "memory"), "记忆目录");
}

export function getWorkspaceLongTermMemoryPath(workspaceSlug: string): string {
  return join(getAgentWorkspacePath(workspaceSlug), "MEMORY.md");
}

export function getWorkspaceMemoryDbPath(workspaceSlug: string): string {
  return join(getWorkspaceMetaPath(workspaceSlug), "memory.sqlite");
}

export function getMemoryConfigDir(): string {
  return ensureDir(join(getConfigDir(), "memory"), "记忆配置目录");
}

export function getMemoryConfigPath(): string {
  return join(getMemoryConfigDir(), "config.json");
}

export function getMemoryLocalModelsDir(): string {
  return ensureDir(join(getMemoryConfigDir(), "models"), "记忆本地模型目录");
}

export function getAgentConfigDir(): string {
  return ensureDir(join(getConfigDir(), "agent"), "Agent 配置目录");
}

export function getAgentRuntimeConfigPath(): string {
  return join(getAgentConfigDir(), "config.json");
}

export function getAutomationConfigDir(): string {
  return ensureDir(join(getConfigDir(), "automation"), "自动化配置目录");
}

export function getAutomationJobsPath(): string {
  return join(getAutomationConfigDir(), "jobs.json");
}

export function getAutomationRunsDir(): string {
  return ensureDir(join(getAutomationConfigDir(), "runs"), "自动化运行记录目录");
}

export function getAutomationRunsPath(): string {
  return join(getAutomationRunsDir(), "all.jsonl");
}

export function getReadingDir(): string {
  return ensureDir(join(getConfigDir(), "reading"), "读书目录");
}

export function getReadingLibraryPath(): string {
  return join(getReadingDir(), "library.json");
}

export function getReadingSettingsPath(): string {
  return join(getReadingDir(), "settings.json");
}

export function getReadingNotesDir(): string {
  return ensureDir(join(getReadingDir(), "notes"), "读书笔记目录");
}

export function getReadingAssetsDir(): string {
  return ensureDir(join(getReadingDir(), "assets"), "读书资源目录");
}

export function getReadingCoversDir(): string {
  return ensureDir(join(getReadingAssetsDir(), "covers"), "读书封面目录");
}

export function getReadingShareCardsDir(): string {
  return ensureDir(join(getReadingAssetsDir(), "share-cards"), "读书分享卡片目录");
}

export function getReadingExportsDir(): string {
  return ensureDir(join(getReadingDir(), "exports"), "读书导出目录");
}

export function getReadingQuotesPath(): string {
  return join(getReadingDir(), "quotes.json");
}

export function getReadingRunsDir(): string {
  return ensureDir(join(getReadingDir(), "runs"), "读书运行记录目录");
}

export function getReadingWereadCachePath(): string {
  return join(getReadingDir(), "weread-cache.json");
}

export function getRoutineDir(): string {
  return ensureDir(join(getConfigDir(), "routine"), "日程数据目录");
}

export function getRoutineSchedulesDir(): string {
  return ensureDir(join(getRoutineDir(), "schedules"), "日程表目录");
}

export function getRoutineSchedulePath(date: string): string {
  return join(getRoutineSchedulesDir(), `${date}.json`);
}

export function getRoutineRunsPath(): string {
  return join(getRoutineDir(), "runs.jsonl");
}

export function getPluginsCacheDir(): string {
  return ensureDir(join(getConfigDir(), "plugins", "cache"), "插件缓存目录");
}

export function getPluginsDataDir(): string {
  return ensureDir(join(getConfigDir(), "plugins", "data"), "插件数据目录");
}

/** 全局向量索引目录（~/.lume/memory/index） */
export function getGlobalVectorIndexDir(): string {
  return ensureDir(join(getStructuredMemoryDir(), "index"), "全局向量索引目录");
}

/** 工作区向量索引目录（agent-workspaces/<slug>/memory/index） */
export function getWorkspaceVectorIndexDir(workspaceSlug: string): string {
  return ensureDir(join(getWorkspaceMemoryDir(workspaceSlug), "index"), "工作区向量索引目录");
}
