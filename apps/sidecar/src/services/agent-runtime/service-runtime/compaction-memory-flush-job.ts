import type { SDKMessage } from "@lume/agent-sdk";
import { runStructuredMemoryFlush } from "../../memory/memory-flush-runner";
import { createLogger } from "../../infra/logger";
import type { ServiceRuntimeJob } from "./service-runtime";

const log = createLogger("compaction-memory-flush");

export function extractCompactSummary(message: SDKMessage): string | null {
  if (message.type !== "system" || message.subtype !== "compact_boundary") {
    return null;
  }
  const metadataSummary = (message as SDKMessage & {
    compact_metadata?: { summary?: unknown };
  }).compact_metadata?.summary;
  if (typeof metadataSummary === "string" && metadataSummary.trim()) {
    return metadataSummary.trim();
  }
  const legacySummary = (message as SDKMessage & { summary?: unknown }).summary;
  if (typeof legacySummary === "string" && legacySummary.trim()) {
    return legacySummary.trim();
  }
  return null;
}

function extractCompactMetadata(message: SDKMessage): {
  trigger?: string;
  policy?: string;
  sourceMessageIds?: string[];
} {
  if (message.type !== "system" || message.subtype !== "compact_boundary") {
    return {};
  }
  const metadata = (message as SDKMessage & {
    compact_metadata?: {
      trigger?: unknown;
      policy?: unknown;
      source_message_ids?: unknown;
    };
  }).compact_metadata;
  return {
    ...(typeof metadata?.trigger === "string" ? { trigger: metadata.trigger } : {}),
    ...(typeof metadata?.policy === "string" ? { policy: metadata.policy } : {}),
    ...(Array.isArray(metadata?.source_message_ids)
      ? { sourceMessageIds: metadata.source_message_ids.filter((item): item is string => typeof item === "string") }
      : {})
  };
}

export function createCompactionMemoryFlushJob(input: {
  workspaceSlug?: string;
  threadId: string;
  message: SDKMessage;
}): ServiceRuntimeJob | null {
  if (!input.workspaceSlug) return null;
  const summary = extractCompactSummary(input.message);
  if (!summary) return null;
  const metadata = extractCompactMetadata(input.message);

  return {
    id: `memory.flush:${input.threadId}:compact_boundary`,
    type: "memory.flush",
    run: async () => {
      const rawOutput = JSON.stringify({
        entries: [{
          kind: "episode",
          scope: "workspace",
          title: "Compaction summary",
          content: summary,
          importance: 3,
          confidence: 0.8,
          tags: [
            "compaction",
            "memory-flush",
            ...(metadata.trigger ? [`compaction:${metadata.trigger}`] : []),
            ...(metadata.policy ? [`policy:${metadata.policy}`] : [])
          ],
          sourceMessageIds: metadata.sourceMessageIds
        }]
      });
      const result = await runStructuredMemoryFlush({
        workspaceSlug: input.workspaceSlug!,
        sessionId: input.threadId,
        rawOutput
      });
      log.info("compaction memory flush completed", {
        threadId: input.threadId.slice(0, 8),
        workspaceSlug: input.workspaceSlug,
        savedCount: result.savedCount ?? 0,
        skippedCount: result.skippedCount ?? 0
      });
    }
  };
}
