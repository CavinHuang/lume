import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SDKMessage } from "@lume/agent-sdk";
import { getAgentThreadMeta, getAgentThreadSDKMessages } from "../agent/agent-thread-manager";
import { getAgentWorkspaceBySlug } from "../agent/agent-workspace-manager";
import { redactArchiveRecord } from "./markdown-store";
import { memoryJobService } from "./job-service";
import { getMemoryV2ScopePaths } from "./paths";

const MAX_DREAM_THREADS = 20;
const MAX_DREAM_RUNS = 100;

export interface DreamEvidenceWindow {
  from: number;
  fromRunId?: string;
  to: number;
  toRunId?: string;
  threadIds: string[];
  runIds: string[];
  sessionsAvailable: number;
  hasMore: boolean;
}

export interface DreamEvidenceItem {
  id: string;
  sourceType: "user_message" | "assistant_message" | "tool_result" | "run_summary";
  threadId?: string;
  runId?: string;
  sourceId?: string;
  createdAt?: string;
  text: string;
}

export interface DreamEvidenceCursor {
  createdAt: number;
  runId: string;
}

interface RunEvidenceRecord {
  runId: string;
  threadId: string;
  createdAt: number;
  userMessage?: string;
  summary?: string;
  threadType?: string;
  chatType?: string;
}

export function buildDreamEvidenceWindow(input: {
  workspaceSlug: string;
  cursor: number | DreamEvidenceCursor;
  upperBound?: number;
  triggeringThreadId?: string;
}): DreamEvidenceWindow {
  const upperBound = input.upperBound ?? Date.now();
  const cursor = typeof input.cursor === "number" ? { createdAt: input.cursor, runId: "" } : input.cursor;
  const records = listCompletedRunEvidence(input.workspaceSlug)
    .filter((record) => isAfterCursor(record, cursor) && record.createdAt <= upperBound)
    .filter((record) => isEligibleMainThread(input.workspaceSlug, record))
    .sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId));
  const gateThreads = new Set(records.map((record) => record.threadId));
  const selected: RunEvidenceRecord[] = [];
  const selectedThreads = new Set<string>();
  for (const record of records) {
    if (selected.length >= MAX_DREAM_RUNS) break;
    if (!selectedThreads.has(record.threadId) && selectedThreads.size >= MAX_DREAM_THREADS) break;
    selected.push(record);
    selectedThreads.add(record.threadId);
  }
  return {
    from: cursor.createdAt,
    ...(cursor.runId ? { fromRunId: cursor.runId } : {}),
    to: selected.at(-1)?.createdAt ?? cursor.createdAt,
    ...(selected.at(-1) ? { toRunId: selected.at(-1)!.runId } : cursor.runId ? { toRunId: cursor.runId } : {}),
    threadIds: [...selectedThreads],
    runIds: selected.map((record) => record.runId),
    sessionsAvailable: gateThreads.size,
    hasMore: selected.length < records.length
  };
}

function isAfterCursor(record: RunEvidenceRecord, cursor: DreamEvidenceCursor): boolean {
  return record.createdAt > cursor.createdAt
    || (record.createdAt === cursor.createdAt && record.runId.localeCompare(cursor.runId) > 0);
}

export function loadDreamEvidenceForJob(workspaceSlug: string, jobId: string): DreamEvidenceItem[] {
  const job = memoryJobService.get(workspaceSlug, jobId);
  const payload = asRecord(job?.payload);
  const window = asDreamEvidenceWindow(payload?.evidenceWindow);
  if (!window) return [];
  const allowedRuns = new Set(window.runIds);
  const allowedThreads = new Set(window.threadIds);
  const items: DreamEvidenceItem[] = [];
  for (const record of listCompletedRunEvidence(workspaceSlug)) {
    if (!allowedRuns.has(record.runId) || !allowedThreads.has(record.threadId)) continue;
    if (record.userMessage) items.push(toEvidenceItem({
      sourceType: "user_message",
      threadId: record.threadId,
      runId: record.runId,
      sourceId: `${record.runId}:user`,
      createdAt: new Date(record.createdAt).toISOString(),
      text: record.userMessage
    }));
    if (record.summary) items.push(toEvidenceItem({
      sourceType: "run_summary",
      threadId: record.threadId,
      runId: record.runId,
      sourceId: `${record.runId}:summary`,
      createdAt: new Date(record.createdAt).toISOString(),
      text: record.summary
    }));
  }
  for (const threadId of allowedThreads) {
    for (const message of getAgentThreadSDKMessages(threadId)) {
      const runId = sdkRunId(message);
      if (!runId || !allowedRuns.has(runId)) continue;
      items.push(...evidenceItemsFromSdkMessage(threadId, runId, message));
    }
  }
  items.push(...loadContinuityEvidence(workspaceSlug, window));
  return dedupeEvidence(items);
}

export function searchDreamEvidence(input: {
  workspaceSlug: string;
  jobId: string;
  query: string;
  maxResults?: number;
  sourceTypes?: DreamEvidenceItem["sourceType"][];
}): DreamEvidenceItem[] {
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const allowedTypes = input.sourceTypes ? new Set(input.sourceTypes) : undefined;
  return loadDreamEvidenceForJob(input.workspaceSlug, input.jobId)
    .filter((item) => !allowedTypes || allowedTypes.has(item.sourceType))
    .map((item) => ({ item, score: terms.reduce((score, term) => score + (item.text.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(({ score }) => score > 0 || terms.length === 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(Math.max(input.maxResults ?? 10, 1), 20))
    .map(({ item }) => ({ ...item, text: compactText(item.text, 600) }));
}

export function readDreamEvidence(input: {
  workspaceSlug: string;
  jobId: string;
  evidenceId: string;
}): DreamEvidenceItem | undefined {
  return loadDreamEvidenceForJob(input.workspaceSlug, input.jobId)
    .find((item) => item.id === input.evidenceId);
}

function listCompletedRunEvidence(workspaceSlug: string): RunEvidenceRecord[] {
  const runsDir = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug }).runsDir;
  if (!runsDir || !existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
    const runId = basename(name, ".jsonl").replace(/^run_/, "");
    try {
      return readFileSync(join(runsDir, name), "utf-8").split("\n").filter(Boolean).flatMap((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type !== "run.completed" || typeof record.threadId !== "string") return [];
        const createdAt = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
        if (!Number.isFinite(createdAt)) return [];
        return [{
          runId,
          threadId: record.threadId,
          createdAt,
          ...(typeof record.userMessage === "string" ? { userMessage: record.userMessage } : {}),
          ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
          ...(typeof record.threadType === "string" ? { threadType: record.threadType } : {}),
          ...(typeof record.chatType === "string" ? { chatType: record.chatType } : {})
        }];
      });
    } catch {
      return [];
    }
  });
}

function isEligibleMainThread(workspaceSlug: string, record: RunEvidenceRecord): boolean {
  if (record.threadType === "subagent" || record.chatType === "group" || record.chatType === "channel") return false;
  const workspace = getAgentWorkspaceBySlug(workspaceSlug);
  const thread = getAgentThreadMeta(record.threadId);
  if (!workspace || !thread || thread.workspaceId !== workspace.id) return false;
  return !thread.parentThreadId;
}

function loadContinuityEvidence(workspaceSlug: string, window: DreamEvidenceWindow): DreamEvidenceItem[] {
  const scopes = [
    getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug }),
    getMemoryV2ScopePaths({ scope: "global" })
  ];
  const items: DreamEvidenceItem[] = [];
  for (const paths of scopes) {
    for (const name of safeList(paths.journalDir, ".jsonl")) {
      const path = join(paths.journalDir, name);
      try {
        for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
          const record = asRecord(JSON.parse(line));
          const receipt = asRecord(record?.receipt);
          const createdAt = typeof receipt?.createdAt === "string" ? Date.parse(receipt.createdAt) : NaN;
          if (!Number.isFinite(createdAt) || createdAt <= window.from || createdAt > window.to) continue;
          const snapshots = Array.isArray(record?.after) ? record.after : Array.isArray(record?.before) ? record.before : [];
          const statements = snapshots.flatMap((snapshot) => {
            const value = asRecord(snapshot);
            return typeof value?.statement === "string" ? [value.statement] : [];
          });
          const summary = typeof receipt?.summary === "string" ? receipt.summary : "记忆发生了变更";
          items.push(toEvidenceItem({
            sourceType: "run_summary",
            sourceId: typeof receipt?.mutationId === "string" ? receipt.mutationId : `${name}:${createdAt}`,
            createdAt: new Date(createdAt).toISOString(),
            text: [summary, ...statements].join("\n")
          }));
        }
      } catch {
        // A damaged continuity record must not make the whole Dream unreadable.
      }
    }
    for (const name of safeList(paths.dailyDir, ".md")) {
      const path = join(paths.dailyDir, name);
      try {
        const modifiedAt = statSync(path).mtimeMs;
        if (modifiedAt <= window.from || modifiedAt > window.to) continue;
        items.push(toEvidenceItem({
          sourceType: "run_summary",
          sourceId: `daily:${name}`,
          createdAt: new Date(modifiedAt).toISOString(),
          text: readFileSync(path, "utf-8")
        }));
      } catch {
        // Ignore a file that disappeared while the evidence snapshot was loaded.
      }
    }
  }
  return items;
}

function safeList(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
}

function evidenceItemsFromSdkMessage(threadId: string, runId: string, message: SDKMessage): DreamEvidenceItem[] {
  const record = message as unknown as Record<string, unknown>;
  const sourceId = typeof record.uuid === "string" ? record.uuid : `${runId}:${message.type}`;
  if (message.type === "user") {
    const content = asRecord(record.message)?.content;
    if (Array.isArray(content)) {
      return content.flatMap((block, index) => {
        const value = asRecord(block);
        if (!value) return [];
        if (value.type === "tool_result") {
          const text = textFromUnknown(value.content);
          return text ? [toEvidenceItem({ sourceType: "tool_result", threadId, runId, sourceId: String(value.tool_use_id ?? `${sourceId}:${index}`), text })] : [];
        }
        if (value.type === "text" && typeof value.text === "string") {
          return [toEvidenceItem({ sourceType: "user_message", threadId, runId, sourceId: `${sourceId}:${index}`, text: value.text })];
        }
        return [];
      });
    }
    const text = textFromUnknown(content);
    return text ? [toEvidenceItem({ sourceType: "user_message", threadId, runId, sourceId, text })] : [];
  }
  if (message.type === "assistant") {
    const content = asRecord(record.message)?.content;
    const text = Array.isArray(content)
      ? content.flatMap((block) => asRecord(block)?.type === "text" && typeof asRecord(block)?.text === "string" ? [String(asRecord(block)?.text)] : []).join("\n")
      : textFromUnknown(content);
    return text ? [toEvidenceItem({ sourceType: "assistant_message", threadId, runId, sourceId, text })] : [];
  }
  return [];
}

function sdkRunId(message: SDKMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>).run_id;
  return typeof value === "string" ? value : undefined;
}

function toEvidenceItem(input: Omit<DreamEvidenceItem, "id">): DreamEvidenceItem {
  const text = redactText(input.text);
  const id = `dream-evidence:${createHash("sha1").update([input.sourceType, input.threadId, input.runId, input.sourceId, text].join("\0")).digest("hex")}`;
  return { ...input, id, text };
}

function redactText(text: string): string {
  const record = redactArchiveRecord({ text });
  if (typeof record.text !== "string") return "";
  return record.text
    .replace(/(?:api[_-]?key|access[_-]?token|token|password|secret|密码|验证码)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
}

function dedupeEvidence(items: DreamEvidenceItem[]): DreamEvidenceItem[] {
  return [...new Map(items.filter((item) => item.text.trim()).map((item) => [item.id, item])).values()];
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return "";
}

function asDreamEvidenceWindow(value: unknown): DreamEvidenceWindow | undefined {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.threadIds) || !Array.isArray(record.runIds)) return undefined;
  return {
    from: typeof record.from === "number" ? record.from : 0,
    ...(typeof record.fromRunId === "string" ? { fromRunId: record.fromRunId } : {}),
    to: typeof record.to === "number" ? record.to : 0,
    ...(typeof record.toRunId === "string" ? { toRunId: record.toRunId } : {}),
    threadIds: record.threadIds.filter((item): item is string => typeof item === "string"),
    runIds: record.runIds.filter((item): item is string => typeof item === "string"),
    sessionsAvailable: typeof record.sessionsAvailable === "number" ? record.sessionsAvailable : 0,
    hasMore: record.hasMore === true
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
