import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadingNoteDepth, ReadingSettings, ReadingTaskResult } from "@lume/shared";
import { listAgentWorkspaces } from "../agent/agent-workspace-manager";
import { getReadingRunsDir } from "../infra/config-paths";
import { getReadingSettings, listReadingNotes } from "./reading-store";
import { runReadingTaskAsync } from "./reading-task-runner";
import { emitReadingGenerationNotification, type ReadingNotificationWriter } from "./reading-notifications";
import type { ReadingContextToolsDeps } from "./reading-context-tools";

export const READING_CADENCE_TICK_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface CadenceNoteLike {
  depth: ReadingNoteDepth;
  createdAt: number;
  hidden?: boolean;
  deleted?: boolean;
}

export interface ReadingRunRecord {
  trigger: "scheduled";
  status: ReadingTaskResult["status"];
  bookId?: string;
  noteId?: string;
  message: string;
  depth?: ReadingNoteDepth;
  workspaceSlug?: string;
  completedAt: number;
}

export type ReadingCadenceDecision =
  | { due: true; depth: ReadingNoteDepth; reason: "weekly_due" | "few_times_weekly_due" }
  | { due: false; reason: "cadence_off" | "cadence_manual" | "cadence_wait" };

export interface BuildReadingCadenceDecisionInput {
  settings: ReadingSettings;
  notes: CadenceNoteLike[];
  runs: Array<Pick<ReadingRunRecord, "trigger" | "status" | "completedAt">>;
  now: number;
}

export interface RunReadingCadenceTickInput {
  now?: number;
  writeNotification?: ReadingNotificationWriter;
  workspaceSlug?: string;
  contextTools?: ReadingContextToolsDeps;
}

let runnerTimer: ReturnType<typeof setInterval> | null = null;
let runnerTickInFlight = false;
let notificationWriter: ReadingNotificationWriter | undefined;

export function buildReadingCadenceDecision(input: BuildReadingCadenceDecisionInput): ReadingCadenceDecision {
  if (input.settings.cadence === "off") return { due: false, reason: "cadence_off" };
  if (input.settings.cadence === "manual") return { due: false, reason: "cadence_manual" };

  const intervalMs = input.settings.cadence === "few_times_weekly" ? 2 * dayMs() : 7 * dayMs();
  const lastActivityAt = Math.max(0, ...input.notes
    .filter((note) => !note.deleted)
    .map((note) => note.createdAt), ...input.runs
    .filter((run) => run.trigger === "scheduled")
    .map((run) => run.completedAt));
  if (lastActivityAt > 0 && input.now - lastActivityAt < intervalMs) {
    return { due: false, reason: "cadence_wait" };
  }

  const depth: ReadingNoteDepth = hasReachedWeeklyDeepNoteLimit(
    input.notes,
    input.now,
    input.settings.maxDeepNotesPerWeek
  ) ? "seed" : "deep";

  return {
    due: true,
    depth,
    reason: input.settings.cadence === "few_times_weekly" ? "few_times_weekly_due" : "weekly_due"
  };
}

export async function runReadingCadenceTick(input: RunReadingCadenceTickInput = {}): Promise<ReadingTaskResult> {
  const now = input.now ?? Date.now();
  const settings = getReadingSettings();
  const notes = listReadingNotes({ includeHidden: true, includeDeleted: true }) as CadenceNoteLike[];
  const decision = buildReadingCadenceDecision({
    settings,
    notes,
    runs: listReadingRunRecords(),
    now
  });

  if (!decision.due) {
    return {
      status: "skipped",
      message: "读书节奏未到",
      completedAt: now
    };
  }

  const workspaceSlug = resolveReadingCadenceWorkspaceSlug(input);
  const taskInput = {
    trigger: "scheduled" as const,
    depth: decision.depth,
    ...(workspaceSlug ? { workspaceSlug } : {})
  };
  const result = await runReadingTaskAsync(taskInput, {
    contextTools: {
      ...(input.contextTools ?? {}),
      ...(workspaceSlug ? { workspaceSlug } : {})
    }
  });
  appendReadingRunRecord({
    trigger: "scheduled",
    status: result.status,
    ...(result.bookId ? { bookId: result.bookId } : {}),
    ...(result.noteId ? { noteId: result.noteId } : {}),
    message: result.message,
    depth: decision.depth,
    ...(workspaceSlug ? { workspaceSlug } : {}),
    completedAt: result.completedAt
  });
  emitReadingGenerationNotification(input.writeNotification ?? notificationWriter, result, taskInput);
  return result;
}

export function setReadingCadenceNotificationWriter(writer: ReadingNotificationWriter): void {
  notificationWriter = writer;
}

export async function startReadingCadenceRunner(input: { intervalMs?: number } = {}): Promise<void> {
  if (runnerTimer) return;
  const intervalMs = Math.max(1_000, input.intervalMs ?? READING_CADENCE_TICK_MS);
  runnerTimer = setInterval(() => {
    if (runnerTickInFlight) return;
    runnerTickInFlight = true;
    void runReadingCadenceTick()
      .catch((error) => {
        console.error(`[读书] 后台读书节奏执行失败: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        runnerTickInFlight = false;
      });
  }, intervalMs);
}

export async function stopReadingCadenceRunner(): Promise<void> {
  if (runnerTimer) {
    clearInterval(runnerTimer);
    runnerTimer = null;
  }
  runnerTickInFlight = false;
}

export function listReadingRunRecords(): ReadingRunRecord[] {
  const path = getReadingRunsPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Partial<ReadingRunRecord>;
      } catch {
        return null;
      }
    })
    .filter((record): record is Partial<ReadingRunRecord> => Boolean(record))
    .filter((record): record is ReadingRunRecord => (
      record.trigger === "scheduled"
      && isReadingTaskStatus(record.status)
      && typeof record.message === "string"
      && typeof record.completedAt === "number"
    ));
}

function resolveReadingCadenceWorkspaceSlug(input: RunReadingCadenceTickInput): string | undefined {
  const explicit = input.workspaceSlug?.trim() || input.contextTools?.workspaceSlug?.trim();
  if (explicit) return explicit;
  return listAgentWorkspaces()[0]?.slug;
}

function appendReadingRunRecord(record: ReadingRunRecord): void {
  appendFileSync(getReadingRunsPath(), `${JSON.stringify(record)}\n`, "utf-8");
}

function getReadingRunsPath(): string {
  return join(getReadingRunsDir(), "runs.jsonl");
}

function dayMs(): number {
  return 24 * 60 * 60 * 1000;
}

function hasReachedWeeklyDeepNoteLimit(notes: CadenceNoteLike[], now: number, maxDeepNotesPerWeek: number): boolean {
  const limit = Math.max(1, maxDeepNotesPerWeek);
  return notes.filter((note) =>
    note.depth === "deep"
    && !note.deleted
    && note.createdAt >= now - WEEK_MS
  ).length >= limit;
}

function isReadingTaskStatus(value: unknown): value is ReadingTaskResult["status"] {
  return value === "completed" || value === "partial" || value === "skipped" || value === "failed";
}
