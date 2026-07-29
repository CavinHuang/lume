import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type CodingRewindJournalStatus =
  | "prepared"
  | "files_applying"
  | "files_applied"
  | "transcript_applying"
  | "completed"
  | "partial"
  | "failed";

export interface CodingRewindJournal {
  version: 1;
  operationId: string;
  runId: string;
  turnId: string;
  assistantMessageId: string;
  status: CodingRewindJournalStatus;
  files: string[];
  restoredFiles: string[];
  conflicts: string[];
  nonRewindableFiles: string[];
  removedMessageCount?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

type CodingRewindJournalRecord = CodingRewindJournal & { sessionDir: string };

const JOURNAL_PREFIX = "coding-rewind-";

function journalPath(sessionDir: string, operationId: string): string {
  return join(resolve(sessionDir), `${JOURNAL_PREFIX}${operationId}.json`);
}

async function writeJournal(record: CodingRewindJournalRecord): Promise<void> {
  const path = journalPath(record.sessionDir, record.operationId);
  await mkdir(resolve(record.sessionDir), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const { sessionDir: _sessionDir, ...serialized } = record;
  await writeFile(temporary, JSON.stringify(serialized, null, 2), "utf8");
  await rename(temporary, path);
}

export async function createCodingRewindJournal(input: {
  sessionDir: string;
  runId: string;
  turnId: string;
  assistantMessageId: string;
  files: string[];
}): Promise<CodingRewindJournalRecord> {
  const now = new Date().toISOString();
  const record: CodingRewindJournalRecord = {
    version: 1,
    operationId: randomUUID(),
    runId: input.runId,
    turnId: input.turnId,
    assistantMessageId: input.assistantMessageId,
    status: "prepared",
    files: [...new Set(input.files)],
    restoredFiles: [],
    conflicts: [],
    nonRewindableFiles: [],
    createdAt: now,
    updatedAt: now,
    sessionDir: resolve(input.sessionDir),
  };
  await writeJournal(record);
  return record;
}

export async function updateCodingRewindJournal(
  record: CodingRewindJournalRecord,
  patch: Partial<Omit<CodingRewindJournal, "version" | "operationId">>,
): Promise<CodingRewindJournalRecord> {
  const next: CodingRewindJournalRecord = {
    ...record,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJournal(next);
  return next;
}

export async function listIncompleteCodingRewindJournals(
  sessionDir: string,
): Promise<CodingRewindJournalRecord[]> {
  const resolvedSessionDir = resolve(sessionDir);
  let names: string[];
  try {
    names = await readdir(resolvedSessionDir);
  } catch {
    return [];
  }
  const result: CodingRewindJournalRecord[] = [];
  for (const name of names.filter((item) => item.startsWith(JOURNAL_PREFIX) && item.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(join(resolvedSessionDir, name), "utf8")) as CodingRewindJournal;
      if (parsed.version !== 1 || parsed.status === "completed" || parsed.status === "failed") continue;
      result.push({ ...parsed, sessionDir: resolvedSessionDir });
    } catch (error) {
      throw new Error(
        `Coding 回退日志损坏，已阻止继续恢复: ${name}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  return result;
}
