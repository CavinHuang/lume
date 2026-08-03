import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

  test("stops after one automatic verification repair", async () => {
    const tracker = createCodingRunTracker();
    tracker.observe({ toolName: "Write", input: { file_path: "a.ts" }, result: result("written") });
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: verificationResult("failed test", "failed") });
    await tracker.completionGuard();
    tracker.observe({ toolName: "Bash", input: { command: "bun test", purpose: "verification" }, result: verificationResult("failed again", "failed") });
    await expect(tracker.completionGuard()).resolves.toMatchObject({
      type: "stop",
      errorCode: "verification_failed_after_repair",
      message: expect.stringContaining("停止继续消耗 token")
    });
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

  test("keeps a running background task recoverable without failing the Run", async () => {
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

  test("persists delayed LSP diagnostics in the Coding report without changing verification", () => {
    const workspaceRoot = join(tmpdir(), "lume-lsp-report");
    const tracker = createCodingRunTracker({ workspaceRoot });
    expect(tracker.observeAsyncEvent({
      type: "system",
      subtype: "lsp_diagnostics",
      file_path: join(workspaceRoot, "src", "index.ts"),
      mutation_version: 2,
      sha256: "abc",
      delayed: true,
      diagnostics: {
        servers: ["typescript-language-server"],
        total: 2,
        errors: 1,
        warnings: 1,
        truncated: false,
        items: [],
      },
    })).toBe(true);

    expect(tracker.getVerificationReport()).toMatchObject({
      status: "not_required",
      lspDiagnostics: {
        files: ["src/index.ts"],
        total: 2,
        errors: 1,
        warnings: 1,
      },
    });
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
