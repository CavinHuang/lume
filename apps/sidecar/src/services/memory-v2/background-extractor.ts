import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@lume/agent-sdk";
import { AGENT_IPC_CHANNELS, type AgentAskUserQuestionRequest, type AgentToolPermissionRequest, type LumeRuntimeEvent, type MemoryEvidenceRef } from "@lume/shared";
import { appendAgentThreadSDKMessages, createAgentThreadWithModelRef, getAgentThreadSDKMessages } from "../agent/agent-thread-manager";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import { sendAgentMessage } from "../agent/agent-service";
// #580 review fix:出站通知直连 infra 单点,不经 agent 域借道。
import { getOutboundNotificationWriter } from "../infra/outbound-notification";
import type { LumeRunItem } from "../agent-runtime/runtime-core/run-items";
import { MemoryCommandService, hasMemoryMutationForRun } from "./command-service";
import {
  buildBatchExtractionUserPrompt,
  extractMemoryBatchCandidatesWithLlm,
  parseLlmBatchExtractionResponse,
  resolveMemoryExtractionModelRefs
} from "./extraction";
import { claimFromEntry } from "./claim";
import { createMemoryV2Store } from "./markdown-store";
import { getMemoryV2ScopePaths } from "./paths";
import { getMemoryRuntimeConfig } from "./policy";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { resolveChannelModelBinding } from "../channel/channel-manager";
import type { MemoryV2MutationReceipt } from "./types";
import { maybeEnqueueAutoDream } from "./consolidation";
import { memoryJobService } from "./job-service";

export interface BackgroundMemoryExtractionRequest {
  threadId: string;
  runId: string;
  workspaceSlug: string;
  modelRef?: string;
  modelVisibleMessage?: string;
  threadType?: string;
  chatType?: string;
  items: LumeRunItem[];
}

interface ThreadQueueState {
  running: boolean;
  /** 待提取队列（FIFO）。单槽 trailing 会覆盖中间轮次——每轮请求只带当轮 items，覆盖即永久丢证（#408）。 */
  pending: BackgroundMemoryExtractionRequest[];
}

/**
 * 提取失败的批次暂存，并入该线程下一次提取，避免静默丢轮（#408）。
 * 仅内存态：提取成功即消费；skip/幂等短路路径退回（#450）；进程重启后丢失
 * （恢复链路只回放 interrupted 任务，failed 暂存批不重建）。
 */
const carriedBatches = new Map<string, LumeRunItem[][]>();

/** 测试专用：读取线程失败暂存批快照（#450 回归钉死）。 */
export function carriedBatchesForTests(threadId: string): LumeRunItem[][] {
  return [...(carriedBatches.get(threadId) ?? [])];
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

interface BackgroundExtractionProgress {
  phase: string;
  scannedItems: number;
  processedItems: number;
  changedItems: number;
}

interface BackgroundExtractionResult {
  scannedItems: number;
  changedItems: number;
}

// 全局并发上限:恢复旧 coordinator permit 语义。per-thread 的 queues 只保证同线程串行,
// 跨线程不互斥——多窗口/IM 批量会话同 turn 结束时若无此闸,隐藏 LLM 子代理会无上界拉起。
const MAX_CONCURRENT_MEMORY_EXTRACTIONS = 4;
let activeExtractions = 0;
const extractionWaiters: Array<() => void> = [];

async function acquireExtractionPermit(): Promise<void> {
  if (activeExtractions < MAX_CONCURRENT_MEMORY_EXTRACTIONS) {
    activeExtractions += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    extractionWaiters.push(() => {
      activeExtractions += 1;
      resolve();
    });
  });
}

function releaseExtractionPermit(): void {
  activeExtractions -= 1;
  extractionWaiters.shift()?.();
}

export function enqueueBackgroundMemoryExtraction(input: BackgroundMemoryExtractionRequest): void {
  if (!getMemoryRuntimeConfig().backgroundExtraction) return;
  if (input.threadType === "subagent" || input.chatType === "group" || input.chatType === "channel") return;
  const state = queues.get(input.threadId) ?? { running: false, pending: [] };
  if (state.running) {
    state.pending.push(input);
    queues.set(input.threadId, state);
    return;
  }
  state.running = true;
  queues.set(input.threadId, state);
  setTimeout(() => void runQueued(input), 0);
}

async function runQueued(input: BackgroundMemoryExtractionRequest): Promise<void> {
  await acquireExtractionPermit();
  try {
    const job = memoryJobService.start<BackgroundExtractionResult, BackgroundExtractionProgress>({
      kind: "turn_extract",
      workspaceSlug: input.workspaceSlug,
      idempotencyKey: `turn-extract:${input.threadId}:${input.runId}`,
      manual: false,
      payload: input,
      run: ({ report, signal }) => runExtraction(input, report, signal),
      onProgress: (current) => {
        if (current.progress?.changedItems) notifyExtractionProgress(input, current.jobId, current.progress);
      },
      onCompleted: (current) => {
        const result = current.result;
        if (result?.changedItems) notifyExtractionCompleted(input, current.jobId, result);
      }
    });
    await memoryJobService.waitForTerminal(input.workspaceSlug, job.jobId);
  } finally {
    releaseExtractionPermit();
    const state = queues.get(input.threadId);
    if (!state) return;
    const next = state.pending.shift();
    if (next) {
      // FIFO 逐轮提取：每轮请求只含当轮 items，覆盖式单槽会丢中间轮（#408）
      setTimeout(() => void runQueued(next), 0);
      return;
    }
    queues.delete(input.threadId);
  }
}

/** Re-queue automatic extraction jobs whose process died before they reached a terminal state. */
export function recoverBackgroundMemoryExtractionJobs(workspaceSlug: string): number {
  let recovered = 0;
  for (const job of memoryJobService.list(workspaceSlug)) {
    if (job.kind !== "turn_extract" || job.status !== "interrupted" || !job.payload) continue;
    const payload = job.payload as BackgroundMemoryExtractionRequest;
    if (payload.workspaceSlug !== workspaceSlug || !payload.threadId || !payload.runId) continue;
    enqueueBackgroundMemoryExtraction(payload);
    recovered += 1;
  }
  return recovered;
}

async function runExtraction(
  input: BackgroundMemoryExtractionRequest,
  report: (progress: BackgroundExtractionProgress) => void,
  signal: AbortSignal
): Promise<BackgroundExtractionResult> {
  signal.throwIfAborted();
  // 失败批次的 items 并入本轮：请求只带当轮 items，cursor 又停在旧位，
  // 不回放则失败轮的证据永久缺席（#408）
  const carried = carriedBatches.get(input.threadId) ?? [];
  carriedBatches.delete(input.threadId);
  // 本轮未实际提取而提前返回时把暂存批退回：已并入 mergedItems 的 carried 批
  // 若随 skip/幂等短路一起被 cursor 消费，证据将静默丢失（#450）。
  const restowCarried = () => {
    if (carried.length > 0) carriedBatches.set(input.threadId, carried);
  };
  const mergedItems = [...carried.flat(), ...input.items];
  const sources = extractionSources(mergedItems);
  const cursor = readCursor(input);
  if (cursor.lastRunId === input.runId && (cursor.status === "completed" || cursor.status === "skipped")) {
    restowCarried();
    return { scannedItems: 0, changedItems: 0 };
  }
  const fromSequence = cursor.cursor;
  const toSequence = fromSequence + sources.length;
  const idempotencyKey = `${input.threadId}:${fromSequence}:${toSequence}`;
  if (cursor.lastIdempotencyKey === idempotencyKey && cursor.status === "completed") {
    restowCarried();
    return { scannedItems: 0, changedItems: 0 };
  }
  writeCursor(input, { ...cursor, status: "running", updatedAt: new Date().toISOString() });

  if (hasMemoryMutationForRun({ workspaceSlug: input.workspaceSlug, runId: input.runId, actor: "main_agent" })) {
    restowCarried();
    writeCursor(input, completedCursor(cursor, input, toSequence, idempotencyKey, "skipped"));
    return { scannedItems: sources.length, changedItems: 0 };
  }
  if (sources.length === 0) {
    writeCursor(input, completedCursor(cursor, input, toSequence, idempotencyKey, "skipped"));
    return { scannedItems: 0, changedItems: 0 };
  }

  try {
    const sourceRoles = new Map(sources.map((source) => [source.sourceId, source.role]));
    const existingMemories = createMemoryV2Store().listEntries({
      workspaceSlug: input.workspaceSlug,
      scopes: ["global", "workspace"],
      includeStatuses: ["active", "suspected_stale"]
    }).map((entry) => {
      const claim = claimFromEntry(entry);
      return {
        id: entry.frontmatter.id,
        statement: entry.statement,
        ...(claim ? { claim } : {})
      };
    });
    report({
      phase: "分析新增对话和工具证据",
      scannedItems: sources.length,
      processedItems: 0,
      changedItems: 0
    });
    const extracted = await safeExtractMemoryCandidatesInSubagent({
      sources: sources.map(({ sourceId, role, text }) => ({ sourceId, role, text })),
      workspaceSlug: input.workspaceSlug,
      modelRef: input.modelRef,
      modelVisibleMessage: input.modelVisibleMessage,
      existingMemories,
      threadId: input.threadId,
      runId: input.runId,
      signal
    }) ?? await extractMemoryBatchCandidatesWithLlm({
      sources: sources.map(({ sourceId, role, text }) => ({ sourceId, role, text })),
      workspaceSlug: input.workspaceSlug,
      modelRef: input.modelRef,
      modelVisibleMessage: input.modelVisibleMessage,
      existingMemories,
      maxRounds: 5,
      agentMode: true,
      threadId: input.threadId,
      runId: input.runId
    });
    signal.throwIfAborted();
    const service = new MemoryCommandService();
    const receipts: MemoryV2MutationReceipt[] = [];
    for (const item of extracted) {
      signal.throwIfAborted();
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
    report({
      phase: "提交记忆变更",
      scannedItems: sources.length,
      processedItems: extracted.length,
      changedItems: changed.length
    });
    writeCursor(input, completedCursor(cursor, input, toSequence, idempotencyKey, "completed"));
    if (changed.length > 0) notifyMemorySaved(input, changed);
    maybeEnqueueAutoDream(input.workspaceSlug, {
      threadId: input.threadId,
      runId: input.runId,
      ...(input.modelRef ? { modelRef: input.modelRef } : {})
    });
    return { scannedItems: sources.length, changedItems: changed.length };
  } catch (error) {
    // 本批 items 连同先前暂存批一起退回（get 已在开头取空，必须用局部 carried，
    // 否则连败一轮即把更早的暂存批静默清空——#450）：cursor 不前进，但请求式
    // 扫描不会重放旧轮（#408）
    carriedBatches.set(input.threadId, [...carried, input.items]);
    writeCursor(input, {
      ...cursor,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

interface IndependentExtractionInput {
  sources: Array<{ sourceId: string; role: "user" | "assistant" | "tool_result"; text: string }>;
  workspaceSlug: string;
  modelRef?: string;
  modelVisibleMessage?: string;
  existingMemories: Array<{ id: string; statement: string; claim?: ReturnType<typeof claimFromEntry> }>;
  threadId: string;
  runId: string;
  signal: AbortSignal;
}

async function safeExtractMemoryCandidatesInSubagent(
  input: IndependentExtractionInput
): Promise<Awaited<ReturnType<typeof extractMemoryBatchCandidatesWithLlm>> | undefined> {
  try {
    return await extractMemoryCandidatesInSubagent(input);
  } catch {
    input.signal.throwIfAborted();
    return undefined;
  }
}

/**
 * Run extraction through the real persistent subagent runtime. The child thread
 * is hidden from the parent chat and receives only memory read tools; commits
 * remain in this Job's CommandService transaction after parsing its report.
 */
async function extractMemoryCandidatesInSubagent(
  input: IndependentExtractionInput
): Promise<Awaited<ReturnType<typeof extractMemoryBatchCandidatesWithLlm>> | undefined> {
  const config = getEffectiveLumeConfig(input.workspaceSlug);
  const modelRef = resolveMemoryExtractionModelRefs(config, { modelRef: input.modelRef })[0];
  const binding = modelRef ? resolveChannelModelBinding(modelRef, "chat") : undefined;
  const workspace = getAgentWorkspaceBySlug(input.workspaceSlug);
  if (!modelRef || !binding || !workspace) return undefined;

  const child = createAgentThreadWithModelRef(
    "Private memory extraction",
    modelRef,
    binding.channel.id,
    workspace.id,
    input.threadId,
    binding.modelId,
    { fileContextMode: "newRoot" }
  );
  {
    const emitter = createSilentAgentEmitter();
    await sendAgentMessage({
      threadId: child.id,
      userMessage: [
        "This is a hidden background task. Do not address the user directly.",
        "Return only the JSON extraction result after reviewing the evidence.",
        buildBatchExtractionUserPrompt(input.sources, input.workspaceSlug, input.modelVisibleMessage, input.existingMemories)
      ].join("\n\n"),
      modelRef,
      channelId: binding.channel.id,
      modelId: binding.modelId,
      workspaceId: workspace.id,
      threadType: "subagent",
      messageMetadata: {
        hiddenFromChat: true,
        memoryBackground: true,
        maxTurns: 5,
        toolPolicy: { allow: ["memory.search", "memory.read"] }
      }
    }, emitter, { abortSignal: input.signal });
    const text = extractAssistantText(getAgentThreadSDKMessages(child.id));
    const parsed = parseLlmBatchExtractionResponse(text, input.sources);
    if (!parsed) throw new Error("后台提取 Agent 未返回有效 JSON");
    return parsed;
  }
}

function extractAssistantText(messages: SDKMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.type === "assistant") {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        chunks.push(...content.flatMap((block) => {
          if (!block || typeof block !== "object") return [];
          const text = (block as { type?: unknown; text?: unknown }).text;
          return typeof text === "string" ? [text] : [];
        }));
      }
    }
    if (message.type === "result" && typeof message.result === "string") chunks.push(message.result);
  }
  return chunks.join("\n").trim();
}

function createSilentAgentEmitter() {
  return {
    onComplete: () => undefined,
    onError: () => undefined,
    onTitleUpdated: () => undefined,
    onAskUserQuestion: (_request: AgentAskUserQuestionRequest) => undefined,
    onToolPermissionRequest: (_request: AgentToolPermissionRequest) => undefined
  };
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
  const entriesById = new Map(createMemoryV2Store().listEntries({
    workspaceSlug: input.workspaceSlug,
    includeStatuses: ["active", "suspected_stale", "pending_conflict", "pending_low_confidence", "superseded", "archived"]
  }).map((entry) => [entry.frontmatter.id, entry]));
  const details = receipts.map((receipt) => ({
    mutationId: receipt.mutationId,
    action: receipt.action,
    scope: receipt.scope,
    memoryIds: receipt.memoryIds,
    summary: receipt.summary,
    undoable: receipt.undoable,
    entryPaths: receipt.memoryIds.flatMap((id) => {
      const entry = entriesById.get(id);
      return entry ? [entry.path] : [];
    }),
    sourcePaths: receipt.memoryIds.flatMap((id) => {
      const entry = entriesById.get(id);
      return entry?.frontmatter.evidence_refs.flatMap((ref) => ref.path ? [ref.path] : []) ?? [];
    })
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
  getOutboundNotificationWriter()?.(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: input.threadId, event });
}

function notifyExtractionProgress(
  input: BackgroundMemoryExtractionRequest,
  jobId: string,
  progress: BackgroundExtractionProgress
): void {
  const event: Extract<LumeRuntimeEvent, { type: "memory.job.progress" }> = {
    id: `${jobId}:progress:${progress.processedItems}`,
    type: "memory.job.progress",
    threadId: input.threadId,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    jobId,
    jobKind: "turn_extract",
    phase: progress.phase,
    scannedItems: progress.scannedItems,
    processedItems: progress.processedItems,
    changedItems: progress.changedItems
  };
  getOutboundNotificationWriter()?.(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: input.threadId, event });
}

function notifyExtractionCompleted(
  input: BackgroundMemoryExtractionRequest,
  jobId: string,
  result: BackgroundExtractionResult
): void {
  const createdAt = new Date().toISOString();
  const event: Extract<LumeRuntimeEvent, { type: "memory.job.completed" }> = {
    id: `${jobId}:completed`,
    type: "memory.job.completed",
    threadId: input.threadId,
    runId: input.runId,
    createdAt,
    jobId,
    jobKind: "turn_extract",
    status: "completed",
    summary: `后台提取完成，处理 ${result.scannedItems} 条来源，变更 ${result.changedItems} 条记忆`,
    changedItems: result.changedItems
  };
  getOutboundNotificationWriter()?.(AGENT_IPC_CHANNELS.RUNTIME_EVENT, { threadId: input.threadId, event });
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
