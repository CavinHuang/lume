import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getImActiveFeishuCardsPath } from "../../infra/config-paths";
import { backupCorruptFile } from "../../infra/corrupt-file-backup";
import { withIndexMutationLock } from "../../infra/index-mutation-lock";
import { createLogger } from "../../infra/logger";
import type { ImRunCardState } from "./feishu-card-state";

const log = createLogger("im-feishu-card-recovery");
const CONFIG_VERSION = 1;
const SEQUENCE_BLOCK_SIZE = 1000;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;

export interface ActiveFeishuCardEntry {
  cardId: string;
  accountId: string;
  chatId: string;
  state: ImRunCardState;
  sequenceCeiling: number;
  updatedAt: number;
}

interface ActiveFeishuCardsFile {
  version: 1;
  cards: ActiveFeishuCardEntry[];
}

function lockPath(): string {
  return `${getImActiveFeishuCardsPath()}.lock`;
}

function normalizeEntry(value: unknown): ActiveFeishuCardEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ActiveFeishuCardEntry>;
  const state = entry.state as Partial<ImRunCardState> | undefined;
  const validStatus = state?.status === "running"
    || state?.status === "completed"
    || state?.status === "failed"
    || state?.status === "interrupted"
    || state?.status === "turn_limited";
  const usage = state?.usage;
  const validUsage = usage === undefined
    || (typeof usage === "object"
      && usage !== null
      && Number.isFinite(usage.totalTokens)
      && Number.isFinite(usage.totalCostUSD));
  if (
    typeof entry.cardId !== "string" || !entry.cardId
    || typeof entry.accountId !== "string" || !entry.accountId
    || typeof entry.chatId !== "string" || !entry.chatId
    || !entry.state || typeof entry.state !== "object"
    || !validStatus
    || !validUsage
    || !Array.isArray(state?.blocks)
    || !Number.isFinite(state?.startedAtMs)
    || !Number.isFinite(entry.sequenceCeiling)
    || !Number.isFinite(entry.updatedAt)
  ) return null;
  return entry as ActiveFeishuCardEntry;
}

function readUnlocked(): ActiveFeishuCardsFile {
  const path = getImActiveFeishuCardsPath();
  if (!existsSync(path)) return { version: CONFIG_VERSION, cards: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ActiveFeishuCardsFile>;
    const now = Date.now();
    const cards = Array.isArray(parsed.cards)
      ? parsed.cards
        .map(normalizeEntry)
        .filter((entry): entry is ActiveFeishuCardEntry => entry !== null && now - entry.updatedAt <= ENTRY_TTL_MS)
        .slice(-MAX_ENTRIES)
      : [];
    return { version: CONFIG_VERSION, cards };
  } catch (error) {
    const backupPath = backupCorruptFile(path);
    log.warn("活跃飞书卡片状态损坏，已跳过恢复", {
      ...(backupPath ? { backupPath } : {}),
      error: error instanceof Error ? error.message : String(error)
    });
    return { version: CONFIG_VERSION, cards: [] };
  }
}

function writeUnlocked(config: ActiveFeishuCardsFile): void {
  const path = getImActiveFeishuCardsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), "utf-8");
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows 忽略 POSIX 权限位；其它平台尽力收紧卡片内容快照权限。
  }
  renameSync(temporary, path);
}

function mutate<T>(fallback: T, action: (config: ActiveFeishuCardsFile) => T): T {
  try {
    return withIndexMutationLock(lockPath(), () => action(readUnlocked()));
  } catch (error) {
    log.warn("活跃飞书卡片状态写入失败", { error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

export function listActiveFeishuCards(): ActiveFeishuCardEntry[] {
  return readUnlocked().cards;
}

export function registerActiveFeishuCard(input: Omit<ActiveFeishuCardEntry, "sequenceCeiling" | "updatedAt">): boolean {
  return mutate(false, (config) => {
    const next: ActiveFeishuCardEntry = {
      ...input,
      sequenceCeiling: 0,
      updatedAt: Date.now()
    };
    const index = config.cards.findIndex((entry) => entry.cardId === input.cardId);
    if (index >= 0) config.cards[index] = next;
    else config.cards.push(next);
    writeUnlocked({ ...config, cards: config.cards.slice(-MAX_ENTRIES) });
    return true;
  });
}

export function checkpointActiveFeishuCard(cardId: string, state: ImRunCardState): boolean {
  return mutate(false, (config) => {
    const entry = config.cards.find((item) => item.cardId === cardId);
    if (!entry) return false;
    entry.state = state;
    entry.updatedAt = Date.now();
    writeUnlocked(config);
    return true;
  });
}

export function reserveActiveFeishuCardSequenceBlock(cardId: string): { sequence: number; ceiling: number } | null {
  return mutate<{ sequence: number; ceiling: number } | null>(null, (config) => {
    const entry = config.cards.find((item) => item.cardId === cardId);
    if (!entry) return null;
    const previousCeiling = Math.max(0, Math.floor(entry.sequenceCeiling));
    entry.sequenceCeiling = previousCeiling + SEQUENCE_BLOCK_SIZE;
    entry.updatedAt = Date.now();
    writeUnlocked(config);
    return { sequence: previousCeiling + 1, ceiling: entry.sequenceCeiling };
  });
}

export function removeActiveFeishuCard(cardId: string): void {
  mutate(undefined, (config) => {
    const cards = config.cards.filter((entry) => entry.cardId !== cardId);
    if (cards.length !== config.cards.length) writeUnlocked({ ...config, cards });
  });
}
