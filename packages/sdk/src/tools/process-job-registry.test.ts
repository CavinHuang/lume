import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessOutputTool,
  ProcessStopTool,
  clearProcessJobs,
  createProcessJobRecord,
  getProcessJob,
  loadProcessJobs,
  persistedWorkerIdentityMatches,
  readProcessIdentity,
  updateProcessJob,
} from "./process-job-registry";

const IDENTITY_CACHE_TTL_MS = 5_000;

describe("process job registry liveness", () => {
  test("a stale heartbeat alone does not mark a live persisted worker interrupted (#329)", () => {
    clearProcessJobs();
    const root = mkdtempSync(join(tmpdir(), "lume-pj-heartbeat-"));
    createProcessJobRecord({
      id: "task_stale_heartbeat",
      subject: "stale heartbeat",
      status: "running",
      jobDir: join(root, "task_stale_heartbeat"),
      workerPid: process.pid,
      // Far beyond the old 15s staleness window; the OS probe keeps it alive.
      heartbeatAt: Date.now() - 60_000,
    });

    const [job] = loadProcessJobs(root);

    expect(job).toMatchObject({ id: "task_stale_heartbeat", status: "running" });
  });
});

describe("persisted worker identity matching (#313)", () => {
  test("accepts exact matches and a one-second win32 skew, rejects the rest", () => {
    expect(persistedWorkerIdentityMatches("tok", "tok:win32:1000", "win32:1000")).toBeTrue();
    expect(persistedWorkerIdentityMatches("tok", "tok:win32:1001", "win32:1000")).toBeTrue();
    expect(persistedWorkerIdentityMatches("tok", "tok:win32:999", "win32:1000")).toBeTrue();
    expect(persistedWorkerIdentityMatches("tok", "tok:win32:1002", "win32:1000")).toBeFalse();
    expect(persistedWorkerIdentityMatches("tok", "tok:win32:998", "win32:1000")).toBeFalse();
    expect(persistedWorkerIdentityMatches("tok", "other:win32:1000", "win32:1000")).toBeFalse();
    expect(persistedWorkerIdentityMatches("tok", "totally-different", "win32:1000")).toBeFalse();
    // Non-win32 identities have no estimation skew and stay exact.
    expect(persistedWorkerIdentityMatches("tok", "tok:linux:123456", "linux:123456")).toBeTrue();
    expect(persistedWorkerIdentityMatches("tok", "tok:linux:123457", "linux:123456")).toBeFalse();
    expect(persistedWorkerIdentityMatches("", "", "")).toBeFalse();
  });

  test.skipIf(process.platform !== "win32")("a worker-computed identity matches the registry probe for a live process", async () => {
    // The child computes its identity exactly as PROCESS_JOB_WORKER_SOURCE
    // does (PowerShell OS StartTime), then stays alive long enough for the
    // registry-style probe to run against a live pid.
    const { pid, workerIdentity } = await new Promise<{ pid: number; workerIdentity: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["-e", [
          "const { spawnSync } = require('node:child_process')",
          "const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '([DateTimeOffset]((Get-Process -Id ' + process.pid + ' -ErrorAction Stop).StartTime.ToUniversalTime())).ToUnixTimeSeconds()'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })",
          "console.log('win32:' + String(r.stdout || '').trim())",
          "setTimeout(() => {}, 20000)",
        ].join("\n")],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      child.once("error", reject);
      const poll = setInterval(() => {
        if (/win32:\d+/.test(out)) {
          clearInterval(poll);
          resolve({ pid: child.pid!, workerIdentity: out.trim() });
        }
      }, 50);
      setTimeout(() => { clearInterval(poll); child.kill(); reject(new Error("worker identity never arrived")); }, 10_000);
    });
    expect(workerIdentity).toMatch(/^win32:\d+$/);

    // The same probe the registry performs on win32, against the live child.
    const result = spawnSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `([DateTimeOffset]((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime())).ToUnixTimeSeconds()`,
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const probeSeconds = Number(result.stdout.trim());
    expect(Number.isFinite(probeSeconds)).toBeTrue();
    // Both sides read the OS StartTime; only second-boundary drift remains,
    // which persistedWorkerIdentityMatches tolerates.
    const workerSeconds = Number(workerIdentity.slice("win32:".length));
    expect(Math.abs(workerSeconds - probeSeconds)).toBeLessThanOrEqual(1);
  }, 30_000);
});

describe("ProcessStop (#332)", () => {
  test("marks stopped only when a stop handler actually acts", async () => {
    clearProcessJobs();
    let stops = 0;
    const job = createProcessJobRecord({
      id: "task_stoppable",
      subject: "stoppable",
      status: "running",
      stop: () => { stops += 1; },
    });

    const result = await ProcessStopTool.call({ task_id: job.id }, { cwd: tmpdir() });

    expect(result.is_error).toBeFalsy();
    expect(stops).toBe(1);
    expect(getProcessJob(job.id)?.status).toBe("stopped");
  });

  test("leaves a running job untouched when no stop can be initiated", async () => {
    clearProcessJobs();
    const events: Array<Record<string, unknown>> = [];
    const job = createProcessJobRecord({
      id: "task_unstoppable",
      subject: "unstoppable",
      status: "running",
      // No stop handler and no workerPid: stopPersistedWorker is a no-op.
    });

    const result = await ProcessStopTool.call({ task_id: job.id }, { cwd: tmpdir() });

    expect(result.is_error).toBeTrue();
    expect(String(result.content)).toContain("Failed to stop");
    expect(getProcessJob(job.id)?.status).toBe("running");

    updateProcessJob(job.id, { status: "failed", output: "crashed" });
    await ProcessOutputTool.call(
      { task_id: job.id, block: false },
      { cwd: tmpdir(), emitEvent: (event: Record<string, unknown>) => events.push(event) },
    );
    // The failed stop must not consume the pending terminal notification.
    expect(events.some((event) => event.subtype === "task_notification")).toBeTrue();
  });
});

describe("ProcessOutput blocking (#331)", () => {
  test("returns promptly when aborted while blocked", async () => {
    clearProcessJobs();
    const job = createProcessJobRecord({ id: "task_abort_wait", subject: "slow", status: "running" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();

    const result = await ProcessOutputTool.call(
      { task_id: job.id, block: true, timeout: 30_000 },
      { cwd: tmpdir(), abortSignal: controller.signal },
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // The tool's data payload is JSON-serialized into content by defineTool.
    const payload = JSON.parse(String(result.content)) as {
      retrieval_status?: string;
      process?: { status?: string };
    };
    expect(payload.retrieval_status).toBe("aborted");
    expect(payload.process?.status).toBe("running");
  });
});

describe("readProcessIdentity cache (#376)", () => {
  test("expired entries are re-probed instead of served stale", async () => {
    clearProcessJobs();
    // The win32 probe shells out to PowerShell, which can exceed its own
    // 5s timeout on a loaded machine; retry with fresh children until one
    // probe lands.
    let child: ReturnType<typeof spawn> | undefined;
    let liveIdentity: string | undefined;
    for (let attempt = 0; attempt < 3 && !liveIdentity; attempt += 1) {
      child?.kill();
      child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20_000)"], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      liveIdentity = readProcessIdentity(child.pid!);
    }
    expect(liveIdentity).toBeDefined();
    expect(child).toBeDefined();

    child!.kill();
    await new Promise((resolve) => child!.once("close", resolve));

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + IDENTITY_CACHE_TTL_MS * 12;
      // A fresh probe of the dead pid must run — serving the expired cache
      // entry would keep reporting an identity for a process that is gone.
      expect(readProcessIdentity(child!.pid!)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  }, 60_000);
});
