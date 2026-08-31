/**
 * terminal-service 单测：shell 探测链（win32/unix）+ PTY 会话管理
 * （spawn 选项/ConPTY 双段降级/环境合并/写入/批量 flush/退出回收/dispose）。
 * 全部经注入依赖驱动（loadNodePty 桩体），不触碰真实进程。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { TerminalDataEvent, TerminalExitEvent } from "@lume/shared";
import {
  createTerminalService,
  detectShellForPlatform,
  detectUnixShell,
  detectWindowsShell,
  resolveFallbackUtf8Locale,
  resolveTerminalEnv,
  shouldFallbackFromConptyDll,
  spawnTerminalProcess,
  toNodePtyUnavailableError,
  type NodePtyModuleLike,
  type PtySessionLike,
  type TerminalServiceDeps,
} from "./terminal-service";

interface FakePty extends PtySessionLike, EventEmitter {
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
  emitData(chunk: string): void;
  emitExit(exitCode: number): void;
}

function createFakePty(): FakePty {
  const pty = new EventEmitter() as FakePty;
  pty.writes = [];
  pty.resizes = [];
  pty.killed = false;
  Object.assign(pty, {
    write: (data: string) => {
      pty.writes.push(data);
    },
    resize: (cols: number, rows: number) => {
      pty.resizes.push({ cols, rows });
    },
    kill: () => {
      pty.killed = true;
    },
    onData: (listener: (chunk: string) => void) => {
      pty.on("data", listener);
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      pty.on("exit", listener);
    },
    emitData: (chunk: string) => {
      pty.emit("data", chunk);
    },
    emitExit: (exitCode: number) => {
      pty.emit("exit", { exitCode });
    },
  });
  return pty;
}

interface Harness {
  outputs: TerminalDataEvent[];
  exits: TerminalExitEvent[];
  spawnOptions: Array<{ file: string; options: Record<string, unknown> }>;
  ptys: FakePty[];
  deps: (overrides?: Partial<TerminalServiceDeps>) => TerminalServiceDeps;
}

function createHarness(depsOverrides: Partial<TerminalServiceDeps> = {}): Harness {
  const outputs: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const spawnOptions: Harness["spawnOptions"] = [];
  const ptys: FakePty[] = [];
  const nodePty: NodePtyModuleLike = {
    spawn: (file, _args, options) => {
      spawnOptions.push({ file, options: options as Record<string, unknown> });
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
  };
  return {
    outputs,
    exits,
    spawnOptions,
    ptys,
    deps: (overrides = {}) => ({
      platform: "win32",
      env: { PATH: "C:\\bin", ComSpec: "C:\\Windows\\cmd.exe" },
      // 默认仅主目录/tmpdir 存在（cwd 兜底链按存在性探测，ZCode 同款）
      exists: (p) => p === "C:\\Users\\tester" || p === "C:\\Temp",
      homeDir: "C:\\Users\\tester",
      tmpDir: "C:\\Temp",
      loadNodePty: () => Promise.resolve(nodePty),
      generateId: (() => {
        let sequence = 0;
        return () => `id-${++sequence}`;
      })(),
      flushDelayMs: 5,
      onOutput: (event) => outputs.push(event),
      onExit: (event) => exits.push(event),
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

/* ── PTY spawn 选项 ───────────────────────────────────────────────────── */

describe("spawnTerminalProcess", () => {
  const base = {
    nodePty: {
      spawn: () => createFakePty(),
    } satisfies NodePtyModuleLike,
    shell: "C:\\b\\pwsh.exe",
    cols: 120,
    rows: 40,
    cwd: "C:\\repos\\lume",
    env: { TERM: "xterm-256color" },
  };

  test("win32 prefers ConPTY with useConptyDll:true and falls back on conpty.dll load failure", () => {
    const spawnCalls: Array<Record<string, unknown>> = [];
    const fakePty = createFakePty();
    const nodePty: NodePtyModuleLike = {
      spawn: (_file, _args, options) => {
        spawnCalls.push(options as Record<string, unknown>);
        if (options.useConptyDll) {
          throw new Error("conpty.node module file name not found (error code: 126)");
        }
        return fakePty;
      },
    };
    const pty = spawnTerminalProcess({ ...base, platform: "win32", nodePty });
    expect(pty).toBe(fakePty);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toMatchObject({ useConpty: true, useConptyDll: true, name: "xterm-256color", cols: 120, rows: 40 });
    expect(spawnCalls[1]).toMatchObject({ useConpty: true, useConptyDll: false });
  });

  test("win32 rethrows non-conpty spawn failures", () => {
    const nodePty: NodePtyModuleLike = {
      spawn: () => {
        throw new Error("spawn EACCES");
      },
    };
    expect(() => spawnTerminalProcess({ ...base, platform: "win32", nodePty })).toThrow(/spawn EACCES/);
  });

  test("unix spawns without conpty options", () => {
    const spawnCalls: Array<Record<string, unknown>> = [];
    const nodePty: NodePtyModuleLike = {
      spawn: (_file, _args, options) => {
        spawnCalls.push(options as Record<string, unknown>);
        return createFakePty();
      },
    };
    spawnTerminalProcess({ ...base, platform: "linux", nodePty });
    expect(spawnCalls[0]).toEqual({ name: "xterm-256color", cols: 120, rows: 40, cwd: base.cwd, env: base.env, encoding: "utf8" });
  });

  test("shouldFallbackFromConptyDll matches ZCode failure signatures", () => {
    expect(shouldFallbackFromConptyDll(new Error("Cannot find conpty.dll"))).toBe(true);
    expect(shouldFallbackFromConptyDll(new Error("conpty.node module handle is null"))).toBe(true);
    expect(shouldFallbackFromConptyDll(new Error("GetModuleFileNameExW failed (error code: 126)"))).toBe(true);
    expect(shouldFallbackFromConptyDll(new Error("spawn EACCES"))).toBe(false);
  });
});

/* ── 终端环境 ─────────────────────────────────────────────────────────── */

describe("resolveTerminalEnv", () => {
  test("fixes TERM/COLORTERM, drops CI=dumb, fills missing UTF-8 locales", () => {
    const env = resolveTerminalEnv({ TERM: "dumb", CI: "1", LANG: "C" }, "linux");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.CI).toBeUndefined();
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_CTYPE).toBe("C.UTF-8");
  });

  test("keeps existing UTF-8 locale and COLORTERM; darwin falls back to en_US.UTF-8", () => {
    const env = resolveTerminalEnv({ LANG: "zh_CN.UTF-8", COLORTERM: "24bit" }, "darwin");
    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(env.COLORTERM).toBe("24bit");
    expect(resolveFallbackUtf8Locale({}, "darwin")).toBe("en_US.UTF-8");
    expect(resolveFallbackUtf8Locale({ LC_ALL: "en_US.utf-8" }, "linux")).toBe("en_US.utf-8");
  });
});

/* ── 会话管理 ─────────────────────────────────────────────────────────── */

describe("terminal service sessions", () => {
  test("create spawns detected shell via node-pty with merged env and cwd fallback", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps({
      env: { PATH: "C:\\a;C:\\b", ComSpec: "C:\\Windows\\cmd.exe", USERNAME: "tester" },
      exists: (p) => p === "C:\\b\\pwsh.exe" || p === "C:\\repos\\lume" || p === "C:\\Users\\tester",
    }));

    const created = await service.create({ cwd: "C:\\repos\\lume", cols: 120, rows: 40 });
    expect(created).toEqual({ id: "id-1", shell: "C:\\b\\pwsh.exe" });
    const call = harness.spawnOptions[0]!;
    expect(call.file).toBe("C:\\b\\pwsh.exe");
    expect(call.options.cwd).toBe("C:\\repos\\lume");
    expect(call.options.useConpty).toBe(true);
    expect((call.options.env as NodeJS.ProcessEnv).TERM).toBe("xterm-256color");
    expect((call.options.env as NodeJS.ProcessEnv).USERNAME).toBe("tester");

    // 非法 cwd 回落主目录
    await service.create({ cwd: "C:\\does-not-exist" });
    expect(harness.spawnOptions[1]!.options.cwd).toBe("C:\\Users\\tester");
  });

  test("create propagates injected load failure; bundled loader wraps with ZCode message", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps({
      loadNodePty: () => Promise.reject(new Error("Cannot find module 'node-pty'")),
    }));
    // 注入的 loader 原样透传（包装发生在默认 loadBundledNodePty 内）
    await expect(service.create()).rejects.toThrow(/Cannot find module/);
    expect(toNodePtyUnavailableError(new Error("boom")).message).toBe(
      "node-pty is unavailable in this runtime: boom",
    );
    expect(harness.spawnOptions).toHaveLength(0);
  });

  test("cwd exhausted throws without spawning", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps({ exists: () => false }));
    await expect(service.create({ cwd: "C:\\gone" })).rejects.toThrow(/No usable working directory/);
  });

  test("write forwards data to the pty; unknown id is rejected", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = await service.create();

    service.write(created.id, "echo hi\r\n");
    expect(harness.ptys[0]!.writes).toEqual(["echo hi\r\n"]);

    expect(() => service.write("missing", "x")).toThrow(/不存在/);
    try {
      service.write("missing", "x");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("terminal_session_not_found");
    }
  });

  test("pty output is batched into flush windows", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = await service.create();

    harness.ptys[0]!.emitData("hel");
    harness.ptys[0]!.emitData("lo");
    expect(harness.outputs).toEqual([]); // flush 窗口内暂不外发

    await sleep(25);
    expect(harness.outputs).toEqual([{ id: created.id, data: "hello" }]);
  });

  test("oversized pending output flushes immediately without waiting the window", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps({ flushDelayMs: 60_000 }));
    const created = await service.create();

    harness.ptys[0]!.emitData("x".repeat(256_000));
    expect(harness.outputs).toHaveLength(1);
    expect(harness.outputs[0]!.id).toBe(created.id);
    expect(harness.outputs[0]!.data.length).toBe(256_000);
  });

  test("natural exit removes the session, emits terminal:exit payload, and invalidates writes", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = await service.create();

    harness.ptys[0]!.emitData("bye");
    harness.ptys[0]!.emitExit(0);
    await sleep(25);

    // 退出前缓冲被 flush；退出以结构化事件外发（不再写入退出提示行）
    expect(harness.outputs).toEqual([{ id: created.id, data: "bye" }]);
    expect(harness.exits).toEqual([{ id: created.id, exitCode: 0 }]);
    expect(() => service.write(created.id, "x")).toThrow(/不存在/);

    // 重复 exit（stale 事件）不再外发
    harness.ptys[0]!.emitExit(0);
    await sleep(25);
    expect(harness.exits).toHaveLength(1);
  });

  test("dispose kills silently; late exit event after dispose is swallowed", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = await service.create();

    service.dispose(created.id);
    service.dispose(created.id); // 幂等

    expect(harness.ptys[0]!.killed).toBe(true);
    harness.ptys[0]!.emitExit(1);
    await sleep(25);

    expect(harness.exits).toEqual([]);
    expect(harness.outputs).toEqual([]);
    expect(() => service.write(created.id, "x")).toThrow(/不存在/);
  });

  test("resize forwards normalized cols/rows to pty.resize and rejects unknown ids", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    const created = await service.create();

    service.resize(created.id, 100, 30);
    expect(harness.ptys[0]!.resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(() => service.resize("missing", 100, 30)).toThrow(/不存在/);
  });

  test("disposeAll kills every session", async () => {
    const harness = createHarness();
    const service = createTerminalService(harness.deps());
    await service.create();
    await service.create();

    service.disposeAll();
    expect(harness.ptys).toHaveLength(2);
    expect(harness.ptys.every((pty) => pty.killed)).toBe(true);
    expect(() => service.write("id-1", "x")).toThrow(/不存在/);
    expect(() => service.write("id-2", "x")).toThrow(/不存在/);
  });
});
