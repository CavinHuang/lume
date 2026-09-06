import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeLatestAutomationTrigger,
  finishAutomationLease,
  mergeLatestAutomationTrigger,
  readAutomationRuntimeState,
  recoverAutomationRuntimeStates,
  tryAcquireAutomationLease
} from "./automation-runtime-store";

describe("automation runtime lease", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;
  let configDir = "";

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "lume-automation-runtime-"));
    process.env.LUME_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("allows one owner and merges repeated triggers into the latest timestamp", () => {
    const first = tryAcquireAutomationLease({ jobId: "job-1", scheduledAt: 10, runId: "run-1" });
    expect(first).not.toBeNull();
    expect(tryAcquireAutomationLease({ jobId: "job-1", scheduledAt: 20, runId: "run-2" })).toBeNull();

    mergeLatestAutomationTrigger("job-1", 20);
    mergeLatestAutomationTrigger("job-1", 30);
    expect(consumeLatestAutomationTrigger("job-1")).toBe(30);

    finishAutomationLease(first!, { status: "success" });
    expect(tryAcquireAutomationLease({ jobId: "job-1", scheduledAt: 40, runId: "run-3" })).not.toBeNull();
  });

  test("marks a stale running lease interrupted instead of replaying it", () => {
    const lease = tryAcquireAutomationLease({ jobId: "job-stale", scheduledAt: 10, runId: "run-stale" });
    expect(lease).not.toBeNull();
    const statePath = join(configDir, "automation", "runtime", "job-stale", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.lease.heartbeatAt = Date.now() - 60_000;
    writeFileSync(statePath, JSON.stringify(state));

    const recovered = recoverAutomationRuntimeStates().find((item) => item.jobId === "job-stale");
    expect(recovered?.status).toBe("interrupted");
    expect(readAutomationRuntimeState("job-stale")?.message).toContain("不会自动重放");
  });

  test("keeps interaction waits leased across scheduler refreshes", () => {
    const lease = tryAcquireAutomationLease({ jobId: "job-wait", scheduledAt: 10, runId: "run-wait" });
    finishAutomationLease(lease!, {
      status: "waiting_for_user",
      threadId: "thread-1",
      keepForInteraction: true
    });
    expect(tryAcquireAutomationLease({ jobId: "job-wait", scheduledAt: 20, runId: "run-2" })).toBeNull();
    expect(readAutomationRuntimeState("job-wait")).toMatchObject({
      status: "waiting_for_user",
      threadId: "thread-1"
    });
  });

  test("recovers an orphan lock when state.json is missing (#866)", () => {
    const dir = join(configDir, "automation", "runtime", "job-orphan");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lease.lock"), "");

    const lease = tryAcquireAutomationLease({ jobId: "job-orphan", scheduledAt: 10, runId: "run-1" });
    expect(lease).not.toBeNull();
    expect(readAutomationRuntimeState("job-orphan")?.status).toBe("running");
  });

  test("recovers an orphan lock left over a terminal state (#866)", () => {
    for (const status of ["success", "failed", "interrupted", "queued"] as const) {
      const jobId = `job-terminal-${status}`;
      const dir = join(configDir, "automation", "runtime", jobId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "lease.lock"), "");
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1,
        jobId,
        status,
        message: "上一轮终态",
        updatedAt: 1
      }));

      const lease = tryAcquireAutomationLease({ jobId, scheduledAt: 10, runId: "run-1" });
      expect(lease).not.toBeNull();
      expect(readAutomationRuntimeState(jobId)?.status).toBe("running");
    }
  });

  test("keeps a merged pending trigger across orphan-lock recovery (#866)", () => {
    const dir = join(configDir, "automation", "runtime", "job-pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lease.lock"), "");
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1,
      jobId: "job-pending",
      status: "success",
      pendingScheduledAt: 12345,
      updatedAt: 1
    }));

    const lease = tryAcquireAutomationLease({ jobId: "job-pending", scheduledAt: 10, runId: "run-1" });
    expect(lease).not.toBeNull();
    expect(readAutomationRuntimeState("job-pending")?.pendingScheduledAt).toBe(12345);
  });

  test("never steals a waiting lease regardless of heartbeat age (#866)", () => {
    for (const status of ["waiting_for_user", "waiting_for_approval"] as const) {
      const jobId = `job-wait-${status}`;
      const lease = tryAcquireAutomationLease({ jobId, scheduledAt: 10, runId: "run-1" });
      expect(lease).not.toBeNull();
      finishAutomationLease(lease!, { status, keepForInteraction: true });

      const statePath = join(configDir, "automation", "runtime", jobId, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.lease.heartbeatAt = Date.now() - 600_000;
      writeFileSync(statePath, JSON.stringify(state));

      expect(tryAcquireAutomationLease({ jobId, scheduledAt: 20, runId: "run-2" })).toBeNull();
      const after = readAutomationRuntimeState(jobId);
      expect(after?.status).toBe(status);
      expect(after?.lease?.id).toBe(lease!.leaseId);
    }
  });

  test("recovers a stale running lease and re-acquires within the same call", () => {
    const lease = tryAcquireAutomationLease({ jobId: "job-stale-acquire", scheduledAt: 10, runId: "run-1" });
    expect(lease).not.toBeNull();
    const statePath = join(configDir, "automation", "runtime", "job-stale-acquire", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.lease.heartbeatAt = Date.now() - 60_000;
    writeFileSync(statePath, JSON.stringify(state));

    const reacquired = tryAcquireAutomationLease({ jobId: "job-stale-acquire", scheduledAt: 20, runId: "run-2" });
    expect(reacquired).not.toBeNull();
    expect(reacquired!.leaseId).not.toBe(lease!.leaseId);
  });

  test("startup recovery clears a lock-only directory (#866)", () => {
    const dir = join(configDir, "automation", "runtime", "job-lockonly");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lease.lock"), "");

    const recovered = recoverAutomationRuntimeStates();
    expect(recovered.find((item) => item.jobId === "job-lockonly")).toBeUndefined();
    expect(existsSync(join(dir, "lease.lock"))).toBe(false);
  });

  test("startup recovery leaves a terminal-state orphan lock to tryAcquire (#866)", () => {
    const dir = join(configDir, "automation", "runtime", "job-term-lock");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lease.lock"), "");
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1,
      jobId: "job-term-lock",
      status: "success",
      updatedAt: 1
    }));

    recoverAutomationRuntimeStates();
    expect(existsSync(join(dir, "lease.lock"))).toBe(true);
    expect(readAutomationRuntimeState("job-term-lock")?.status).toBe("success");

    expect(tryAcquireAutomationLease({ jobId: "job-term-lock", scheduledAt: 10, runId: "run-1" })).not.toBeNull();
  });
});
