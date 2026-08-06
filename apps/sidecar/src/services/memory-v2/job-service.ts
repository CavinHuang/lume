import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryJobKind, MemoryJobStatus } from "@lume/shared";
import { getMemoryV2ScopePaths } from "./paths";

export interface MemoryJobRecord<TResult = unknown, TProgress = unknown> {
  jobId: string;
  kind: MemoryJobKind;
  workspaceSlug: string;
  status: MemoryJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  idempotencyKey?: string;
  manual: boolean;
  progress?: TProgress;
  result?: TResult;
  error?: string;
  payload?: unknown;
}

interface StartMemoryJobInput<TResult, TProgress> {
  kind: MemoryJobKind;
  workspaceSlug: string;
  idempotencyKey?: string;
  manual?: boolean;
  payload?: unknown;
  run: (context: {
    signal: AbortSignal;
    report: (progress: TProgress) => void;
  }) => Promise<TResult>;
  onCompleted?: (job: MemoryJobRecord<TResult, TProgress>) => void;
  onProgress?: (job: MemoryJobRecord<TResult, TProgress>) => void;
}

/** Persistent source of truth for every long-running memory task. */
export class MemoryJobService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly locations = new Map<string, string>();
  private readonly executions = new Map<string, Promise<void>>();

  start<TResult, TProgress>(
    input: StartMemoryJobInput<TResult, TProgress>
  ): MemoryJobRecord<TResult, TProgress> {
    const existing = input.idempotencyKey
      ? this.list(input.workspaceSlug).find((job) =>
          job.idempotencyKey === input.idempotencyKey
          && (job.status === "queued" || job.status === "running" || job.status === "completed"))
      : undefined;
    if (existing) return existing as MemoryJobRecord<TResult, TProgress>;

    const now = Date.now();
    const job: MemoryJobRecord<TResult, TProgress> = {
      jobId: randomUUID(),
      kind: input.kind,
      workspaceSlug: input.workspaceSlug,
      status: "queued",
      createdAt: now,
      manual: input.manual ?? true
    };
    if (input.idempotencyKey) job.idempotencyKey = input.idempotencyKey;
    if (input.payload !== undefined) job.payload = input.payload;
    this.write(job);
    this.locations.set(job.jobId, job.workspaceSlug);

    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    const running = { ...job, status: "running" as const, startedAt: Date.now() };
    this.write(running);
    const execution = new Promise<void>((resolve) => {
      setTimeout(() => {
        void this.execute(running, controller, input).finally(resolve);
      }, 0);
    });
    this.executions.set(job.jobId, execution);
    void execution.finally(() => this.executions.delete(job.jobId));
    return running;
  }

  get<TResult = unknown, TProgress = unknown>(
    workspaceSlug: string,
    jobId: string
  ): MemoryJobRecord<TResult, TProgress> | undefined {
    const path = this.path(workspaceSlug, jobId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as MemoryJobRecord<TResult, TProgress>;
    } catch {
      return undefined;
    }
  }

  list(workspaceSlug: string): MemoryJobRecord[] {
    const { jobsDir } = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
    const jobs = readdirSync(jobsDir)
      .filter((name) => name.startsWith("job-") && name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(jobsDir, name), "utf-8")) as MemoryJobRecord;
        } catch {
          return undefined;
        }
      })
      .filter((job): job is MemoryJobRecord => Boolean(job))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const job of jobs) this.locations.set(job.jobId, workspaceSlug);
    return jobs;
  }

  resolveWorkspace(jobId: string): string | undefined {
    return this.locations.get(jobId);
  }

  cancel(workspaceSlug: string, jobId: string): MemoryJobRecord | undefined {
    const job = this.get(workspaceSlug, jobId);
    if (!job || !isActive(job.status)) return job;
    this.controllers.get(jobId)?.abort();
    const cancelled: MemoryJobRecord = {
      ...job,
      status: "cancelled",
      completedAt: Date.now()
    };
    this.write(cancelled);
    return cancelled;
  }

  async waitForTerminal(
    workspaceSlug: string,
    jobId: string
  ): Promise<MemoryJobRecord | undefined> {
    while (true) {
      const job = this.get(workspaceSlug, jobId);
      if (!job || !isActive(job.status)) return job;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async waitForSettled(timeoutMs = 60_000): Promise<void> {
    const running = [...this.executions.values()];
    if (running.length === 0) return;
    await Promise.race([
      Promise.allSettled(running).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  /** Marks unfinished tasks after a process restart without replaying mutable input. */
  recoverInterrupted(workspaceSlug: string): MemoryJobRecord[] {
    return this.list(workspaceSlug).map((job) => {
      if (!isActive(job.status) || this.controllers.has(job.jobId)) return job;
      const interrupted: MemoryJobRecord = {
        ...job,
        status: "interrupted",
        completedAt: Date.now(),
        error: job.manual
          ? "应用重启中断了任务，可从记忆设置中重试。"
          : "应用重启中断了自动任务；下次满足幂等触发条件时会恢复。"
      };
      this.write(interrupted);
      return interrupted;
    });
  }

  private async execute<TResult, TProgress>(
    job: MemoryJobRecord<TResult, TProgress>,
    controller: AbortController,
    input: StartMemoryJobInput<TResult, TProgress>
  ): Promise<void> {
    try {
      const result = await input.run({
        signal: controller.signal,
        report: (progress) => {
          const current = this.get<TResult, TProgress>(job.workspaceSlug, job.jobId);
          if (!current || current.status !== "running") return;
          const updated = { ...current, progress };
          this.write(updated);
          input.onProgress?.(updated);
        }
      });
      const current = this.get<TResult, TProgress>(job.workspaceSlug, job.jobId);
      if (!current || current.status !== "running") return;
      const completed: MemoryJobRecord<TResult, TProgress> = {
        ...current,
        status: "completed",
        completedAt: Date.now(),
        result
      };
      this.write(completed);
      input.onCompleted?.(completed);
    } catch (error) {
      const current = this.get<TResult, TProgress>(job.workspaceSlug, job.jobId);
      if (!current || current.status !== "running") return;
      this.write({
        ...current,
        status: controller.signal.aborted ? "cancelled" : "failed",
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.controllers.delete(job.jobId);
    }
  }

  private write(job: MemoryJobRecord): void {
    const path = this.path(job.workspaceSlug, job.jobId);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, "utf-8");
    try {
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  private path(workspaceSlug: string, jobId: string): string {
    const { jobsDir } = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug });
    return join(jobsDir, `job-${jobId}.json`);
  }
}

function isActive(status: MemoryJobStatus): boolean {
  return status === "queued" || status === "running";
}

export const memoryJobService = new MemoryJobService();
