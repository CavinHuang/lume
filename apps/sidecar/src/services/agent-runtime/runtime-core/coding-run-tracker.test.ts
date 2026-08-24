import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodingRunTracker } from "./coding-run-tracker";

function result(content: string, isError = false, meta?: Record<string, unknown>) {
  return {
    type: "tool_result" as const,
    tool_use_id: "tool-1",
    content,
    ...(isError ? { is_error: true } : {}),
    ...(meta ? { _meta: meta } : {})
  };
}

function verificationResult(content: string, outcome: "succeeded" | "failed") {
  return result(content, outcome === "failed", {
    execution: {
      version: 2,
      outcome,
      exitCode: outcome === "succeeded" ? 0 : 1,
      terminationReason: outcome === "succeeded" ? "completed" : "exit_code",
      durationMs: 1,
      shell: "powershell",
      command: "bun test",
      purpose: "verification",
    }
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

describe("coding run tracker", () => {
  test("requires verification after a successful mutation and clears it after verification", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Edit", input: { file_path: "a.ts" }, result: result("edited") });
    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: verificationResult("pass", "succeeded") });
    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    expect(tracker.getVerificationStatus()).toBe("verified");
    expect(tracker.getVerificationReport()).toMatchObject({
      phase: "ready_for_review",
      verificationRecords: [{ command: "bun test", status: "passed" }],
    });
  });

  test("records governed git actions without treating them as completion evidence", () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Bash", input: { command: "git commit -am \"checkpoint\"" }, result: result("[main abc123] checkpoint") });

    expect(tracker.getVerificationReport().gitActions).toEqual([
      expect.objectContaining({ kind: "commit", status: "completed" }),
    ]);
    expect(tracker.getVerificationStatus()).toBe("not_required");
  });

  test("feeds a failed verification back to the same run", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: verificationResult("failed test", "failed") });
    await expect(tracker.completionGuard()).resolves.toMatchObject({
      type: "continue",
      message: expect.stringContaining("verification failed")
    });
    expect(tracker.getVerificationStatus()).toBe("failed");
  });

  test("#573: allows multiple verification repairs before stopping", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: verificationResult("failed test", "failed") });
    // 第 1-3 次失败都给 continue 自修机会（预算 MAX_VERIFICATION_REPAIR_ATTEMPTS=3）
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(tracker.completionGuard()).resolves.toMatchObject({
        type: "continue",
        message: expect.stringContaining("verification failed")
      });
      tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: verificationResult(`failed again ${attempt}`, "failed") });
    }
    await expect(tracker.completionGuard()).resolves.toMatchObject({
      type: "stop",
      errorCode: "verification_failed_after_repair",
      message: expect.stringContaining("3 次自动修复后仍失败")
    });
  });

  test("#573: recognizes non-JS toolchain and colon-suffixed scripts as verification", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    tracker.observe({ toolName: "Bash", input: { command: "cargo check --manifest-path Cargo.toml" }, result: verificationResult("ok", "succeeded") });
    expect(tracker.getVerificationStatus()).toBe("verified");
  });

  test("does not treat a filtered no-match result as verification evidence", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    const noMatches = result("Command completed: no matches found", false, {
      execution: { version: 1, durationMs: 1, command: "bun test | Select-String error", terminationReason: "completed", semanticOutcome: "no_matches" }
    });
    tracker.observe({ toolName: "Bash", input: { command: "bun test | Select-String error", purpose: "verification" }, result: noMatches });
    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    expect(tracker.getVerificationStatus()).toBe("unverified");
    tracker.observe({ toolName: "Bash", input: { command: "bun test | Select-String error", purpose: "verification" }, result: noMatches });
    await expect(tracker.completionGuard()).resolves.toMatchObject({
      type: "stop",
      errorCode: "verification_inconclusive"
    });
  });

  test("persists the baseline failure and identifies the same failure after a later mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-state-"));
    const statePath = join(root, "session", "coding-state.v1.json");
    const baseline = createCodingRunTracker({ workspaceRoot: root, statePath });
    await baseline.initialize();
    baseline.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: verificationResult("baseline failure", "failed")
    });
    await baseline.dispose();

    const resumed = createCodingRunTracker({ workspaceRoot: root, statePath });
    await resumed.initialize();
    resumed.observe({ toolName: "Write", input: { file_path: "new.ts" }, result: result("written") });
    resumed.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: verificationResult("baseline failure", "failed")
    });

    const report = resumed.getVerificationReport();
    expect(report.status).toBe("unverified");
    expect(report.baselineFailure).toEqual({ command: "bun test", signature: "error:baseline failure" });
    await expect(resumed.completionGuard()).resolves.toBeUndefined();
  });

  test("persists compact v3 state without workspace snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-state-v3-"));
    const statePath = join(root, "session", "coding-state.v1.json");
    const tracker = createCodingRunTracker({ workspaceRoot: root, statePath });

    const startedAt = performance.now();
    await tracker.initialize();
    expect(performance.now() - startedAt).toBeLessThan(500);
    await tracker.dispose();

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.version).toBe(3);
    expect(state.baselineSnapshot).toBeUndefined();
    expect(state.latestSnapshot).toBeUndefined();
    expect(state.baselineSnapshots).toBeUndefined();
    expect(state.latestSnapshots).toBeUndefined();
    expect(statSync(statePath).size).toBeLessThan(100_000);
  });

  test("skips oversized legacy state instead of parsing it on startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-large-state-"));
    const statePath = join(root, "coding-state.v1.json");
    writeFileSync(statePath, "x".repeat(1024 * 1024 + 1), "utf8");
    const tracker = createCodingRunTracker({ workspaceRoot: root, statePath });

    await tracker.initialize();
    tracker.observe({ toolName: "Write", input: { file_path: "new.ts" }, result: result("written") });
    await tracker.dispose();

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.version).toBe(3);
    expect(statSync(statePath).size).toBeLessThan(100_000);
  });

  test("detects same-size Bash edits through Git without content snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-same-size-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "one", "utf8");
    execFileSync("git", ["add", "a.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();
    expect(tracker.getBaselineCommit()).toMatch(/^[0-9a-f]{40}$/);
    await tracker.beforeToolExecution({ toolName: "Bash", input: { command: "echo two > a.ts" }, cwd: root });

    writeFileSync(join(root, "a.ts"), "two", "utf8");
    tracker.observe({ toolName: "Bash", input: { command: "echo two > a.ts" }, result: result("done") });

    const completionStartedAt = performance.now();
    expect(await tracker.completionGuard()).toContain("verification needed");
    expect(performance.now() - completionStartedAt).toBeLessThan(2_000);
    expect(tracker.getVerificationReport()).toMatchObject({
      workspaceChanged: true,
      changedFiles: ["a.ts"],
    });
    await tracker.dispose();
  }, 20_000);

  test("keeps Git paths with leading spaces intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-special-path-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();
    await tracker.beforeToolExecution({ toolName: "Bash", input: { command: "echo value > \" leading.ts\"" }, cwd: root });

    writeFileSync(join(root, " leading.ts"), "value", "utf8");
    tracker.observe({ toolName: "Bash", input: { command: "echo value > \" leading.ts\"" }, result: result("done") });

    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    expect(tracker.getVerificationReport().changedFiles).toContain(" leading.ts");
    await tracker.dispose();
  }, 20_000);

  test("attributes indirect Bash edits inside a Git worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-git-watch-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();
    await expect(tracker.waitForWorkspaceMonitorReady()).resolves.toBe("ready");
    await tracker.beforeToolExecution({
      toolName: "Bash",
      input: { command: "node scripts/generate.mjs" },
      cwd: root,
    });

    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "output.ts"), "export const output = true;", "utf8");
    tracker.observe({
      toolName: "Bash",
      input: { command: "node scripts/generate.mjs" },
      result: result("done"),
    });

    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    expect(tracker.getVerificationReport().changedFiles).toContain("generated/output.ts");
    await tracker.dispose();
  }, 20_000);

  test("uses full Git reconciliation when watcher startup is degraded", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-degraded-watch-"));
    const unavailableRoot = join(tmpdir(), `lume-coding-missing-${Date.now()}`);
    execFileSync("git", ["init", "-q"], { cwd: root });
    const tracker = createCodingRunTracker({
      workspaceRoot: root,
      additionalRoots: [unavailableRoot],
    });
    await tracker.initialize();
    await expect(tracker.waitForWorkspaceMonitorReady()).resolves.toBe("degraded");
    await tracker.beforeToolExecution({
      toolName: "Bash",
      input: { command: "node scripts/generate.mjs" },
      cwd: root,
    });

    writeFileSync(join(root, "fallback.ts"), "export const fallback = true;", "utf8");
    tracker.observe({
      toolName: "Bash",
      input: { command: "node scripts/generate.mjs" },
      result: result("done"),
    });

    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    await waitForCondition(() => tracker.getVerificationReport().changeSet?.files
      .some((file) => file.path === "fallback.ts") === true);
    expect(tracker.getVerificationReport().changeSet).toMatchObject({
      base: "git:HEAD",
      isGitRepo: true,
    });
    await tracker.dispose();
  }, 20_000);

  test("keeps a running background task recoverable without failing the Run", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-background-"));
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();
    await tracker.beforeToolExecution({
      toolName: "Bash",
      input: { command: "bun test", run_in_background: true },
      cwd: root,
    });
    tracker.observe({
      toolName: "Bash",
      input: { command: "bun test", run_in_background: true },
      result: {
        ...result("started"),
        _meta: { execution: { version: 1, durationMs: 0, command: "bun test", terminationReason: "running" } }
      }
    });
    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    expect(tracker.getVerificationReport().pendingBackground).toBe(true);

    writeFileSync(join(root, "generated.ts"), "export const generated = true;", "utf-8");
    tracker.observe({
      toolName: "ProcessOutput",
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

  test("updates an auto-backgrounded verification from its terminal notification", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    tracker.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: {
        ...result("moved to background"),
        _meta: {
          execution: { version: 1, durationMs: 0, command: "bun test", purpose: "verification", terminationReason: "running" },
          task: { id: "task_1", status: "running", kind: "shell", autoBackgrounded: true }
        }
      }
    });

    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    expect(tracker.getVerificationStatus()).toBe("unverified");
    expect(tracker.observeAsyncEvent({
      type: "system",
      subtype: "task_notification",
      task_id: "task_1",
      status: "completed",
      summary: "2 pass",
      execution: {
        version: 1,
        durationMs: 20_000,
        command: "bun test",
        purpose: "verification",
        terminationReason: "completed"
      },
      session_id: "session"
    })).toBe(true);
    expect(tracker.getVerificationStatus()).toBe("verified");
    expect(tracker.getVerificationReport().pendingBackground).toBe(false);
  });

  test("records a failed auto-backgrounded verification without aborting the finished turn", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Edit", input: { file_path: "a.ts" }, result: result("edited") });
    tracker.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: {
        ...result("moved to background"),
        _meta: {
          execution: { version: 1, durationMs: 0, command: "bun test", purpose: "verification", terminationReason: "running" },
          task: { id: "task_2", status: "running", kind: "shell", autoBackgrounded: true }
        }
      }
    });

    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    tracker.observeAsyncEvent({
      type: "system",
      subtype: "task_notification",
      task_id: "task_2",
      status: "failed",
      summary: "test failed",
      execution: {
        version: 1,
        durationMs: 20_000,
        command: "bun test",
        purpose: "verification",
        terminationReason: "nonzero"
      },
      session_id: "session"
    });
    await expect(tracker.completionGuard()).resolves.toMatchObject({
      type: "continue",
      message: expect.stringContaining("verification failed")
    });
    expect(tracker.getVerificationReport().pendingBackground).toBe(false);
  });

  test("does not wait for or fail an explicitly long-lived background process", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({
      toolName: "Bash",
      input: { command: "bun run dev", run_in_background: true },
      result: {
        ...result("background process started"),
        _meta: {
          execution: { version: 1, durationMs: 0, command: "bun run dev", terminationReason: "running" },
          task: { id: "task_dev", status: "running", kind: "shell", autoBackgrounded: false }
        }
      }
    });

    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    expect(tracker.getVerificationReport().pendingBackground).toBe(true);
  });

  test("does not append another model turn when an auto-backgrounded check is still running", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Edit", input: { file_path: "a.ts" }, result: result("edited") });
    tracker.observe({
      toolName: "Bash",
      input: { command: "bun test", purpose: "verification" },
      result: {
        ...result("moved to background"),
        _meta: {
          execution: { version: 1, durationMs: 0, command: "bun test", purpose: "verification", terminationReason: "running" },
          task: { id: "task_slow", status: "running", kind: "shell", autoBackgrounded: true }
        }
      }
    });

    await expect(tracker.completionGuard()).resolves.toBeUndefined();
    expect(tracker.getVerificationStatus()).toBe("unverified");
    expect(tracker.getVerificationReport().pendingBackground).toBe(true);
  });

  test("clears a stopped task even if its execution metadata has not caught up yet", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({
      toolName: "Bash",
      input: { command: "long-running-command" },
      result: {
        ...result("moved to background"),
        _meta: {
          execution: { version: 1, durationMs: 0, command: "long-running-command", terminationReason: "running" },
          task: { id: "task_stopped", status: "running", kind: "shell", autoBackgrounded: true }
        }
      }
    });
    tracker.observe({
      toolName: "ProcessOutput",
      input: { task_id: "task_stopped" },
      result: {
        ...result("stopped"),
        _meta: {
          execution: { version: 1, durationMs: 0, command: "long-running-command", terminationReason: "running" },
          task: { id: "task_stopped", status: "stopped", kind: "shell" }
        }
      }
    });

    expect(tracker.getVerificationReport().pendingBackground).toBe(false);
  });

  test("keeps file line statistics for the coding report", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-stats-"));
    const filePath = join(root, "changed.ts");
    writeFileSync(filePath, "before\n", "utf-8");
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();

    writeFileSync(filePath, "before\nafter\n", "utf-8");
    tracker.observe({
      toolName: "Edit",
      input: { file_path: "changed.ts" },
      result: result("edited", false, { file: { linesAdded: 1, linesRemoved: 0 } })
    });

    await tracker.completionGuard();
    expect(tracker.getVerificationReport()).toMatchObject({
      fileChanges: [{ path: "changed.ts", addedLines: 1, removedLines: 0 }],
      totalAddedLines: 1
    });
  });

  test("attributes files changed by an indirect Bash script", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-bash-script-"));
    const tracker = createCodingRunTracker({ workspaceRoot: root });
    await tracker.initialize();

    await tracker.beforeToolExecution({
      toolName: "Bash",
      input: { command: "python -c ..." },
      cwd: root,
    });
    writeFileSync(join(root, "generated.ts"), "export const value = 1;\n", "utf-8");
    tracker.observe({
      toolName: "Bash",
      input: { command: "python -c \"from pathlib import Path; Path('generated.ts').write_text('...')\"" },
      result: result("done")
    });

    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    expect(tracker.getVerificationReport()).toMatchObject({
      workspaceChanged: true,
      changedFiles: ["generated.ts"]
    });
  });

  test("attributes indirect changes in an authorized additional root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-coding-main-root-"));
    const additionalRoot = mkdtempSync(join(tmpdir(), "lume-coding-additional-root-"));
    writeFileSync(join(additionalRoot, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit" },
    }), "utf-8");
    const tracker = createCodingRunTracker({
      workspaceRoot: root,
      additionalRoots: [additionalRoot],
    });
    await tracker.initialize();

    const generatedPath = join(additionalRoot, "generated.ts");
    await tracker.beforeToolExecution({
      toolName: "Bash",
      input: { command: `Set-Content -Path '${generatedPath}' -Value 'generated'` },
      cwd: root,
    });
    writeFileSync(generatedPath, "export const value = 1;\n", "utf-8");
    tracker.observe({
      toolName: "Bash",
      input: { command: `Set-Content -Path '${generatedPath}' -Value 'generated'` },
      result: result("done"),
    });

    await expect(tracker.completionGuard()).resolves.toContain("verification needed");
    expect(tracker.getVerificationReport()).toMatchObject({
      workspaceChanged: true,
      changedFiles: expect.arrayContaining([generatedPath]),
      recommendedVerificationCommands: [
        `bun run --cwd ${additionalRoot} typecheck`,
      ],
    });
  });
});
