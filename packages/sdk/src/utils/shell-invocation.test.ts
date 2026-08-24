import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import {
  discoverWindowsBashPath,
  resetWindowsBashDiscoveryForTests,
  resolveShellInvocation,
  shellKind,
  shellKindConservative,
  shellKindWithoutDiscovery,
  windowsBashDiscoverySettledForTests,
} from "./shell-invocation";

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

describe("shellKindConservative (cold-start fail-closed)", () => {
  test("matches the exact reading outside the unsettled-discovery window", () => {
    // 显式环境是确定性的，保守读法必须与精确读法完全一致
    expect(shellKindConservative("darwin", {})).toBe("bash");
    expect(shellKindConservative("linux", {})).toBe("bash");
    expect(shellKindConservative("win32", {})).toBe("powershell");
    expect(shellKindConservative("win32", { LUME_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" })).toBe("bash");
    expect(shellKindConservative("win32", { SHELL: "/usr/bin/bash" })).toBe("bash");
  });
});

// #471 follow-up: discovery itself must distinguish "absent" from "not
// settled yet" so a timed-out lookup does not freeze the PowerShell fallback
// for the rest of the process.
type ReturnShape = { status?: number | null; stdout?: string; error?: Error };
const asReturn = (shape: ReturnShape) => shape as unknown as ReturnType<typeof spawnSync>;
const asSpawner = (fn: (file: string, args: string[]) => ReturnShape) =>
  fn as unknown as typeof spawnSync;

describe("Windows bash discovery determinism", () => {
  test("timed-out where.exe does not poison the cache", () => {
    resetWindowsBashDiscoveryForTests();
    let lookups = 0;
    const hangingWhere = asSpawner(() => {
      lookups += 1;
      return asReturn({ status: null });
    });

    expect(discoverWindowsBashPath(hangingWhere)).toBeUndefined();
    expect(lookups).toBe(1);
    expect(windowsBashDiscoverySettledForTests()).toBeFalse();

    // A later call retries and can still find bash.
    const found = discoverWindowsBashPath(
      asSpawner(() => asReturn({ status: 0, stdout: "C:\\tools\\bash.exe\n" })),
      asSpawner(() => asReturn({ status: 0 })),
    );
    expect(found).toBe("C:\\tools\\bash.exe");
    expect(windowsBashDiscoverySettledForTests()).toBeTrue();
  });

  test("definitive absence freezes without re-probing", () => {
    resetWindowsBashDiscoveryForTests();
    let lookups = 0;
    const missingWhere = asSpawner(() => {
      lookups += 1;
      return asReturn({ status: 1 });
    });

    expect(discoverWindowsBashPath(missingWhere)).toBeUndefined();
    expect(discoverWindowsBashPath(missingWhere)).toBeUndefined();
    expect(lookups).toBe(1);
    expect(windowsBashDiscoverySettledForTests()).toBeTrue();
  });

  test("interrupted probe round stays open for retry", () => {
    resetWindowsBashDiscoveryForTests();
    const listingWhere = asSpawner(() => asReturn({ status: 0, stdout: "C:\\slow\\bash.exe\n" }));
    let probes = 0;
    const timingOutProbe = asSpawner(() => {
      probes += 1;
      return asReturn({ status: null });
    });

    expect(discoverWindowsBashPath(listingWhere, timingOutProbe)).toBeUndefined();
    expect(windowsBashDiscoverySettledForTests()).toBeFalse();

    // Same candidate answers promptly on the retry round.
    expect(
      discoverWindowsBashPath(listingWhere, asSpawner(() => asReturn({ status: 0 })))
    ).toBe("C:\\slow\\bash.exe");
    expect(probes).toBe(1);
  });

  test("probes failing definitively settle absent", () => {
    resetWindowsBashDiscoveryForTests();
    const listingWhere = asSpawner(() => asReturn({ status: 0, stdout: "C:\\stub\\bash.exe\n" }));
    const rejectingProbe = asSpawner(() => asReturn({ status: 1 }));

    expect(discoverWindowsBashPath(listingWhere, rejectingProbe)).toBeUndefined();
    expect(windowsBashDiscoverySettledForTests()).toBeTrue();
  });

  test("consecutive indeterminate rounds eventually settle absent", () => {
    resetWindowsBashDiscoveryForTests();
    let lookups = 0;
    const hangingWhere = asSpawner(() => {
      lookups += 1;
      return asReturn({ error: new Error("wedged"), status: null });
    });

    // Bounded retry: repeated wedged rounds stop paying the latency cost.
    expect(discoverWindowsBashPath(hangingWhere)).toBeUndefined();
    expect(discoverWindowsBashPath(hangingWhere)).toBeUndefined();
    expect(discoverWindowsBashPath(hangingWhere)).toBeUndefined();
    const callsAfterCap = lookups;
    expect(discoverWindowsBashPath(hangingWhere)).toBeUndefined();
    expect(lookups).toBe(callsAfterCap);
    expect(windowsBashDiscoverySettledForTests()).toBeTrue();
  });
});
