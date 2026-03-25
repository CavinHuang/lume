import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { getAgentSessionMessages, listAgentSessions } from "../agent/agent-session-manager";
import { normalizeSessionText } from "../openclaw/session-memory-utils";
import { getRuntimeCoreSessionDirPath } from "../pi-agent/runtime-core/session-store";
import type { AgentMessage } from "@lume/shared";

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

function flattenSessionMessages(messages: AgentMessage[]): { content: string; lineMap: number[] } {
  const out: string[] = [];
  const lineMap: number[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const text = normalizeSessionText(message.content);
    if (!text) continue;
    out.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
    lineMap.push(index + 1);
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
    const logicalPath = `sessions/${session.id}`;
    const absPath = getRuntimeCoreSessionDirPath(session.id);
    const messages = getAgentSessionMessages(session.id);
    const flattened = flattenSessionMessages(messages);
    if (!flattened.content.trim()) continue;
    const latestMessageTimestamp = messages.reduce((maxTimestamp, message) => {
      return Math.max(maxTimestamp, message.createdAt);
    }, 0);
    const contentSize = Buffer.byteLength(flattened.content, "utf-8");
    entries.push({
      path: logicalPath,
      absPath,
      source: "session",
      mtimeMs: latestMessageTimestamp || session.updatedAt,
      size: contentSize,
      hash: sha256(`${flattened.content}\n${flattened.lineMap.join(",")}`),
      content: flattened.content,
      lineMap: flattened.lineMap
    });
  }

  return entries;
}
