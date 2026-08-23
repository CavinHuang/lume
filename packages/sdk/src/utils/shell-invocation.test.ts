import { describe, expect, test } from "bun:test";
import { resolveShellInvocation, shellKind, shellKindWithoutDiscovery } from "./shell-invocation";

describe("shellKindWithoutDiscovery (#471)", () => {
  test("non-Windows reads bash without probing", () => {
    expect(shellKindWithoutDiscovery("darwin", {})).toBe("bash");
    expect(shellKindWithoutDiscovery("linux", {})).toBe("bash");
  });

  test("configured bash env reads bash", () => {
    expect(shellKindWithoutDiscovery("win32", { LUME_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" })).toBe("bash");
    expect(shellKindWithoutDiscovery("win32", { SHELL: "/usr/bin/bash" })).toBe("bash");
  });

  test("explicit env without bash config mirrors the PowerShell fallback", () => {
    expect(shellKindWithoutDiscovery("win32", {})).toBe("powershell");
  });

  test("matches resolveShellInvocation's dialect for explicit environments", () => {
    for (const env of [
      {},
      { LUME_BASH_PATH: "C:\\cygwin64\\bin\\bash.exe" },
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    ]) {
      const resolved = resolveShellInvocation("echo hi", "win32", env);
      expect(shellKind(resolved.command)).toBe(shellKindWithoutDiscovery("win32", env));
    }
  });
});
