import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { getAgentConfigDir } from "../../infra/config-paths";

function toSafeSessionSegment(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error("runtime-core sessionId 不能为空");
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getRuntimeCoreAgentDir(agentDir?: string): string {
  const dir = agentDir ?? join(getAgentConfigDir(), "runtime-core");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRuntimeCoreSessionDirPath(lumeSessionId: string, agentDir?: string): string {
  const baseDir = agentDir ?? join(getAgentConfigDir(), "runtime-core");
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
    return readdirSync(sessionDir).some((name) => name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

export function createOrResumeRuntimeCoreSessionManager(
  cwd: string,
  lumeSessionId: string,
  agentDir?: string
): SessionManager {
  return SessionManager.continueRecent(cwd, getRuntimeCoreSessionDir(lumeSessionId, agentDir));
}
