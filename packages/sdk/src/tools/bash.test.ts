import { describe, expect, test } from "bun:test";
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
});
