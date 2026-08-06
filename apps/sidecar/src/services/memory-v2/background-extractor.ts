import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@lume/agent-sdk";
import { AGENT_IPC_CHANNELS, type LumeRuntimeEvent, type MemoryEvidenceRef } from "@lume/shared";
import { appendAgentThreadSDKMessages } from "../agent/agent-thread-manager";
import { emitAgentNotification } from "../agent/agent-notification-service";
import type { LumeRunItem } from "../agent-runtime/runner/run-items";
import { MemoryCommandService, hasMemoryMutationForRun } from "./command-service";
import { extractMemoryBatchCandidatesWithLlm } from "./extraction";
import { getMemoryV2ScopePaths } from "./paths";
import type { MemoryV2MutationReceipt } from "./types";

export interface BackgroundMemoryExtractionRequest {
  threadId: string;
  runId: string;
  workspaceSlug: string;
  modelRef?: string;
  threadType?: string;
  chatType?: string;
  items: LumeRunItem[];
}

interface ThreadQueueState {
  running: boolean;
  trailing?: BackgroundMemoryExtractionRequest;
}

interface ExtractionCursor {
  threadId: string;
  cursor: number;
  lastIdempotencyKey?: string;
  lastRunId?: string;
  status: "idle" | "running" | "completed" | "failed" | "skipped";
  updatedAt: string;
  error?: string;
}

const queues = new Map<string, ThreadQueueState>();

export function enqueueBackgroundMemoryExtraction(input: BackgroundMemoryExtractionRequest): void {
  if (input.threadType === "subagent" || input.chatType === "group" || input.chatType === "channel") return;
  const state = queues.get(input.threadId) ?? { running: false };
  if (state.running) {
    state.trailing = input;
    queues.set(input.threadId, state);
    return;
  }
  state.running = true;
  queues.set(input.threadId, state);
  setTimeout(() => void runQueued(input), 0);
}

async function runQueued(input: BackgroundMemoryExtractionRequest): Promise<void> {
  try {
    await runExtraction(input);
  } finally {
    const state = queues.get(input.threadId);
    if (!state) return;
    const trailing = state.trailing;
    if (trailing) {
      state.trailing = undefined;
      setTimeout(() => void runQueued(trailing), 0);
      return;
    }
    queues.delete(input.threadId);
  }
}

async function runExtraction(input: BackgroundMemoryExtractionRequest): Promise<void> {
  const sources = extractionSources(input.items);
  const cursor = readCursor(input);
  if (cursor.lastRunId === input.runId && (cursor.status === "completed" || cursor.status === "skipped")) return;
  const fromSequence = cursor.cursor;
  const toSequence = fromSequence + sources.length;
  const idempotencyKey = `${input.threadId}:${fromSequence}:${toSequence}`;
  if (cursor.lastIdempotencyKey === idempotencyKey && cursor.status === "completed") return;
  writeCursor(input, { ...cursor, status: "running", updatedAt: new Date().toISOString() });

  if (hasMemoryMutationForRun({ workspaceSlug: input.workspaceSlug, runId: input.runId, actor: "main_agent" })) {
    writeCursor(input, completedCursor(cursor, input, toSequence, idempotencyKey, "skipped"));
    return;
  }
  if (sources.length === 0) {
    writeCursor(input, completedCursor(cursor, input, toSequence, idempotencyKey, "skipped"));
    return;
  }

  try {
    const sourceRoles = new Map(sources.map((source) => [source.sourceId, source.role]));
    const extracted = await extractMemoryBatchCandidatesWithLlm({
      sources: sources.map(({ sourceId, text }) => ({ sourceId, text })),
      workspaceSlug: input.workspaceSlug,
      modelRef: input.modelRef
    });
    const service = new MemoryCommandService();
    const receipts: MemoryV2MutationReceipt[] = [];
    for (const item of extracted) {
      const role = sourceRoles.get(item.sourceId);
      // Assistant text is useful context for extraction, but can never be the sole evidence.
      if (role === "assistant") continue;
      const source = sources.find((candidate) => candidate.sourceId === item.sourceId);
      const evidenceType: MemoryEvidenceRef["type"] = role === "tool_result" ? "tool_result" : "user_message";
      receipts.push(await service.remember({
        workspaceSlug: input.workspaceSlug,
        content: item.candidate.statement,
        scope: item.candidate.targetScope,
        legacyKind: item.candidate.kind,
        semanticRole: item.candidate.semanticRole,
        facets: item.candidate.facets ?? item.candidate.tags,
        confidence: item.candidate.confidence,
        claim: item.candidate.claim,
        evidenceRefs: [{ type: evidenceType, id: item.sourceId, runId: input.runId, threadId: input.threadId, quote: source?.text }],
        actor: "background_extract",
        runId: input.runId,
        threadId: input.threadId
      }));
    }
    const changed = receipts.filter((receipt) => receipt.action === "created" || receipt.action === "updated" || receipt.action === "superseded" || receipt.action === "pending");
    writeCursor(input, completedCursor(cursor, input, toSequence, idempotencyKey, "completed"));
    if (changed.length > 0) notifyMemorySaved(input, changed);
  } catch (error) {
    writeCursor(input, {
      ...cursor,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function extractionSources(items: LumeRunItem[]): Array<{ sourceId: string; role: "user" | "assistant" | "tool_result"; text: string }> {
  const sources: Array<{ sourceId: string; role: "user" | "assistant" | "tool_result"; text: string }> = [];
  for (const item of items) {
    if (item.type === "user_message") {
      const text = readableText(item.content);
      if (text) sources.push({ sourceId: item.id, role: "user", text });
    } else if (item.type === "assistant_message" && !item.subagentRunId) {
      const text = readableText(item.content);
      if (text) sources.push({ sourceId: item.id, role: "assistant", text });
    } else if (item.type === "tool_result" && !item.isError && !item.subagentRunId) {
      const text = readableText(item.output);
      if (text) sources.push({ sourceId: item.id, role: "tool_result", text });
    }
  }
  return sources;
}

function readableText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(readableText).filter(Boolean).join("\n").trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text.trim();
  if (typeof record.content === "string") return record.content.trim();
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 12_000 ? serialized.slice(0, 12_000) : serialized;
  } catch {
    return "";
  }
}

function notifyMemorySaved(input: BackgroundMemoryExtractionRequest, receipts: MemoryV2MutationReceipt[]): void {
  const memoryIds = Array.from(new Set(receipts.flatMap((receipt) => receipt.memoryIds)));
  const pendingCount = receipts.filter((receipt) => receipt.action === "pending").length;
  const savedCount = receipts.length - pendingCount;
  const summary = [savedCount > 0 ? `后台记住了 ${savedCount} 条信息` : "", pendingCount > 0 ? `${pendingCount} 条等待处理` : ""]
    .filter(Boolean).join(" · ");
  const createdAt = new Date().toISOString();
  const details = receipts.map((receipt) => ({
    mutationId: receipt.mutationId,
    action: receipt.action,
    scope: receipt.scope,
    memoryIds: receipt.memoryIds,
    summary: receipt.summary,
    undoable: receipt.undoable
  }));
  const message: SDKMessage = {
    type: "system",
    subtype: "memory_saved",
    session_id: input.threadId,
    run_id: input.runId,
    workspace_slug: input.workspaceSlug,
    mutation_ids: receipts.map((receipt) => receipt.mutationId),
    memory_ids: memoryIds,
    summary,
    created_at: createdAt,
    details,
    uuid: randomUUID()
  };
  appendAgentThreadSDKMessages(input.threadId, [message]);
  const event: Extract<LumeRuntimeEvent, { type: "memory.changed" }> = {
    id: `${input.runId}:memory.changed:${receipts[0]!.mutationId}`,
    type: "memory.changed",
    threadId: input.threadId,
    runId: input.runId,
    createdAt,
    actor: "background_extract",
    workspaceSlug: input.workspaceSlug,
    mutationIds: receipts.map((receipt) => receipt.mutationId),
    memoryIds,
    summary,
    details
  };
  emitAgentNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: input.threadId, event });
}

function cursorPath(input: Pick<BackgroundMemoryExtractionRequest, "workspaceSlug" | "threadId">): string {
  const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: input.workspaceSlug });
  return join(paths.jobsDir, `extract-${input.threadId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function readCursor(input: BackgroundMemoryExtractionRequest): ExtractionCursor {
  const path = cursorPath(input);
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")) as ExtractionCursor; } catch { /* retry from zero */ }
  }
  return { threadId: input.threadId, cursor: 0, status: "idle", updatedAt: new Date(0).toISOString() };
}

function writeCursor(input: BackgroundMemoryExtractionRequest, cursor: ExtractionCursor): void {
  const path = cursorPath(input);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cursor, null, 2)}\n`, "utf-8");
  renameSync(temp, path);
}

function completedCursor(
  cursor: ExtractionCursor,
  input: BackgroundMemoryExtractionRequest,
  toSequence: number,
  idempotencyKey: string,
  status: "completed" | "skipped"
): ExtractionCursor {
  return {
    ...cursor,
    cursor: toSequence,
    lastIdempotencyKey: idempotencyKey,
    lastRunId: input.runId,
    status,
    updatedAt: new Date().toISOString(),
    error: undefined
  };
}
