import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodingRunTracker } from "./coding-run-tracker";

function result(content: string, isError = false) {
  return { type: "tool_result" as const, tool_use_id: "tool-1", content, ...(isError ? { is_error: true } : {}) };
}

describe("coding run tracker", () => {
  test("requires verification after a successful mutation and clears it after verification", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Edit", input: { file_path: "a.ts" }, result: result("edited") });
    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: result("pass") });
    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    expect(tracker.getVerificationStatus()).toBe("verified");
  });

  test("feeds a failed verification back to the same run", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: result("failed test", true) });
    await expect(tracker.completionGuard()).resolves.toContain("verification failed");
    expect(tracker.getVerificationStatus()).toBe("failed");
  });

  test("persists the baseline failure and identifies the same failure after a later mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-state-"));
    const statePath = join(root, "session", "coding-state.v1.json");
    const baseline = createCodingRunTracker({ workspaceRoot: root, statePath });
    await baseline.initialize();
    baseline.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: result("baseline failure", true)
    });

    const resumed = createCodingRunTracker({ workspaceRoot: root, statePath });
    await resumed.initialize();
    resumed.observe({ toolName: "Write", input: { file_path: "new.ts" }, result: result("written") });
    resumed.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: result("baseline failure", true)
    });

    const report = resumed.getVerificationReport();
    expect(report.status).toBe("unverified");
    expect(report.baselineFailure).toEqual({ command: "bun test", signature: "error:baseline failure" });
    await expect(resumed.completionGuard()).resolves.toBeUndefined();
  });

  test("waits for background TaskOutput before evaluating workspace changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-background-"));
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();
    tracker.observe({
      toolName: "Bash",
      input: { command: "bun test", run_in_background: true },
      result: {
        ...result("started"),
        _meta: { execution: { version: 1, durationMs: 0, command: "bun test", terminationReason: "running" } }
      }
    });
    await expect(tracker.completionGuard()).resolves.toContain("background pending");

    writeFileSync(join(root, "generated.ts"), "export const generated = true;", "utf-8");
    tracker.observe({
      toolName: "TaskOutput",
      input: { task_id: "task_1" },
      result: {
        ...result("completed"),
        _meta: { execution: { version: 1, durationMs: 10, command: "touch generated.ts", terminationReason: "completed" } }
      }
    });
    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    expect(tracker.getVerificationReport()).toMatchObject({
      workspaceChanged: true,
      changedFiles: ["generated.ts"],
      pendingBackground: false
    });
  });
});
