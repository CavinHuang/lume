import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { listAgentSessions } from "../agent-session-manager";
import { getAgentSessionMessagesPath } from "../config-paths";
import {
  extractSessionText,
  parseSessionMessageRecord
} from "../openclaw/session-memory-utils";

export interface SessionFileEntry {
  path: string;
  absPath: string;
  source: "session";
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  lineMap: number[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function flattenSessionJsonl(filePath: string): { content: string; lineMap: number[] } {
  if (!existsSync(filePath)) {
    return { content: "", lineMap: [] };
  }
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const out: string[] = [];
  const lineMap: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const message = parseSessionMessageRecord(parsed);
      if (!message) continue;
      const text = extractSessionText(message.content);
      if (!text) continue;
      out.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
      lineMap.push(index + 1);
    } catch {
      continue;
    }
  }

  return {
    content: out.join("\n"),
    lineMap
  };
}

export function listSessionEntriesForWorkspace(workspaceId: string): SessionFileEntry[] {
  const sessions = listAgentSessions().filter((item) => item.workspaceId === workspaceId);
  const entries: SessionFileEntry[] = [];

  for (const session of sessions) {
    const absPath = getAgentSessionMessagesPath(session.id);
    if (!existsSync(absPath)) continue;
    const stat = statSync(absPath);
    const flattened = flattenSessionJsonl(absPath);
    if (!flattened.content.trim()) continue;
    const sessionName = basename(absPath);
    entries.push({
      path: `sessions/${sessionName}`,
      absPath,
      source: "session",
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: sha256(`${flattened.content}\n${flattened.lineMap.join(",")}`),
      content: flattened.content,
      lineMap: flattened.lineMap
    });
  }

  return entries;
}
