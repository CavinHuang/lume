import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryJobService } from "./job-service";
import { getMemoryV2ScopePaths } from "./paths";

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

  test("list 清理过期终态 job，保留活跃与 completedAt 缺失的终态 job", () => {
    const { jobsDir } = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
    mkdirSync(jobsDir, { recursive: true });
    const stalePath = join(jobsDir, "job-stale.json");
    const missingAtPath = join(jobsDir, "job-missing-at.json");
    const freshPath = join(jobsDir, "job-fresh.json");
    const runningPath = join(jobsDir, "job-running.json");
    writeFileSync(stalePath, JSON.stringify({
      jobId: "stale", kind: "turn_extract", workspaceSlug: "demo",
      status: "completed", createdAt: Date.now() - 9 * 24 * 3600 * 1000,
      completedAt: Date.now() - 8 * 24 * 3600 * 1000, manual: true
    }), "utf-8");
    writeFileSync(missingAtPath, JSON.stringify({
      jobId: "missing-at", kind: "turn_extract", workspaceSlug: "demo",
      status: "failed", createdAt: Date.now() - 9 * 24 * 3600 * 1000, manual: true
    }), "utf-8");
    writeFileSync(freshPath, JSON.stringify({
      jobId: "fresh", kind: "turn_extract", workspaceSlug: "demo",
      status: "completed", createdAt: Date.now() - 1000,
      completedAt: Date.now() - 500, manual: true
    }), "utf-8");
    writeFileSync(runningPath, JSON.stringify({
      jobId: "running", kind: "turn_extract", workspaceSlug: "demo",
      status: "running", createdAt: Date.now() - 9 * 24 * 3600 * 1000, manual: true
    }), "utf-8");

    const jobs = new MemoryJobService().list("demo").map((job) => job.jobId);
    expect(jobs).toContain("fresh");
    expect(jobs).toContain("missing-at");
    expect(jobs).toContain("running");
    expect(jobs).not.toContain("stale");
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
  });

  test("写穿缓存：缓存命中窗口内 list 不再读盘", () => {
    const { jobsDir } = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
    mkdirSync(jobsDir, { recursive: true });
    const jobPath = join(jobsDir, "job-cached.json");
    writeFileSync(jobPath, JSON.stringify({
      jobId: "cached", kind: "turn_extract", workspaceSlug: "demo",
      status: "completed", createdAt: Date.now() - 1000,
      completedAt: Date.now() - 500, manual: true
    }), "utf-8");

    const service = new MemoryJobService();
    expect(service.list("demo").map((job) => job.jobId)).toEqual(["cached"]);
    // 外部删盘上文件（缓存窗口 1h 内）
    rmSync(jobPath);
    // 仍返回缓存结果——证明未读盘
    expect(service.list("demo").map((job) => job.jobId)).toEqual(["cached"]);
  });

  test("写穿缓存：write 后同实例 list 反映新状态", async () => {
    const service = new MemoryJobService();
    service.list("demo"); // 预热缓存
    const started = service.start({
      kind: "entries",
      workspaceSlug: "demo",
      run: async () => ({ done: true })
    });
    await waitForTerminal(service, "demo", started.jobId);
    const fromCache = service.list("demo").find((job) => job.jobId === started.jobId);
    expect(fromCache?.status).toBe("completed");
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
