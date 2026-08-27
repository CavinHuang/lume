import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createConfigFromPolicy } from "@microsoft/mxc-sdk";
import { buildCommandLine, buildSandboxEnvironment, getProcessSandboxSupport, probeProcessSandbox, pruneMissingMxcDaclRecoveryEntries, SANDBOX_POLICY_VERSION, spawnWithProcessSandbox } from "./process-sandbox";

// macOS 26+ 收紧了 sandbox-exec：deny file-write* 下 allow subpath 的写入直接
// Operation not permitted，而 mxc-sdk 仅探测二进制存在即声称 seatbelt 可用——
// available 守卫不再足以代表"沙箱真的能执行"。先实测一次最小写探针（同
// file-tools.test.ts 的 symlink 探针先例），本机不可用则跳过执行类断言。
const seatbeltUsable = (() => {
  if (process.platform !== "darwin") return true;
  try {
    const probeDir = mkdtempSync(join(tmpdir(), "lume-seatbelt-probe-"));
    const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "${probeDir}"))`;
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/touch", join(probeDir, "probe")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    rmSync(probeDir, { recursive: true, force: true });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OS process sandbox", () => {
  test("quotes Windows executable and trailing backslashes", () => {
    expect(buildCommandLine("C:\\Program Files\\node.exe", ["a b", "C:\\work\\"], "win32"))
      .toBe('"C:\\Program Files\\node.exe" "a b" C:\\work\\');
  });

  test("prepends selected executable directories without mutating the source environment", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-process-sandbox-path-"));
    roots.push(root);
    const source = { Path: "C:\\Windows\\System32" };

    const env = buildSandboxEnvironment(source, [root], "win32");

    expect(env.Path).toBe(`${root};C:\\Windows\\System32`);
    expect(source.Path).toBe("C:\\Windows\\System32");
  });

  test("prunes only dead MXC recovery entries whose targets no longer exist", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-mxc-dacl-state-"));
    roots.push(root);
    const stale = join(root, "pid-2147483647-deadbeef.json");
    const live = join(root, `pid-${process.pid}-feedface.json`);
    const recoverable = join(root, "pid-2147483646-cafebabe.json");
    const missingTarget = join(root, "already-removed");
    const existingTarget = join(root, "still-present");
    mkdirSync(existingTarget);
    const state = (pid: number, target = missingTarget) => JSON.stringify({
      pid,
      image_name: "wxc-exec.exe",
      applied: [{ canonical_path: target }]
    });
    writeFileSync(stale, state(2147483647));
    writeFileSync(live, state(process.pid));
    writeFileSync(recoverable, state(2147483646, existingTarget));

    expect(pruneMissingMxcDaclRecoveryEntries(root)).toBe(1);
    expect(existsSync(stale)).toBeFalse();
    expect(existsSync(live)).toBeTrue();
    expect(existsSync(recoverable)).toBeTrue();
  });

  // 可见 skip(bun:test 不认 options.skip 对象,须用 skipIf):macOS 26+ seatbelt
  // 收紧或平台不支持时本断言会长期跳过,CI 报表须能区分 skipped 与 passed
  const sandboxExecutable = getProcessSandboxSupport().available && seatbeltUsable;

  test.skipIf(!sandboxExecutable)("proves allowed read/write and denied-root enforcement when MXC is supported", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-process-sandbox-test-"));
    roots.push(root);
    const allowed = join(root, "allowed");
    const denied = join(root, "denied");
    mkdirSync(allowed);
    mkdirSync(denied);

    const result = await probeProcessSandbox({
      probeRoot: allowed,
      deniedPath: denied,
      readwritePaths: [allowed]
    });

    expect(result.verified).toBe(true);
  }, 45_000);

  test.skipIf(!sandboxExecutable)("fails closed when an allowed root contains the denied root", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-process-sandbox-overlap-"));
    roots.push(root);
    const denied = join(root, "wiki");
    mkdirSync(denied);

    expect(() => spawnWithProcessSandbox(process.execPath, ["-e", "process.exit(0)"], {
      cwd: root,
      stdio: "ignore"
    }, {
      enabled: true,
      filesystem: { denyRead: [denied], denyWrite: [denied] },
      processIsolation: { enabled: true, required: true, readwritePaths: [root], deniedPaths: [denied] }
    })).toThrow("overlapping allowed and denied roots");
  });

  test("policy version stays inside the SDK contract window", () => {
    // createConfigFromPolicy 入口校验 version 必须落在 SDK 契约窗口内
    // (0.8.0 为 [0.6.0-alpha, 0.9.0-alpha],私有常量),越窗运行时抛错。
    // 此钉跨平台可跑(CI Linux 的 MXC probe 会空转,本钉不会):升级 SDK
    // 窗口漂移时在此显式失败,提醒同步 SANDBOX_POLICY_VERSION。
    expect(() => createConfigFromPolicy({
      version: SANDBOX_POLICY_VERSION,
      filesystem: { readonlyPaths: [], readwritePaths: [], deniedPaths: [] },
      network: { allowOutbound: false, allowLocalNetwork: false },
      ui: { allowWindows: false, clipboard: "none", allowInputInjection: false },
    }, "process", "LumePolicyVersionPin")).not.toThrow();
  });
});
