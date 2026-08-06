import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryJobService } from "./job-service";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-jobs-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("MemoryJobService", () => {
  test("persists progress and terminal result", async () => {
    const service = new MemoryJobService();
    const started = service.start({
      kind: "entries",
      workspaceSlug: "demo",
      run: async ({ report }) => {
        report({ processedItems: 1 });
        return { merged: 2 };
      }
    });
    const completed = await waitForTerminal(service, "demo", started.jobId);
    expect(completed.status).toBe("completed");
    expect(completed.progress).toEqual({ processedItems: 1 });
    expect(completed.result).toEqual({ merged: 2 });
    expect(new MemoryJobService().get("demo", started.jobId)?.status).toBe("completed");
  });

  test("coalesces the same idempotency key", () => {
    const service = new MemoryJobService();
    const run = async () => ({ ok: true });
    const first = service.start({
      kind: "consolidation",
      workspaceSlug: "demo",
      idempotencyKey: "same-window",
      manual: false,
      run
    });
    const second = service.start({
      kind: "consolidation",
      workspaceSlug: "demo",
      idempotencyKey: "same-window",
      manual: false,
      run
    });
    expect(second.jobId).toBe(first.jobId);
  });

  test("marks orphaned running jobs interrupted after restart", () => {
    const firstProcess = new MemoryJobService();
    const started = firstProcess.start({
      kind: "external_ingest",
      workspaceSlug: "demo",
      run: () => new Promise(() => undefined)
    });
    const restarted = new MemoryJobService();
    restarted.recoverInterrupted("demo");
    expect(restarted.get("demo", started.jobId)?.status).toBe("interrupted");
  });

  test("cancels an active job without allowing a late result to overwrite it", async () => {
    const service = new MemoryJobService();
    const started = service.start({
      kind: "external_ingest",
      workspaceSlug: "demo",
      run: async () => {
        await Bun.sleep(30);
        return { ok: true };
      }
    });
    expect(service.cancel("demo", started.jobId)?.status).toBe("cancelled");
    await Bun.sleep(50);
    expect(service.get("demo", started.jobId)?.status).toBe("cancelled");
  });
});

async function waitForTerminal(
  service: MemoryJobService,
  workspaceSlug: string,
  jobId: string
) {
  for (let index = 0; index < 50; index += 1) {
    const job = service.get(workspaceSlug, jobId);
    if (job && job.status !== "queued" && job.status !== "running") return job;
    await Bun.sleep(10);
  }
  throw new Error("job did not finish");
}
