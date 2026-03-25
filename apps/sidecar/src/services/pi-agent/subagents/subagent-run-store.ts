import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAgentConfigDir } from "../../infra/config-paths";
import { createLogger } from "../../infra/logger";
import {
  SUBAGENT_RUN_STORE_VERSION,
  type SubagentRun,
  type SubagentRunStoreSchema
} from "./subagent-run.types";

const log = createLogger("subagent-run-store");
const STORE_FILE = "subagent-runs.json";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function normalizeRun(raw: unknown): SubagentRun | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const parentSessionId = typeof record.parentSessionId === "string" ? record.parentSessionId.trim() : "";
  const parentRunId = typeof record.parentRunId === "string" ? record.parentRunId.trim() : undefined;
  const rootSessionId = typeof record.rootSessionId === "string"
    ? record.rootSessionId.trim()
    : parentSessionId;
  const depth = typeof record.depth === "number" && Number.isFinite(record.depth)
    ? Math.max(0, Math.floor(record.depth))
    : 1;
  const childSessionId = typeof record.childSessionId === "string" ? record.childSessionId.trim() : "";
  const task = typeof record.task === "string" ? record.task : "";
  const status = typeof record.status === "string" ? record.status : "accepted";
  const cleanup = record.cleanup === "delete" ? "delete" : "keep";
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt;

  if (!runId || !parentSessionId || !childSessionId || !task) return null;

  const outcomeRaw = record.outcome;
  const outcome = outcomeRaw && typeof outcomeRaw === "object"
    ? {
      output: typeof (outcomeRaw as Record<string, unknown>).output === "string"
        ? (outcomeRaw as Record<string, unknown>).output as string
        : undefined,
      error: typeof (outcomeRaw as Record<string, unknown>).error === "string"
        ? (outcomeRaw as Record<string, unknown>).error as string
        : undefined,
      errorCode: typeof (outcomeRaw as Record<string, unknown>).errorCode === "string"
        ? (outcomeRaw as Record<string, unknown>).errorCode as string
        : undefined,
      usageEvents: typeof (outcomeRaw as Record<string, unknown>).usageEvents === "number"
        ? (outcomeRaw as Record<string, unknown>).usageEvents as number
        : undefined
    }
    : undefined;

  return {
    runId,
    parentSessionId,
    parentRunId: parentRunId && parentRunId.length > 0 ? parentRunId : undefined,
    rootSessionId: rootSessionId || parentSessionId,
    depth,
    childSessionId,
    deliverySessionId: typeof record.deliverySessionId === "string" ? record.deliverySessionId : undefined,
    threadRequested: record.threadRequested === true,
    threadBound: record.threadBound === true,
    label: typeof record.label === "string" ? record.label : undefined,
    task,
    status: status as SubagentRun["status"],
    cleanup,
    parentToolUseId: typeof record.parentToolUseId === "string" ? record.parentToolUseId : undefined,
    requestedAgentId: typeof record.requestedAgentId === "string" ? record.requestedAgentId : undefined,
    resolvedAgentId: typeof record.resolvedAgentId === "string" ? record.resolvedAgentId : undefined,
    channelId: typeof record.channelId === "string" ? record.channelId : undefined,
    modelId: typeof record.modelId === "string" ? record.modelId : undefined,
    announceStatus: (
      record.announceStatus === "pending"
      || record.announceStatus === "delivered"
      || record.announceStatus === "failed"
    ) ? record.announceStatus : undefined,
    announceAttempts: typeof record.announceAttempts === "number" ? record.announceAttempts : undefined,
    announceLastError: typeof record.announceLastError === "string" ? record.announceLastError : undefined,
    announceDeliveredAt: typeof record.announceDeliveredAt === "number" ? record.announceDeliveredAt : undefined,
    createdAt,
    updatedAt,
    startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
    endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
    outcome
  };
}

export function getSubagentRunStorePath(): string {
  return `${getAgentConfigDir()}/${STORE_FILE}`;
}

export function readSubagentRunStore(): SubagentRunStoreSchema {
  const path = getSubagentRunStorePath();
  if (!existsSync(path)) {
    return {
      version: SUBAGENT_RUN_STORE_VERSION,
      runs: []
    };
  }

  try {
    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") {
      return {
        version: SUBAGENT_RUN_STORE_VERSION,
        runs: []
      };
    }

    const record = parsed as Record<string, unknown>;
    const runs = Array.isArray(record.runs)
      ? record.runs.map(normalizeRun).filter((item): item is SubagentRun => !!item)
      : [];

    return {
      version: SUBAGENT_RUN_STORE_VERSION,
      runs
    };
  } catch (error) {
    log.warn("读取 subagent run store 失败，使用空数据", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      version: SUBAGENT_RUN_STORE_VERSION,
      runs: []
    };
  }
}

export function writeSubagentRunStore(schema: SubagentRunStoreSchema): void {
  const path = getSubagentRunStorePath();
  const payload = JSON.stringify(schema, null, 2);
  writeAtomic(path, payload);
}
