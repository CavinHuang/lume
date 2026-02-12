import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { listAgentSessions } from "../agent-session-manager";
import { getAgentSessionMessagesPath } from "../config-paths";

export interface SessionFileEntry {
  path: string;
  absPath: string;
  source: "session";
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSessionText(value: string): string {
  return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}

function flattenSessionJsonl(filePath: string): string {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { role?: unknown; content?: unknown };
      if (parsed.role !== "user" && parsed.role !== "assistant") continue;
      if (typeof parsed.content !== "string") continue;
      const text = normalizeSessionText(parsed.content);
      if (!text) continue;
      out.push(`${parsed.role === "user" ? "User" : "Assistant"}: ${text}`);
    } catch {
      continue;
    }
  }

  return out.join("\n");
}

export function listSessionEntriesForWorkspace(workspaceId: string): SessionFileEntry[] {
  const sessions = listAgentSessions().filter((item) => item.workspaceId === workspaceId);
  const entries: SessionFileEntry[] = [];

  for (const session of sessions) {
    const absPath = getAgentSessionMessagesPath(session.id);
    if (!existsSync(absPath)) continue;
    const stat = statSync(absPath);
    const flattened = flattenSessionJsonl(absPath);
    if (!flattened.trim()) continue;
    const sessionName = basename(absPath);
    entries.push({
      path: `sessions/${sessionName}`,
      absPath,
      source: "session",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: sha256(flattened),
      content: flattened
    });
  }

  return entries;
}
