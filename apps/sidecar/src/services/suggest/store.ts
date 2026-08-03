import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSuggestionIndexPath } from "../infra/config-paths";
import { createLogger } from "../infra/logger";
import type {
  SuggestionCandidate,
  SuggestionRecord,
  SuggestionsIndex,
  SuggestionStats,
  SuggestionTypeWeights,
} from "@lume/shared";
import { DEFAULT_TYPE_WEIGHTS } from "@lume/shared";

const INDEX_VERSION = 1 as const;
const MAX_RECORDS = 500;
const STATUS_VALUES = new Set<SuggestionRecord["status"]>(["suggested", "accepted", "ignored", "never"]);
const FIELD_LIMITS = { title: 200, reason: 500, evidence: 500, duplicateKey: 200 } as const;
const KIND_KEYS = Object.keys(DEFAULT_TYPE_WEIGHTS) as (keyof SuggestionTypeWeights)[];
const log = createLogger("suggestion-store");

let cache: SuggestionsIndex | null = null;

function emptyIndex(): SuggestionsIndex {
  return {
    version: INDEX_VERSION,
    records: [],
    typeWeights: { ...DEFAULT_TYPE_WEIGHTS },
    enabled: true,
  };
}

function writeJsonAtomic(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptIndex(indexPath: string): void {
  if (!existsSync(indexPath)) return;
  const backupPath = `${indexPath}.corrupt-${Date.now()}`;
  try {
    renameSync(indexPath, backupPath);
    log.warn("backed up corrupt suggestion index", { backupPath });
  } catch (error) {
    log.warn("failed to back up corrupt suggestion index", { error, backupPath });
  }
}

function normalizeTypeWeights(raw: unknown): SuggestionTypeWeights {
  const base = { ...DEFAULT_TYPE_WEIGHTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const src = raw as Record<string, unknown>;
    for (const key of KIND_KEYS) {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        base[key] = v;
      }
    }
  }
  return base;
}

/** 结构校验：id>0、status 属枚举、必填字段存在且类型正确。字段长度截断由 normalizeRecord 处理。 */
export function isValidSuggestionRecord(raw: unknown): raw is SuggestionRecord {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || !(r.id > 0)) return false;
  if (typeof r.status !== "string" || !STATUS_VALUES.has(r.status as SuggestionRecord["status"])) return false;
  if (typeof r.duplicateKey !== "string") return false;
  if (typeof r.kind !== "string") return false;
  if (typeof r.title !== "string") return false;
  if (typeof r.reason !== "string") return false;
  if (typeof r.evidence !== "string") return false;
  if (typeof r.rawConfidence !== "number") return false;
  if (!r.action || typeof r.action !== "object") return false;
  if (typeof r.createdAt !== "number") return false;
  return true;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function normalizeRecord(rec: SuggestionRecord): SuggestionRecord {
  return {
    ...rec,
    title: truncate(rec.title, FIELD_LIMITS.title),
    reason: truncate(rec.reason, FIELD_LIMITS.reason),
    evidence: truncate(rec.evidence, FIELD_LIMITS.evidence),
    duplicateKey: truncate(rec.duplicateKey, FIELD_LIMITS.duplicateKey),
  };
}

function readIndex(): SuggestionsIndex {
  if (cache) return cache;
  const indexPath = getSuggestionIndexPath();
  if (!existsSync(indexPath)) {
    cache = emptyIndex();
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as Partial<SuggestionsIndex>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
      throw new Error("records 字段缺失或非数组");
    }
    const records = parsed.records.filter(isValidSuggestionRecord);
    cache = {
      version: INDEX_VERSION,
      records,
      typeWeights: normalizeTypeWeights(parsed.typeWeights),
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
    };
    return cache;
  } catch (error) {
    log.error("failed to read suggestion index", { error, indexPath });
    backupCorruptIndex(indexPath);
    cache = emptyIndex();
    return cache;
  }
}

function writeIndex(index: SuggestionsIndex): void {
  writeJsonAtomic(getSuggestionIndexPath(), JSON.stringify(index, null, 2));
  cache = index;
}

export function persistSuggestion(
  candidate: SuggestionCandidate,
  ctx?: { threadId?: string; workspaceSlug?: string; sessionId?: string },
): SuggestionRecord {
  const index = readIndex();
  const maxId = index.records.reduce((max, r) => (r.id > max ? r.id : max), 0);
  const record = normalizeRecord({
    ...candidate,
    id: maxId + 1,
    status: "suggested",
    createdAt: Date.now(),
    sessionId: ctx?.sessionId,
    threadId: ctx?.threadId,
    workspaceSlug: ctx?.workspaceSlug,
  });
  writeIndex({
    ...index,
    records: [record, ...index.records].slice(0, MAX_RECORDS),
  });
  return record;
}

export function listSuggestions(status?: SuggestionRecord["status"]): SuggestionRecord[] {
  const records = readIndex().records;
  if (!status) return [...records];
  return records.filter((r) => r.status === status);
}

export function deleteSuggestion(id: number): void {
  const index = readIndex();
  writeIndex({
    ...index,
    records: index.records.filter((r) => r.id !== id),
  });
}

export function clearSuggestions(): void {
  const index = readIndex();
  writeIndex({ ...index, records: [] });
}

export function suggestionStats(): SuggestionStats {
  const index = readIndex();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  let suggestedCount = 0;
  let todayAccepted = 0;
  let todayIgnored = 0;
  let todayNever = 0;
  for (const r of index.records) {
    if (r.status === "suggested") {
      suggestedCount++;
      continue;
    }
    if (typeof r.feedbackAt !== "number" || r.feedbackAt < todayMs) continue;
    if (r.status === "accepted") todayAccepted++;
    else if (r.status === "ignored") todayIgnored++;
    else if (r.status === "never") todayNever++;
  }
  return {
    suggestedCount,
    todayAccepted,
    todayIgnored,
    todayNever,
    typeWeights: { ...index.typeWeights },
  };
}

export function getEnabled(): boolean {
  return readIndex().enabled;
}

export function setEnabled(value: boolean): void {
  writeIndex({ ...readIndex(), enabled: value });
}

export function getTypeWeights(): SuggestionTypeWeights {
  return { ...readIndex().typeWeights };
}

export function resetSuggestionStoreForTest(): void {
  cache = null;
}
