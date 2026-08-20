import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool, interpretShellExit, looksLikeInteractivePrompt } from "./bash";
import { clearTasks, TaskOutputTool } from "./task-tools";
import {
  createProcessJobRecord,
  loadProcessJobs,
  ProcessStopTool,
  updateProcessJob,
  waitForProcessJobTerminal,
} from "./process-job-registry";
import { resolveShellInvocation } from "../utils/shell-invocation";
import type { SDKMessage } from "../types";

describe("BashTool shell invocation", () => {
  test("classifies read-only shell commands dynamically for permissions and concurrency", () => {
    expect(BashTool.isReadOnly?.({ command: "git status" })).toBeTrue();
    expect(BashTool.isConcurrencySafe?.({ command: "git status" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "git commit -m change" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "rg TODO src > results.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "powershell -Command Get-ChildItem" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "powershell -Command Set-Content out.txt x" })).toBeFalse();
  });

  test("rejects write and execute argument forms of whitelisted executables", () => {
    // find
    expect(BashTool.isReadOnly?.({ command: "find . -name '*.ts'" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "find . -name x -delete" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "find . -fprint results.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "find . -exec rm {} \\;" })).toBeFalse();
    // sed
    expect(BashTool.isReadOnly?.({ command: "sed -n '10p' file.txt" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "sed 's/a/b/w /tmp/out' file.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "sed '/pattern/w /tmp/out' file.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "sed -i 's/a/b/' file.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "sed 's/x/date/e' file.txt" })).toBeFalse();
    // A `w` inside a pattern or replacement, or inside a path, stays read-only.
    expect(BashTool.isReadOnly?.({ command: "sed 's/w/x/g' file.txt" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "sed 's/a/b w /' file.txt" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "sed -n '1p' /var/www/with w space.txt" })).toBeTrue();
    // sort (grep -o is a different executable and unaffected)
    expect(BashTool.isReadOnly?.({ command: "sort input.txt" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "sort -o out.txt input.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "sort --output=out.txt input.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "grep -o pattern file.txt" })).toBeTrue();
  });

  test("uses PowerShell on Windows instead of requiring bash", () => {
    expect(resolveShellInvocation("echo hi", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; echo hi"],
    });
  });

  test("uses an explicitly configured POSIX shell on Windows", () => {
    expect(resolveShellInvocation("printf '中文\\n'", "win32", {
      LUME_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe",
    })).toEqual({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-c", "printf '中文\\n'"],
    });
  });

  test("allows an explicit PowerShell command under the native PowerShell wrapper", () => {
    expect(resolveShellInvocation("powershell -Command \"Remove-Item 'C:\\tmp\\a.exe' -Force\"", "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }).command).toBe("powershell.exe");
  });

  test("keeps bash on non-Windows platforms", () => {
    expect(resolveShellInvocation("echo hi", "darwin", {})).toEqual({
      command: "bash",
      args: ["-c", "echo hi"],
    });
  });

  test("returns bounded execution metadata without replacing the text result", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bash-result-"));
    const command = process.platform === "win32" ? "echo hello" : "printf hello";
    const result = await BashTool.call({ command, purpose: "verification", timeout: 10_000 }, { cwd: root });
    expect(result.content).toContain("hello");
    expect(result._meta?.execution).toMatchObject({
      version: 2,
      outcome: "succeeded",
      command,
      purpose: "verification",
      terminationReason: "completed",
    });
  }, 15_000);

  test("preserves non-ASCII output from the Windows fallback shell", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "lume-bash-utf8-"));
    const result = await BashTool.call({ command: "echo 中文", timeout: 10_000 }, { cwd: root });
    expect(result.content).toContain("中文");
  }, 15_000);

  test("does not mark a no-match search as a failed tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bash-semantic-"));
    const command = process.platform === "win32" ? "echo hello | findstr nomatch" : "printf hello | grep nomatch";
    const result = await BashTool.call({ command, timeout: 10_000 }, { cwd: root });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("No matches found");
  }, 15_000);

  test("recognizes PowerShell Select-String no-match as a semantic result", () => {
    expect(interpretShellExit("bun test | Select-String error", 1)).toEqual({
      isError: false,
      message: "No matches found",
      semanticOutcome: "no_matches",
    });
  });

  test("rejects filtered pipelines as verification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bash-verification-"));
    const command = process.platform === "win32"
      ? "bun test | Select-String pass"
      : "bun test | grep pass";
    const result = await BashTool.call({ command, purpose: "verification" }, { cwd: root });
    expect(result.is_error).toBeTrue();
    expect(result._meta?.error).toMatchObject({ code: "verification_pipeline_not_allowed" });
    expect(result._meta?.execution).toMatchObject({ version: 2, outcome: "failed" });
  });

  test("returns a running result and exposes terminal metadata through TaskOutput", async () => {
    clearTasks();
    const root = await mkdtemp(join(tmpdir(), "lume-bash-background-"));
    const command = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(resolveShellInvocation("").command)
      ? "Start-Sleep -Milliseconds 500; Write-Output background"
      : "sleep 0.5; printf background";
    const events: SDKMessage[] = [];
    const context = {
      cwd: root,
      sessionId: "background-test",
      artifactsRoot: join(root, "artifacts"),
      emitEvent: (event: SDKMessage) => events.push(event),
    };
    const started = await BashTool.call({ command, run_in_background: true }, context);
    const taskId = String(started.content).match(/task_\d+/)?.[0];
    expect(taskId).toBeTruthy();
    expect(started.content).toContain("You will be notified when it completes");
    expect(started.content).toContain("Output is being written to:");
    expect(started._meta?.execution).toMatchObject({ terminationReason: "running" });

    const completed = await TaskOutputTool.call({ task_id: taskId, block: true, timeout: 10_000 }, context);
    expect(completed.content).toContain("background");
    expect(completed._meta?.execution).toMatchObject({ terminationReason: "completed", command });

    const incremental = await TaskOutputTool.call({ task_id: taskId, block: false, offset: 0, limit: 4 }, context);
    expect(incremental.content).toContain("back");
    expect(incremental._meta?.task).toMatchObject({ outputOffset: 0, nextOffset: 4, truncated: true });
    expect(events.filter((event) =>
      event.type === "system"
      && event.subtype === "task_notification"
      && event.task_id === taskId
    )).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status: "completed",
      output_file: expect.stringContaining("process-jobs"),
    }));
  }, 15_000);

  test("only classifies likely interactive prompts as stalled input", () => {
    expect(looksLikeInteractivePrompt("Install dependencies? (Y/n)")).toBeTrue();
    expect(looksLikeInteractivePrompt("Are you sure you want to continue?")).toBeTrue();
    expect(looksLikeInteractivePrompt("Press Enter to continue")).toBeTrue();
    expect(looksLikeInteractivePrompt("building package 48 of 100")).toBeFalse();
    expect(looksLikeInteractivePrompt("test suite still running")).toBeFalse();
  });

  test("does not emit a duplicate terminal notification after ProcessStop", async () => {
    clearTasks();
    const root = await mkdtemp(join(tmpdir(), "lume-bash-stop-"));
    const command = process.platform === "win32"
      ? "Start-Sleep -Seconds 5; Write-Output should-not-complete"
      : "sleep 5; printf should-not-complete";
    const events: SDKMessage[] = [];
    let backgroundCompletions = 0;
    const context = {
      cwd: root,
      sessionId: "background-stop-test",
      artifactsRoot: join(root, "artifacts"),
      emitEvent: (event: SDKMessage) => events.push(event),
      onBackgroundTaskCompleted: () => {
        backgroundCompletions += 1;
      },
    };
    const started = await BashTool.call({ command, run_in_background: true }, context);
    const taskId = String(started.content).match(/task_\d+/)?.[0];
    expect(taskId).toBeTruthy();

    const stopped = await ProcessStopTool.call({ task_id: taskId }, context);
    expect(stopped.content).toContain("stopped");
    for (let attempt = 0; attempt < 100 && backgroundCompletions === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(events.filter((event) =>
      event.type === "system"
      && event.subtype === "task_notification"
      && event.task_id === taskId
    )).toHaveLength(0);
    expect(backgroundCompletions).toBe(1);
  }, 15_000);

  test("reattaches a durable background command after the in-memory registry is cleared", async () => {
    clearTasks();
    const root = await mkdtemp(join(tmpdir(), "lume-bash-recovery-"));
    const command = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(resolveShellInvocation("").command)
      ? "Start-Sleep -Milliseconds 300; Write-Output recovered"
      : "sleep 0.3; printf recovered";
    const context = {
      cwd: root,
      sessionId: "background-recovery-test",
      artifactsRoot: join(root, "artifacts"),
    };
    const started = await BashTool.call({ command, run_in_background: true }, context);
    const taskId = String(started.content).match(/task_\d+/)?.[0];
    expect(taskId).toBeTruthy();

    clearTasks();
    const recovered = await TaskOutputTool.call({ task_id: taskId, block: true, timeout: 10_000 }, context);
    expect(recovered.content).toContain("recovered");
    expect(recovered._meta?.execution).toMatchObject({ version: 2, outcome: "succeeded" });
  }, 15_000);

  test("does not reattach a reused worker PID with a different process identity", async () => {
    clearTasks();
    const root = await mkdtemp(join(tmpdir(), "lume-bash-identity-"));
    const jobDir = join(root, "task_identity");
    createProcessJobRecord({
      id: "task_identity",
      subject: "identity mismatch",
      status: "running",
      jobDir,
      workerPid: process.pid,
      processToken: "expected-token",
      workerIdentity: "expected-token:not-the-current-process",
      heartbeatAt: Date.now(),
    });

    clearTasks();
    const [recovered] = loadProcessJobs(root);

    expect(recovered).toMatchObject({
      id: "task_identity",
      status: "interrupted",
      metadata: {
        execution: {
          version: 2,
          outcome: "interrupted",
        },
      },
    });
  }, 15_000);

  test("keeps UTF-8 intact when TaskOutput resumes inside a multibyte character", async () => {
    clearTasks();
    const job = createProcessJobRecord({ subject: "utf8", status: "completed", output: "甲乙丙" });
    const result = await TaskOutputTool.call({ task_id: job.id, block: false, offset: 1, limit: 4 }, { cwd: tmpdir() });
    expect(result.content).toContain("乙");
    expect(result.content).not.toContain("�");
  });

  test("returns a concrete diagnostic when the background output file is unavailable", async () => {
    clearTasks();
    const missingFile = join(tmpdir(), `missing-background-${crypto.randomUUID()}.log`);
    const job = createProcessJobRecord({
      subject: "missing output",
      status: "completed",
      outputFile: missingFile,
      output: "last captured output",
    });

    const result = await TaskOutputTool.call({ task_id: job.id, block: false }, { cwd: tmpdir() });

    expect(result.content).toContain("Unable to read background output file");
    expect(result.content).toContain("missing-background-");
    expect(result.content).toContain("last captured output");
  });

  test("wakes host-side waiters when a background process reaches a terminal state", async () => {
    clearTasks();
    const job = createProcessJobRecord({ subject: "waiter", status: "running" });
    const waiting = waitForProcessJobTerminal(job.id, 5_000);

    updateProcessJob(job.id, { status: "completed", output: "done" });

    await expect(waiting).resolves.toMatchObject({ id: job.id, status: "completed", output: "done" });
  });

  test("returns the running state when a host-side wait reaches its timeout", async () => {
    clearTasks();
    const job = createProcessJobRecord({ subject: "slow", status: "running" });

    await expect(waitForProcessJobTerminal(job.id, 10)).resolves.toMatchObject({
      id: job.id,
      status: "running",
    });
  });

  test("cancels a host-side wait immediately", async () => {
    clearTasks();
    const job = createProcessJobRecord({ subject: "cancel wait", status: "running" });
    const controller = new AbortController();
    const waiting = waitForProcessJobTerminal(job.id, 5_000, controller.signal);

    controller.abort();

    await expect(waiting).rejects.toThrow("aborted");
  });
});
