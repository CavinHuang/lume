import { createLogger } from "../../infra/logger";

export interface ServiceRuntimeJob {
  id: string;
  type: string;
  run: () => Promise<void>;
}

export interface ServiceRuntimeJobResult {
  id: string;
  type: string;
  status: "completed" | "failed";
  startedAt: number;
  completedAt: number;
  error?: string;
}

const log = createLogger("service-runtime");

export class ServiceRuntime {
  private readonly pending = new Set<Promise<void>>();
  private readonly results: ServiceRuntimeJobResult[] = [];

  schedule(job: ServiceRuntimeJob): void {
    const task = this.runJob(job)
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  async drainForTest(): Promise<ServiceRuntimeJobResult[]> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
    return [...this.results];
  }

  clearForTest(): void {
    this.pending.clear();
    this.results.length = 0;
  }

  private async runJob(job: ServiceRuntimeJob): Promise<void> {
    const startedAt = Date.now();
    try {
      await job.run();
      this.results.push({
        id: job.id,
        type: job.type,
        status: "completed",
        startedAt,
        completedAt: Date.now()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.results.push({
        id: job.id,
        type: job.type,
        status: "failed",
        startedAt,
        completedAt: Date.now(),
        error: message
      });
      log.warn("background service job failed", {
        jobId: job.id,
        jobType: job.type,
        error: message
      });
    }
  }
}

const serviceRuntime = new ServiceRuntime();

export function getServiceRuntime(): ServiceRuntime {
  return serviceRuntime;
}

export async function drainServiceRuntimeForTest(): Promise<ServiceRuntimeJobResult[]> {
  return serviceRuntime.drainForTest();
}

export function resetServiceRuntimeForTest(): void {
  serviceRuntime.clearForTest();
}
