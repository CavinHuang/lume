import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "./bash";
import { clearTasks, TaskOutputTool } from "./task-tools";
import { resolveShellInvocation } from "../utils/shell-invocation";

describe("BashTool shell invocation", () => {
  test("uses cmd.exe on Windows instead of requiring bash", () => {
    expect(resolveShellInvocation("echo hi", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo hi"],
    });
  });

  test("adds NoProfile for explicit Windows PowerShell commands", () => {
    expect(resolveShellInvocation("powershell -Command \"Remove-Item 'C:\\tmp\\a.exe' -Force\"", "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }).args).toEqual([
      "/d",
      "/s",
      "/c",
      "powershell -NoProfile -Command \"Remove-Item 'C:\\tmp\\a.exe' -Force\"",
    ]);
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
  });
});
