import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
