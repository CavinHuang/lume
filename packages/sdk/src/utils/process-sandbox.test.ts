import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCommandLine, buildSandboxEnvironment, getProcessSandboxSupport, probeProcessSandbox, pruneMissingMxcDaclRecoveryEntries, spawnWithProcessSandbox } from "./process-sandbox";

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

  test("proves allowed read/write and denied-root enforcement when MXC is supported", async () => {
    if (!getProcessSandboxSupport().available) return;
    if (!seatbeltUsable) return;
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

  test("fails closed when an allowed root contains the denied root", () => {
    if (!getProcessSandboxSupport().available) return;
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
});
