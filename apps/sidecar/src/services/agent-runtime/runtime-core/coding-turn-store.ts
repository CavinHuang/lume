import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CodingTurnRecord } from "@lume/shared";

const STORE_FILE = "coding-turns.json";

interface CodingTurnStorePayload {
  version: 1;
  turns: CodingTurnRecord[];
}

function storePath(sessionDir: string): string {
  return join(resolve(sessionDir), STORE_FILE);
}

async function readStore(sessionDir: string): Promise<CodingTurnStorePayload> {
  try {
    const payload = JSON.parse(await readFile(storePath(sessionDir), "utf8")) as Partial<CodingTurnStorePayload>;
    if (payload.version !== 1 || !Array.isArray(payload.turns)) return { version: 1, turns: [] };
    return { version: 1, turns: payload.turns.filter(isCodingTurnRecord) };
  } catch {
    return { version: 1, turns: [] };
  }
}

async function writeStore(sessionDir: string, payload: CodingTurnStorePayload): Promise<void> {
  const path = storePath(sessionDir);
  await mkdir(resolve(sessionDir), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(payload, null, 2), "utf8");
  await rename(temporary, path);
}

export async function createCodingTurnRecord(
  sessionDir: string,
  record: CodingTurnRecord,
): Promise<CodingTurnRecord> {
  const payload = await readStore(sessionDir);
  const turns = payload.turns.filter((turn) => turn.turnId !== record.turnId);
  turns.push(record);
  await writeStore(sessionDir, { version: 1, turns });
  return record;
}

export async function getCodingTurnRecord(
  sessionDir: string,
  turnId: string,
): Promise<CodingTurnRecord | null> {
  return (await readStore(sessionDir)).turns.find((turn) => turn.turnId === turnId) ?? null;
}

export async function listCodingTurnRecords(sessionDir: string): Promise<CodingTurnRecord[]> {
  return (await readStore(sessionDir)).turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function updateCodingTurnRecord(
  sessionDir: string,
  turnId: string,
  patch: Partial<Omit<CodingTurnRecord, "turnId" | "threadId" | "userMessageId" | "startedAt">>,
): Promise<CodingTurnRecord | null> {
  const payload = await readStore(sessionDir);
  const index = payload.turns.findIndex((turn) => turn.turnId === turnId);
  if (index < 0) return null;
  const current = payload.turns[index]!;
  const next: CodingTurnRecord = {
    ...current,
    ...patch,
    runIds: patch.runIds ? [...new Set(patch.runIds)] : current.runIds,
    changedFiles: patch.changedFiles ?? current.changedFiles,
  };
  payload.turns[index] = next;
  await writeStore(sessionDir, payload);
  return next;
}

function isCodingTurnRecord(value: unknown): value is CodingTurnRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CodingTurnRecord>;
  return typeof record.turnId === "string"
    && typeof record.threadId === "string"
    && typeof record.userMessageId === "string"
    && Array.isArray(record.runIds)
    && typeof record.startedAt === "string"
    && Array.isArray(record.changedFiles)
    && typeof record.verificationRepairAttempts === "number"
    && typeof record.approvalRequestCount === "number"
    && typeof record.rewindState === "string";
}
