/**
 * terminal-service 单测：shell 探测链（win32/unix）+ 会话管理
 * （spawn 环境合并/写入/批量 flush/退出回收/dispose）。
 * 全部经注入依赖驱动，不触碰真实进程。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { TerminalDataEvent } from "@lume/shared";
import {
  createTerminalService,
  detectShellForPlatform,
  detectUnixShell,
  detectWindowsShell,
  type TerminalServiceDeps,
  type TerminalSessionProcess,
} from "./terminal-service";

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
}

function createFakeProcess(): FakeProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      killed = true;
      return true;
    },
  }) as FakeProcess;
  let killed = false;
  Object.defineProperty(proc, "isKilled", { get: () => killed });
  return proc;
}

interface Harness {
  outputs: TerminalDataEvent[];
  spawnCalls: Array<{ command: string; args: readonly string[]; cwd?: string | URL; env?: NodeJS.ProcessEnv }>;
  processes: FakeProcess[];
  deps: (overrides?: Partial<TerminalServiceDeps>) => TerminalServiceDeps;
}

function createHarness(depsOverrides: Partial<TerminalServiceDeps> = {}): Harness {
  const outputs: TerminalDataEvent[] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  const processes: FakeProcess[] = [];
  return {
    outputs,
    spawnCalls,
    processes,
    deps: (overrides = {}) => ({
      platform: "win32",
      env: { PATH: "C:\\bin", ComSpec: "C:\\Windows\\cmd.exe" },
      exists: () => false,
      homeDir: "C:\\Users\\tester",
      spawnShell: (command, args, options) => {
        const proc = createFakeProcess();
        spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
        processes.push(proc);
        return proc as unknown as TerminalSessionProcess;
      },
      generateId: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      flushDelayMs: 5,
      onOutput: (event) => outputs.push(event),
      ...depsOverrides,
      ...overrides,
    }),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ── shell 探测 ───────────────────────────────────────────────────────── */

describe("detectWindowsShell", () => {
  test("prefers pwsh.exe found on PATH", () => {
    const dirs = { PATH: "C:\\a;C:\\b" };
    expect(detectWindowsShell(dirs, (p) => p === "C:\\b\\pwsh.exe")).toBe("C:\\b\\pwsh.exe");
  });

  test("falls back to powershell.exe then ComSpec then cmd.exe", () => {
    const env = { PATH: "C:\\a", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    expect(detectWindowsShell(env, (p) => p === "C:\\a\\powershell.exe")).toBe("C:\\a\\powershell.exe");
    expect(detectWindowsShell({ PATH: "C:\\a", ComSpec: env.ComSpec }, () => false)).toBe(env.ComSpec!);
    expect(detectWindowsShell({ PATH: "C:\\a" }, () => false)).toBe("cmd.exe");
  });
});

describe("detectUnixShell", () => {
  test("honors $SHELL, then filesystem candidates, then /bin/sh", () => {
    expect(detectUnixShell({ SHELL: "/usr/bin/fish" }, () => false)).toBe("/usr/bin/fish");
    expect(detectUnixShell({}, (p) => p === "/bin/bash")).toBe("/bin/bash");
    expect(detectUnixShell({}, () => false)).toBe("/bin/sh");
  });
});

describe("detectShellForPlatform", () => {
  test("dispatches by platform", () => {
    expect(detectShellForPlatform("win32", { ComSpec: "cmd" }, () => false)).toBe("cmd");
    expect(detectShellForPlatform("darwin", { SHELL: "/bin/zsh" }, () => false)).toBe("/bin/zsh");
    expect(detectShellForPlatform("linux", {}, () => false)).toBe("/bin/sh");
  });
});

/* ── 会话管理 ─────────────────────────────────────────────────────────── */

describe("terminal service sessions", () => {
  test("create spawns detected shell with merged env and cwd fallback", () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps({
      env: { PATH: "C:\\a;C:\\b", ComSpec: "C:\\Windows\\cmd.exe", USERNAME: "tester" },
      exists: (p) => p === "C:\\b\\pwsh.exe" || p === "C:\\repos\\lume",
    }));

    const created = service.create({ cwd: "C:\\repos\\lume", cols: 120, rows: 40 });
    expect(created).toEqual({ id: "id-1", shell: "C:\\b\\pwsh.exe" });
    const call = harness.spawnCalls[0]!;
    expect(call.cwd).toBe("C:\\repos\\lume");
    expect(call.env?.TERM).toBe("xterm-256color");
    expect(call.env?.COLORTERM).toBe("truecolor");
    expect(call.env?.USERNAME).toBe("tester");

    // 非法 cwd 回落主目录
    service.create({ cwd: "C:\\does-not-exist" });
    expect(harness.spawnCalls[1]!.cwd).toBe("C:\\Users\\tester");
  });

  test("write forwards data to shell stdin; unknown id is rejected", () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = service.create();

    const chunks: string[] = [];
    harness.processes[0]!.stdin.on("data", (chunk) => chunks.push(String(chunk)));
    service.write(created.id, "echo hi\r\n");
    expect(chunks.join("")).toBe("echo hi\r\n");

    expect(() => service.write("missing", "x")).toThrow(/不存在/);
    try {
      service.write("missing", "x");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("terminal_session_not_found");
    }
  });

  test("stdout and stderr are batched into flush windows", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = service.create();

    harness.processes[0]!.stdout.emit("data", "hel");
    harness.processes[0]!.stdout.emit("data", "lo ");
    harness.processes[0]!.stderr.emit("data", "err");
    expect(harness.outputs).toEqual([]); // flush 窗口内暂不外发

    await sleep(25);
    expect(harness.outputs).toEqual([{ id: created.id, data: "hello err" }]);
  });

  test("oversized pending output flushes immediately without waiting the window", () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps({ flushDelayMs: 60_000 }));
    const created = service.create();

    harness.processes[0]!.stdout.emit("data", "x".repeat(256_000));
    expect(harness.outputs).toHaveLength(1);
    expect(harness.outputs[0]!.id).toBe(created.id);
    expect(harness.outputs[0]!.data.length).toBe(256_000);
  });

  test("process close removes the session, emits an exit notice, and invalidates writes", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = service.create();

    harness.processes[0]!.emit("close", 0);
    await sleep(25);

    expect(harness.outputs.some((event) => event.data.includes("进程已退出 (code=0)"))).toBe(true);
    expect(() => service.write(created.id, "x")).toThrow(/不存在/);

    // 重复 close（stale 事件）不再外发
    const count = harness.outputs.length;
    harness.processes[0]!.emit("close", 0);
    await sleep(25);
    expect(harness.outputs).toHaveLength(count);
  });

  test("spawn failure surfaces as an error notice and removes the session", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = service.create();

    harness.processes[0]!.emit("error", new Error("spawn EACCES"));
    await sleep(25);

    expect(harness.outputs.some((event) => event.data.includes("无法启动 shell"))).toBe(true);
    expect(() => service.write(created.id, "x")).toThrow(/不存在/);
  });

  test("dispose kills silently without an exit notice", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = service.create();

    service.dispose(created.id);
    service.dispose(created.id); // 幂等

    harness.processes[0]!.emit("close", 1);
    await sleep(25);

    expect(harness.outputs).toEqual([]);
    expect(() => service.write(created.id, "x")).toThrow(/不存在/);
  });

  test("resize accepts valid sessions and rejects unknown ids", () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = service.create();

    expect(() => service.resize(created.id, 100, 30)).not.toThrow();
    expect(() => service.resize("missing", 100, 30)).toThrow(/不存在/);
  });

  test("disposeAll kills every session", () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    service.create();
    service.create();

    service.disposeAll();
    expect(harness.processes).toHaveLength(2);
    expect(() => service.write("id-1", "x")).toThrow(/不存在/);
    expect(() => service.write("id-2", "x")).toThrow(/不存在/);
  });
});
