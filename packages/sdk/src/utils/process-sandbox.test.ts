import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandLine, buildSandboxEnvironment, getProcessSandboxSupport, probeProcessSandbox, spawnWithProcessSandbox } from "./process-sandbox";

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

  test("proves allowed read/write and denied-root enforcement when MXC is supported", async () => {
    if (!getProcessSandboxSupport().available) return;
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
