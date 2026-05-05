import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type { TaskRun } from "./task-run-types";

export interface TaskRunStore {
  upsert(taskRun: TaskRun): Promise<void>;
  get(taskRunId: string): Promise<TaskRun | null>;
  listByThread(threadId: string): Promise<TaskRun[]>;
}

function writeTextAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readTaskRun(path: string): TaskRun | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskRun;
  } catch {
    return null;
  }
}

class FileBackedTaskRunStore implements TaskRunStore {
  private readonly taskRunsDir: string;

  constructor(sessionDir: string) {
    this.taskRunsDir = join(sessionDir, "task-runs");
    mkdirSync(this.taskRunsDir, { recursive: true });
  }

  async upsert(taskRun: TaskRun): Promise<void> {
    writeTextAtomic(this.pathFor(taskRun.id), JSON.stringify(taskRun, null, 2));
  }

  async get(taskRunId: string): Promise<TaskRun | null> {
    return readTaskRun(this.pathFor(taskRunId));
  }

  async listByThread(threadId: string): Promise<TaskRun[]> {
    if (!existsSync(this.taskRunsDir)) return [];
    const taskRuns: TaskRun[] = [];
    for (const file of readdirSync(this.taskRunsDir)) {
      if (!file.endsWith(".json")) continue;
      const taskRun = readTaskRun(join(this.taskRunsDir, file));
      if (taskRun?.threadId === threadId) taskRuns.push(taskRun);
    }
    return taskRuns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private pathFor(taskRunId: string): string {
    return join(this.taskRunsDir, `${taskRunId.replace(/[^a-zA-Z0-9._:-]/g, "_")}.json`);
  }
}

export function createFileBackedTaskRunStore(sessionDir: string): TaskRunStore {
  return new FileBackedTaskRunStore(sessionDir);
}
