import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { getAgentThreadMessages, listAgentThreads } from "../agent/agent-thread-manager";
import { normalizeSessionText } from "./session-memory-utils";
import { getRuntimeCoreSessionDirPath } from "../agent-runtime/runtime-core/session-store";
import type { AgentMessage } from "@lume/shared";

export interface ThreadFileEntry {
  path: string;
  absPath: string;
  source: "thread";
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

export function listThreadEntriesForWorkspace(workspaceId: string): ThreadFileEntry[] {
  const threads = listAgentThreads().filter((item) => item.workspaceId === workspaceId);
  const entries: ThreadFileEntry[] = [];

  for (const thread of threads) {
    const logicalPath = `threads/${thread.id}`;
    const absPath = getRuntimeCoreSessionDirPath(thread.id);
    const messages = getAgentThreadMessages(thread.id);
    const flattened = flattenSessionMessages(messages);
    if (!flattened.content.trim()) continue;
    const latestMessageTimestamp = messages.reduce((maxTimestamp, message) => {
      return Math.max(maxTimestamp, message.createdAt);
    }, 0);
    const contentSize = Buffer.byteLength(flattened.content, "utf-8");
    entries.push({
      path: logicalPath,
      absPath,
      source: "thread",
      mtimeMs: latestMessageTimestamp || thread.updatedAt,
      size: contentSize,
      hash: sha256(`${flattened.content}\n${flattened.lineMap.join(",")}`),
      content: flattened.content,
      lineMap: flattened.lineMap
    });
  }

  return entries;
}
