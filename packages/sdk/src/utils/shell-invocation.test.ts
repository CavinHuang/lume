import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import {
  discoverWindowsBashPath,
  hasDefinitiveShellResolution,
  resetWindowsBashDiscoveryForTests,
  windowsBashDiscoverySettledForTests,
} from "./shell-invocation";

// #471: Windows bash discovery must distinguish "absent" from "not settled
// yet". A timed-out lookup is retried on a later call instead of freezing the
// PowerShell fallback for the rest of the process, and permission
// classification treats the unsettled window as non-definitive.

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

describe("hasDefinitiveShellResolution", () => {
  test("non-Windows platforms are always definitive", () => {
    resetWindowsBashDiscoveryForTests();
    expect(hasDefinitiveShellResolution("linux")).toBeTrue();
    expect(hasDefinitiveShellResolution("darwin")).toBeTrue();
  });

  test("explicit environments resolve statically", () => {
    resetWindowsBashDiscoveryForTests();
    expect(hasDefinitiveShellResolution("win32", { LUME_BASH_PATH: "C:\\git\\bin\\bash.exe" })).toBeTrue();
    // No config: fixed PowerShell fallback, no discovery involved.
    expect(hasDefinitiveShellResolution("win32", {})).toBeTrue();
  });
});
