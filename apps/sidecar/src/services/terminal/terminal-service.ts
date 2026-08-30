/**
 * sidecar 终端会话服务 —— 右侧面板「终端」tab 的 PTY 执行体。
 *
 * 结构对齐 ZCode host 进程 createTerminalService（docs/analysis/P3-wiki-terminal.md §2）：
 * shell 探测链 + 会话表（Map<id, {process, cols, rows}>）+ 输出事件外发。差异：
 *
 *  - MVP 用 child_process.spawn 管道（stdio: 'pipe'）而非 node-pty：sidecar 是
 *    纯 Node 进程，node-pty 原生模块需按 Electron ABI rebuild，引入成本高。
 *    升级路径：把 spawnShell 换成 node-pty 的 pty.spawn（接口同形：write/resize/
 *    kill + onData/onExit），并在 resize 中接 pty.resize —— 其余层（bridge/IPC/
 *    renderer）无需改动。管道模式的已知限制：无行编辑/回显由 shell 自理
 *    （交互式提示可用），TUI 程序（vim/htop）与 resize 真实生效需 node-pty。
 *  - 输出 50ms 批量 flush（终端数据可能高频，逐 chunk 过 RPC/postMessage 代价高）。
 *
 * 传输：本服务不感知 IPC；输出经构造注入的 onOutput 回调外发，
 * 由 terminal-bridge.ts 落到 terminal:data 通知。
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

import { type TerminalCreateResult, type TerminalDataEvent } from "@lume/shared";

/** 单次批量 flush 的输出上限（字节）：超出立即 flush，防单个 timer 窗口内无限堆积。 */
const MAX_FLUSH_BYTES = 256_000;
const DEFAULT_FLUSH_DELAY_MS = 50;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** 会话进程的最小结构面（Node ChildProcess 满足；测试以 EventEmitter+流桩体伪造）。 */
export interface TerminalSessionProcess {
  stdin: { write(chunk: string): unknown } | null;
  stdout: { setEncoding(encoding: string): unknown; on(event: "data", listener: (chunk: string) => void): unknown } | null;
  stderr: { setEncoding(encoding: string): unknown; on(event: "data", listener: (chunk: string) => void): unknown } | null;
  kill(exitCode?: number | NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

type SpawnShell = (command: string, args: readonly string[], options: SpawnOptions) => TerminalSessionProcess;

export interface TerminalServiceDeps {
  /** shell 探测的平台/环境/存在性全部注入，测试可钉死 win32/unix 探测链。 */
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  homeDir: string;
  spawnShell: SpawnShell;
  generateId: () => string;
  /** 输出批量 flush 间隔（0 = 逐 chunk 立即外发）。 */
  flushDelayMs: number;
  onOutput: (event: TerminalDataEvent) => void;
}

export interface TerminalCreateOptions {
  cwd?: string | null
  cols?: number
  rows?: number
}

interface TerminalSession {
  id: string;
  process: TerminalSessionProcess;
  shell: string;
  cols: number;
  rows: number;
  /** 待 flush 的输出批量缓冲。 */
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalService {
  create(options?: TerminalCreateOptions): TerminalCreateResult;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** 显式关闭会话（不发退出提示，静默回收）。 */
  dispose(id: string): void;
  /** 进程退出/通道断开时的全量回收。 */
  disposeAll(): void;
}

/* ── shell 探测（纯函数） ─────────────────────────────────────────────── */

/** win32：pwsh.exe → powershell.exe（沿 PATH 扫描）→ %ComSpec% → cmd.exe。 */
export function detectWindowsShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const pathDirs = splitPathList(env.PATH, ";");
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    const found = findOnPath(pathDirs, name, exists);
    if (found) return found;
  }
  if (typeof env.ComSpec === "string" && env.ComSpec) return env.ComSpec;
  return "cmd.exe";
}

/** unix：$SHELL → /bin/zsh → /bin/bash → /bin/sh。 */
export function detectUnixShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  if (typeof env.SHELL === "string" && env.SHELL) return env.SHELL;
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (exists(candidate)) return candidate;
  }
  return "/bin/sh";
}

export function detectShellForPlatform(
  platformName: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string {
  return platformName === "win32" ? detectWindowsShell(env, exists) : detectUnixShell(env, exists);
}

function splitPathList(value: string | undefined, separator: string): string[] {
  if (typeof value !== "string" || !value) return [];
  return value.split(separator).filter((dir) => dir.trim().length > 0);
}

function findOnPath(pathDirs: string[], name: string, exists: (path: string) => boolean): string | null {
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/* ── 会话服务 ─────────────────────────────────────────────────────────── */

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const sessions = new Map<string, TerminalSession>();

  const flushSession = (session: TerminalSession): void => {
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (!session.pending) return;
    const data = session.pending;
    session.pending = "";
    deps.onOutput({ id: session.id, data });
  };

  const appendOutput = (session: TerminalSession, chunk: string): void => {
    session.pending += chunk;
    if (session.pending.length >= MAX_FLUSH_BYTES) {
      flushSession(session);
      return;
    }
    if (session.flushTimer !== null) return;
    session.flushTimer = setTimeout(() => flushSession(session), deps.flushDelayMs);
  };

  /** 进程退出/启动失败的收尾：仅在会话仍登记时发退出提示（显式 dispose 静默）。 */
  const closeSession = (session: TerminalSession, code: number | null, message?: string): void => {
    flushSession(session);
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    if (message) {
      deps.onOutput({ id: session.id, data: `\r\n[终端] ${message}\r\n` });
    } else {
      deps.onOutput({ id: session.id, data: `\r\n[终端] 进程已退出 (code=${code ?? "unknown"})\r\n` });
    }
  };

  return {
    create(options: TerminalCreateOptions = {}): TerminalCreateResult {
      const shell = detectShellForPlatform(deps.platform, deps.env, deps.exists);
      const cwd = typeof options.cwd === "string" && options.cwd && deps.exists(options.cwd)
        ? options.cwd
        : deps.homeDir;
      // 交互式 shell 需要继承完整用户环境；TERM/COLORTerm 让 ls 等输出 256 色 ANSI。
      const env: NodeJS.ProcessEnv = {
        ...deps.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      };
      const spawnOptions: SpawnOptions = {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      };
      const process = deps.spawnShell(shell, [], spawnOptions);
      const session: TerminalSession = {
        id: deps.generateId(),
        process,
        shell,
        cols: normalizeCols(options.cols),
        rows: normalizeRows(options.rows),
        pending: "",
        flushTimer: null,
      };
      sessions.set(session.id, session);

      process.stdout?.setEncoding("utf8");
      process.stdout?.on("data", (chunk: string) => {
        appendOutput(session, chunk);
      });
      process.stderr?.setEncoding("utf8");
      process.stderr?.on("data", (chunk: string) => {
        appendOutput(session, chunk);
      });
      process.once("close", (code) => {
        closeSession(session, code);
      });
      process.once("error", (error) => {
        closeSession(session, null, `无法启动 shell：${error.message}`);
      });
      return { id: session.id, shell };
    },

    write(id: string, data: string): void {
      const session = requireSession(sessions, id);
      if (!session.process.stdin) {
        throw Object.assign(new Error(`终端会话 ${id} 的 stdin 不可用`), { code: "terminal_session_unavailable" });
      }
      session.process.stdin.write(data);
    },

    resize(id: string, cols: number, rows: number): void {
      const session = requireSession(sessions, id);
      // 管道模式无 PTY 尺寸语义，仅记录；node-pty 升级后此处接 pty.resize。
      session.cols = normalizeCols(cols);
      session.rows = normalizeRows(rows);
    },

    dispose(id: string): void {
      const session = sessions.get(id);
      if (!session) return;
      // 先摘表再 kill：close 事件按 stale 守卫静默，不发退出提示。
      sessions.delete(id);
      flushSession(session);
      session.process.kill();
    },

    disposeAll(): void {
      for (const session of [...sessions.values()]) {
        this.dispose(session.id);
      }
    },
  };
}

/* ── 载荷规整 ─────────────────────────────────────────────────────────── */

/** 供真实装配（terminal-bridge）使用的默认依赖（真实进程环境）。 */
export function createDefaultTerminalServiceDeps(onOutput: (event: TerminalDataEvent) => void): TerminalServiceDeps {
  return {
    platform: platform(),
    env: process.env,
    exists: (path) => existsSync(path),
    homeDir: homedir(),
    spawnShell: (command, args, options) => spawn(command, [...args], options) as ChildProcess as TerminalSessionProcess,
    generateId: () => randomUUID(),
    flushDelayMs: DEFAULT_FLUSH_DELAY_MS,
    onOutput,
  };
}

function requireSession(sessions: Map<string, TerminalSession>, id: string): TerminalSession {
  const session = sessions.get(id);
  if (!session) {
    throw Object.assign(new Error(`终端会话不存在或已退出: ${id}`), { code: "terminal_session_not_found" });
  }
  return session;
}

function normalizeCols(cols: number | undefined): number {
  return typeof cols === "number" && Number.isFinite(cols) ? Math.min(Math.max(Math.trunc(cols), 2), 500) : DEFAULT_COLS;
}

function normalizeRows(rows: number | undefined): number {
  return typeof rows === "number" && Number.isFinite(rows) ? Math.min(Math.max(Math.trunc(rows), 2), 200) : DEFAULT_ROWS;
}
