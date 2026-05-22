import type {
  MemoryOrganizeHistoryActionCounts,
  MemoryOrganizeHistoryInput,
  MemoryOrganizeHistoryItem,
  MemoryOrganizeHistoryResult
} from "@lume/shared";
import { getAgentThreadMessages, listAgentThreads } from "../agent/agent-thread-manager";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import { extractMemoryCandidatesWithLlm } from "./extraction";
import { createMemoryV2Store } from "./markdown-store";
import { smartAddMemoryV2Candidate } from "./smart-add";
import type { MemoryV2Candidate } from "./types";

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
  const store = createMemoryV2Store();
  const actions = emptyActionCounts();
  const items: MemoryOrganizeHistoryItem[] = [];
  let candidateCount = 0;

  for (const message of messages) {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: message.text,
      workspaceSlug: input.workspaceSlug
    });
    for (const candidate of candidates) {
      candidateCount += 1;
      const result = smartAddMemoryV2Candidate({
        workspaceSlug: input.workspaceSlug,
        candidate: candidateWithHistoryEvidence(candidate, message),
        store
      });
      actions[result.action] += 1;
      items.push({
        sourcePath: message.sourcePath,
        sourceMessageId: message.messageId,
        statement: candidate.statement,
        scope: candidate.targetScope,
        kind: candidate.kind,
        confidence: candidate.confidence,
        action: result.action,
        reason: result.reason,
        ...(result.entry ? { entryId: result.entry.frontmatter.id } : {}),
        ...(result.pending ? { pendingId: result.pending.frontmatter.id } : {})
      });
    }
  }

  return {
    workspaceSlug: input.workspaceSlug,
    scannedSources,
    scannedMessages: messages.length,
    candidateCount,
    actions,
    items
  };
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

function candidateWithHistoryEvidence(
  candidate: MemoryV2Candidate,
  message: HistoryUserMessage
): MemoryV2Candidate {
  return {
    ...candidate,
    evidence: {
      ...candidate.evidence,
      recordIds: [
        ...new Set([
          ...(candidate.evidence?.recordIds ?? []),
          message.messageId
        ])
      ],
      sourceMessages: [
        ...new Set([
          ...(candidate.evidence?.sourceMessages ?? []),
          message.text
        ])
      ],
      sourcePaths: [
        ...new Set([
          ...(candidate.evidence?.sourcePaths ?? []),
          message.sourcePath
        ])
      ]
    }
  };
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.trunc(value as number)));
}

function emptyActionCounts(): MemoryOrganizeHistoryActionCounts {
  return {
    duplicate: 0,
    related: 0,
    mergeable: 0,
    conflict: 0,
    suspected_stale: 0,
    low_confidence: 0,
    new: 0,
    suppressed: 0
  };
}
