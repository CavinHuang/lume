import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "./bash";
import { clearTasks, TaskOutputTool } from "./task-tools";
import { resolveShellInvocation } from "../utils/shell-invocation";

describe("BashTool shell invocation", () => {
  test("classifies read-only shell commands dynamically for permissions and concurrency", () => {
    expect(BashTool.isReadOnly?.({ command: "git status" })).toBeTrue();
    expect(BashTool.isConcurrencySafe?.({ command: "rg TODO src" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "git commit -m change" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "rg TODO src > results.txt" })).toBeFalse();
    expect(BashTool.isReadOnly?.({ command: "powershell -Command Get-ChildItem" })).toBeTrue();
    expect(BashTool.isReadOnly?.({ command: "powershell -Command Set-Content out.txt x" })).toBeFalse();
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
      version: 1,
      command,
      purpose: "verification",
      terminationReason: "completed",
    });
  });

  test("preserves non-ASCII output from the Windows fallback shell", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "lume-bash-utf8-"));
    const result = await BashTool.call({ command: "echo 中文", timeout: 10_000 }, { cwd: root });
    expect(result.content).toContain("中文");
  });

  test("does not mark a no-match search as a failed tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-bash-semantic-"));
    const command = process.platform === "win32" ? "echo hello | findstr nomatch" : "printf hello | rg nomatch";
    const result = await BashTool.call({ command, timeout: 10_000 }, { cwd: root });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("No matches found");
  });

  test("returns a running result and exposes terminal metadata through TaskOutput", async () => {
    clearTasks();
    const root = await mkdtemp(join(tmpdir(), "lume-bash-background-"));
    const command = process.platform === "win32" ? "echo background" : "printf background";
    const context = { cwd: root, sessionId: "background-test", artifactsRoot: join(root, "artifacts") };
    const started = await BashTool.call({ command, run_in_background: true }, context);
    const taskId = String(started.content).match(/task_\d+/)?.[0];
    expect(taskId).toBeTruthy();
    expect(started._meta?.execution).toMatchObject({ terminationReason: "running" });

    const completed = await TaskOutputTool.call({ task_id: taskId, block: true, timeout: 5_000 }, context);
    expect(completed.content).toContain("background");
    expect(completed._meta?.execution).toMatchObject({ terminationReason: "completed", command });

    const incremental = await TaskOutputTool.call({ task_id: taskId, block: false, offset: 0, limit: 4 }, context);
    expect(incremental.content).toContain("back");
    expect(incremental._meta?.task).toMatchObject({ outputOffset: 0, nextOffset: 4, truncated: true });
  });
});
