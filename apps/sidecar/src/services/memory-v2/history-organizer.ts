import type {
  MemoryOrganizeHistoryInput,
  MemoryOrganizeHistoryResult
} from "@lume/shared";
import { createLogger } from "../infra/logger";
import { getAgentThreadMessages, listAgentThreads } from "../agent/agent-thread-manager";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import { ingestMemorySources } from "./ingestion";

const log = createLogger("memory-v2.history-organizer");

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 1000;

interface HistoryUserMessage {
  messageId: string;
  sourcePath: string;
  text: string;
  createdAt: number;
}

export async function organizeMemoryHistory(
  input: MemoryOrganizeHistoryInput
): Promise<MemoryOrganizeHistoryResult> {
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug);
  if (!workspace) {
    throw new Error(`工作区不存在: ${input.workspaceSlug}`);
  }

  const limit = normalizeLimit(input.limit);
  const messages = collectWorkspaceUserMessages(workspace.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-limit);
  const scannedSources = new Set(messages.map((message) => message.sourcePath)).size;

  log.info("organizeMemoryHistory started", {
    workspaceSlug: input.workspaceSlug,
    scannedSources,
    scannedMessages: messages.length,
    limit
  });

  const result = await ingestMemorySources({
    workspaceSlug: input.workspaceSlug,
    sources: messages.map((message) => ({
      id: message.messageId,
      kind: "history",
      title: message.messageId,
      content: message.text,
      sourceRef: message.sourcePath,
      updatedAt: message.createdAt
    }))
  });

  const output = {
    workspaceSlug: input.workspaceSlug,
    scannedSources,
    scannedMessages: messages.length,
    candidateCount: result.candidateCount,
    actions: result.actions,
    items: result.items.map((item) => ({
      sourcePath: stripChunkSuffix(item.sourcePath),
      sourceMessageId: item.sourceId,
      statement: item.statement,
      scope: item.scope ?? "workspace",
      kind: item.kind ?? "fact",
      confidence: item.confidence ?? "medium",
      action: item.action,
      reason: item.reason,
      ...(item.entryId ? { entryId: item.entryId } : {}),
      ...(item.pendingId ? { pendingId: item.pendingId } : {})
    }))
  };

  log.info("organizeMemoryHistory completed", {
    workspaceSlug: input.workspaceSlug,
    scannedSources,
    scannedMessages: messages.length,
    candidateCount: output.candidateCount,
    actions: output.actions
  });

  return output;
}

function collectWorkspaceUserMessages(workspaceId: string): HistoryUserMessage[] {
  const messages: HistoryUserMessage[] = [];
  for (const thread of listAgentThreads()) {
    if (thread.workspaceId !== workspaceId) continue;
    for (const message of getAgentThreadMessages(thread.id)) {
      if (message.role !== "user") continue;
      const text = message.content.trim();
      if (!text) continue;
      messages.push({
        messageId: message.id,
        sourcePath: `threads/${thread.id}`,
        text,
        createdAt: message.createdAt
      });
    }
  }
  return messages;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.trunc(value as number)));
}

function stripChunkSuffix(path: string): string {
  return path.replace(/#chunk-\d+$/, "");
}
